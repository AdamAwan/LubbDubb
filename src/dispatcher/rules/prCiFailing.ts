import type { DispatchContext } from '../dispatcher.js';
import { ciNeedsAttention, inheritedCiFailure, isStackedPr, needsBaseUpdate } from '../../prHealth.js';
import type { Agent, Decision, PullRequest } from '../../types.js';
import { askedAlready } from '../admission.js';
import {
  ciFailureNote,
  ciNeedsHuman,
  ciWatchNote,
  classifyCiFailures,
  classifyWatchedChecks,
  type CiVerdict,
  type CiWatchVerdict,
} from '../../ci/ciPolicy.js';
import { mergeProposalRef, proposalHold } from '../../proposals/proposals.js';
import { dispatchVerdict } from '../dispatchCooldown.js';
import { DISPATCH_PIPELINE, type DispatchRuleId } from '../rules.js';
import {
  prCommentOrigin,
  prCommentsOrigin,
  reviewRecheckNote,
  reviewThreadNote,
  reviewThreadsNote,
} from '../reviewThreads.js';
import { isActive, type RawAction, type StageContext } from './context.js';

/**
 * React to PR signals first — they're time-sensitive. At most one code agent
 * works a given branch, so a fresh signal for a branch that already has a running
 * agent is delivered to it, never a second dispatch. Dispatch candidates are
 * collected here and ranked across PRs below — world order is arbitrary, so it
 * must not decide who wins scarce headroom.
 *
 * **One pass covering six rules**, registered in `STAGES` under `pr-ci-failing`,
 * which is why `pr-review-comment`, `pr-ci-blocked`, `pr-ci-gate`,
 * `pr-base-update` and `pr-merge-ready` have no stage of their own. They are not
 * independent: the four concern rules feed one per-PR list whose *top* entry
 * alone becomes a dispatch, because one agent works a branch. Their relative
 * urgency is their order in {@link DISPATCH_PIPELINE} — see
 * {@link concernUrgency}, which reads it rather than restating it.
 *
 * The registration is under `pr-ci-failing` rather than under whichever of the
 * six the pipeline currently puts first, and that is deliberate: they are
 * contiguous, so nothing else runs between them and the pass contributes its
 * candidates at the same point in the walk whichever id carries it. Chasing the
 * first id through this map on every reorder would be a second copy of the
 * ordering, which is the arrangement the rule numbers rotted under.
 */
export function prCiFailing(s: StageContext): void {
  const { ctx } = s;
  const prCandidates: Array<{ pr: PullRequest; top: PrConcern; urgent: boolean }> = [];
  for (const pr of ctx.world.pullRequests) {
    if (pr.merged) continue; // a merged PR is done — never act on it.

    // Every concern that would, on its own, warrant a code agent on this
    // branch, ordered by urgency: review comments > CI > base-update.
    const concerns: PrConcern[] = [];
    // Review feedback is **one** concern for the whole PR, never one per thread.
    // A review is written as a unit — the same person leaving three comments in
    // one pass, each assuming the others — so an agent handed a single thread in
    // isolation makes a fix for comment 1 that contradicts comment 3, or does
    // the same edit twice a cycle apart. One agent, one branch, every open
    // thread in front of it at once.
    //
    // De-dup stays per *thread* (`signals` below): dispatch is per branch, but
    // "has this agent been told about *this* comment" is per comment, or a
    // reviewer's fourth comment is swallowed by the origin its first three
    // already claimed.
    //
    // **First of the three, and that is the whole ordering decision.** A review
    // is the one PR signal that can invalidate the diff rather than describe
    // something wrong around it: a reviewer asking for a different approach
    // means the code the CI failure is about, and the hunks the merge conflict
    // is in, are both about to be rewritten. Fixing either first spends an agent
    // on work the next push discards — and, for the base merge, resolves the
    // same conflict twice, since the rewrite re-conflicts the branch. CI and the
    // base still get their agent; they get it on the diff the review settled on.
    const unhandled = pr.unresolvedComments.filter((c) => !c.handled);
    if (unhandled.length > 0) {
      const authors = [...new Set(unhandled.map((c) => c.author))];
      const many = unhandled.length > 1;
      concerns.push({
        rule: 'pr-review-comment',
        origin: prCommentsOrigin(pr.number),
        title: many
          ? `Address ${unhandled.length} review comments on PR #${pr.number}`
          : `Address review comment on PR #${pr.number}`,
        // Appended, never interpolated (see `reviewThreadsNote`). `author` and
        // `comment` stay filled so an override written against the old
        // one-comment prompt still renders something true — the full set
        // follows it either way, and the re-check after it: the list is a
        // reading taken now, and the review keeps moving while the agent works.
        prompt:
          s.templates.render('pr-review-comment', {
            number: pr.number,
            branch: pr.branch,
            author: authors.join(', '),
            comment: unhandled[0]!.body,
          }) +
          reviewThreadsNote(unhandled) +
          reviewRecheckNote(pr.number),
        dispatchReason: many
          ? `${unhandled.length} unhandled review comments from ${authors.join(', ')} on PR #${pr.number}.`
          : `Unhandled review comment from ${authors[0]} on PR #${pr.number}.`,
        // Only reached when this concern carries no fresh signals of its own,
        // which cannot happen — kept honest rather than unreachable-by-luck.
        note: `Unhandled review feedback on PR #${pr.number} from ${authors.join(', ')}.`,
        originTitle: pr.title,
        originSummary: many
          ? `${unhandled.length} review threads on PR #${pr.number} from ${authors.join(', ')}`
          : `Review comment from ${authors[0]}: ${unhandled[0]!.body}`,
        signals: unhandled.map((c) => ({
          ref: prCommentOrigin(pr.number, c.id),
          note: reviewThreadNote(pr.number, c),
        })),
      });
    }
    // A stacked PR's CI runs the commits of the PR underneath it, so a red base
    // turns every PR above it red. Dispatching on that would put an agent on each
    // of them to fix code that is not theirs — the failure multiplies up the
    // stack and none of those agents can do anything about it. Suppress the rule
    // here and leave it at that: the failing PR at the bottom is in this same
    // world and rule `pr-ci-failing` fires on it under its own steam, so there is no concern to
    // push down. Only the CI rule is suppressed — the base-update rule below still
    // fires, which is what keeps a stack restacking when its parent pushes.
    const inheritedFailure = inheritedCiFailure(pr, s.openPrs);
    // Which checks failed decides what happens, not merely that CI is red. An
    // unconfigured harness — and a provider that reports no per-check detail —
    // yields `actionable` with empty lists, i.e. exactly the behaviour above.
    const ciVerdict = classifyCiFailures(pr.ciChecks, s.ci);
    // The gate is `ciNeedsAttention`, not the aggregate: a check that fails
    // without blocking completion still wants a fix, and folding it into
    // `ciStatus` would have claimed the PR cannot merge when it can.
    const ciFailing = ciNeedsAttention(pr) && inheritedFailure === null;
    if (ciFailing && ciVerdict.actionable) {
      const ciOrigin = `pr:${pr.number}:ci`;
      concerns.push({
        rule: 'pr-ci-failing',
        origin: ciOrigin,
        title: `Fix failing CI on PR #${pr.number}`,
        // Appended, never interpolated: `pr-ci-fix` is operator-overridable and
        // an override written before this existed would silently drop every
        // word of the operator's own per-check guidance (see `ciFailureNote`).
        prompt:
          s.templates.render('pr-ci-fix', { number: pr.number, title: pr.title, branch: pr.branch }) +
          ciFailureNote(ciVerdict),
        dispatchReason: ciDispatchReason(pr.number, ciVerdict),
        note: `CI is now failing on PR #${pr.number} — investigate and push a fix.${ciFailureNote(ciVerdict)}`,
        originTitle: pr.title,
        originSummary: `PR #${pr.number} on branch ${pr.branch} · CI ${pr.ciStatus}${pr.approved ? ' · approved' : ''}`,
        urgent: ciVerdict.urgent,
        // The same names `ciDispatchReason` puts in the audit sentence, kept as
        // data so spend can be read per check without anything parsing prose.
        ciChecks: ciVerdict.dispatch.map((m) => m.name),
      });
    } else if (ciFailing && ciNeedsHuman(ciVerdict)) {
      // Nothing an agent can fix, and the operator asked to be told. Put it to
      // a human once — see `askedAlready` for why that takes two readings.
      const ciOrigin = `pr:${pr.number}:ci`;
      if (!askedAlready(ciOrigin, ctx.openEscalations, ctx.recentDecisions)) {
        const names = ciVerdict.escalate.map((m) => m.name).join(', ');
        s.raw.push({
          type: 'escalate_to_human',
          escalationType: 'resolve_ambiguity',
          prompt:
            `CI is failing on PR #${pr.number} ("${pr.title}") only on checks you told the harness not to act ` +
            `on, so nothing has been dispatched — this needs someone who can reach whoever owns them.`,
          // The check names are a list of unbounded length, so they go in the body
          // rather than mid-sentence: one escalating check reads fine inline and
          // nine turn the lede into the wall this split exists to prevent.
          context: {
            originRef: ciOrigin,
            prNumber: pr.number,
            taskTitle: pr.title,
            detail: ciVerdict.escalate.map((m) => `- \`${m.name}\``).join('\n'),
            detailFrom: 'Failing, and configured to be left alone',
          },
          rule: 'pr-ci-blocked',
          reason: `PR #${pr.number} is red only on checks configured to escalate (${names}).`,
        } satisfies RawAction);
      }
    }
    // A check the operator asked to watch in a state that is not failing: the
    // blocking gate sitting `queued` until somebody runs the thing that releases
    // it. Nothing else in the harness looks at a pending check, which is why the
    // PR would otherwise wait forever reading "CI still running".
    //
    // Behind the same inherited-failure guard as the CI concern, and no further.
    // A rung whose real problem is the red base below it must not also collect an
    // agent for its gate — that is the multiplication `inheritedCiFailure` exists
    // to stop. But a status policy is evaluated per pull request, so each rung of
    // an otherwise-healthy stack genuinely has its own gate to clear, and
    // suppressing those would leave the whole stack stuck on the bottom one.
    const gateVerdict = classifyWatchedChecks(pr.ciChecks, s.ci);
    if (gateVerdict.watched.length > 0 && inheritedFailure === null) {
      const waiting = gateVerdict.watched.map((m) => m.name).join(', ');
      concerns.push({
        rule: 'pr-ci-gate',
        // **Its own origin, not `pr:<n>:ci`.** Sharing would put one cooldown
        // budget across two unrelated problems: a red build spending its attempts
        // would leave the gate permanently capped without a single agent ever
        // having been sent at it, and the escalation raised at the cap would name
        // whichever of the two the concern fold happened to pick. It also keeps
        // notify de-dup honest — a gate signal reaching an agent already on the
        // branch is not the CI signal that origin already delivered.
        origin: `pr:${pr.number}:ci-gate`,
        title: `Clear the waiting check on PR #${pr.number}`,
        // Appended, never interpolated — `pr-ci-gate` is operator-overridable and
        // the check names are the half an agent cannot act without.
        prompt:
          s.templates.render('pr-ci-gate', { number: pr.number, title: pr.title, branch: pr.branch }) +
          ciWatchNote(gateVerdict),
        dispatchReason: gateDispatchReason(pr.number, gateVerdict),
        note: `A check on PR #${pr.number} is waiting on an action — ${waiting}.${ciWatchNote(gateVerdict)}`,
        originTitle: pr.title,
        originSummary: `PR #${pr.number} on branch ${pr.branch} · waiting on ${waiting}`,
        urgent: gateVerdict.urgent,
        ciChecks: gateVerdict.watched.map((m) => m.name),
      });
    }
    if (needsBaseUpdate(pr)) {
      const base = pr.baseBranch ?? s.defaultBranch;
      const behind = pr.mergeableState === 'behind';
      const mergeableOrigin = `pr:${pr.number}:mergeable`;
      // The `behind` arm is two git commands against a merge the provider has
      // *already asserted is clean*, so it is taken directly instead of costing a
      // worktree, a model and a cold read of the repository (issue #332). The
      // conflicted arm keeps its agent: resolving a conflict is judgement, and
      // `pr-base-update-conflict` already tells the agent to escalate when it
      // cannot.
      //
      // Unless the last direct attempt came back unperformed — a provider with no
      // such endpoint (Azure DevOps has none), or a write the repository refused.
      // Then this is the dispatch it always was, with the same routine-update
      // prompt, so a PR is never left behind its base merely because the cheap
      // path was unavailable.
      const direct = behind && !directUpdateUnperformed(mergeableOrigin, ctx.recentDecisions);
      concerns.push({
        rule: 'pr-base-update',
        origin: mergeableOrigin,
        act: direct
          ? ({
              type: 'update_pr_branch',
              prNumber: pr.number,
              base,
              branch: pr.branch,
              originRef: mergeableOrigin,
              rule: 'pr-base-update',
              reason: `PR #${pr.number} is behind ${base} with no conflicts; merging ${base} in through the provider rather than spending an agent on it.`,
            } satisfies RawAction)
          : undefined,
        title: behind ? `Update PR #${pr.number} with ${base}` : `Resolve merge conflicts on PR #${pr.number}`,
        prompt: s.templates.render(behind ? 'pr-base-update-behind' : 'pr-base-update-conflict', {
          number: pr.number,
          title: pr.title,
          branch: pr.branch,
          base,
        }),
        dispatchReason: behind
          ? `PR #${pr.number} is behind ${base}, the base could not be merged in directly, and no agent is on it.`
          : `PR #${pr.number} has merge conflicts with ${base} and no agent is on it.`,
        note: behind
          ? `PR #${pr.number} is now behind ${base} — merge ${base} in to bring it up to date, then push.`
          : `The base branch ${base} now conflicts with PR #${pr.number} — merge ${base} in, resolve the conflicts, and push.`,
        originTitle: pr.title,
        originSummary: `PR #${pr.number} on branch ${pr.branch} · ${behind ? `behind ${base}` : `conflicts with ${base}`}`,
      });
    }

    if (concerns.length > 0) {
      const branch = resolveBranchAgent(ctx, pr.branch);
      if (branch.kind === 'running') {
        // A running agent already owns this branch — notify it, don't duplicate.
        // Collapse every fresh, not-yet-delivered signal into one note.
        //
        // De-dup is per *signal*, not per concern: the comment concern covers
        // every open thread under one dispatch origin, so keying on the origin
        // alone would let the first three comments swallow the fourth — the
        // exact signal an operator reviewing an agent's work is sending. Three
        // things have already delivered a signal: an active task on it (a CI or
        // base concern *is* its own origin), the dispatch that launched this
        // agent (its prompt lists those threads; repeating them is noise), and
        // a note already sent.
        const fresh = concerns.flatMap((c) =>
          signalsOf(c).filter(
            (sig) =>
              !s.activeOrigins.has(sig.ref) &&
              !s.dispatchedSignals.has(`${pr.branch}::${sig.ref}`) &&
              !s.notified.has(`${branch.agent.id}::${sig.ref}`),
          ),
        );
        if (fresh.length > 0) {
          s.raw.push({
            type: 'respond_to_agent',
            agentId: branch.agent.id,
            response:
              `An update on the branch you're working (PR #${pr.number}):\n` +
              fresh.map((sig) => `- ${sig.note}`).join('\n') +
              (fresh.length > 1
                ? '\n\nRead them together before changing anything — they may resolve or contradict one another.'
                : ''),
            originRefs: fresh.map((sig) => sig.ref),
            // **The one action with no proposing rule, and it is left null
            // deliberately.** `fresh` is a flatMap over *every* concern on this
            // PR, so one note can carry a CI signal and a review thread at once
            // — there is no single rule that proposed it. The tempting
            // attribution is `concerns[0]`, and it would be wrong twice over:
            // that entry is picked by the urgency order, which exists to decide
            // who gets the one agent when the branch is *free*, and reusing it
            // here would name a proposer for a note whose other half it never
            // asked for. Nothing is lost by refusing to guess — `originRefs`
            // already lists every concern the note covers, which is a finer
            // answer than any one rule id could give.
            rule: null,
            admission: 'branch-notify',
            reason: `New PR signal(s) for a branch already staffed by agent ${branch.agent.id}.`,
          } satisfies RawAction);
        }
      } else if (branch.kind === 'free') {
        // No agent on this branch — a dispatch candidate for the most urgent
        // concern; ranked cross-PR (and throttled) after the loop.
        //
        // `urgent` is read off **every** concern on the PR, not off `top`. The
        // flag is the operator saying "a red security scan jumps the queue", and
        // it is set by a CI check — which is no longer the top concern when the
        // PR also has an open review. Reading it from `top` would have made the
        // operator's escalation quietly conditional on nobody having commented,
        // which is not a rule anyone wrote down. Which concern the agent is sent
        // for is still `top`; this only decides where the PR sits in the queue.
        prCandidates.push({ pr, top: concerns[0]!, urgent: concerns.some((c) => c.urgent === true) });
      }
      // branch.kind === 'busy' (queued / starting / parked waiting): hold every
      // note. Injecting into a waiting agent would un-park a human escalation,
      // and a starting agent has no live session yet. The signals persist, so a
      // later cycle delivers them once the agent is running.
    }

    // 3: Drive a settled PR the last mile — merge it in. `merge_pr` isn't an
    // agent dispatch (it claims no headroom); the executor's auto-send gate
    // decides whether to merge autonomously or escalate for approval. A
    // 'behind'/'blocked'/'dirty' state is handled above, so it never counts as
    // merge-ready here.
    //
    // A stacked PR is held: merging it would land part 2 *into part 1's branch*
    // mid-flight rather than into the integration branch. It becomes mergeable on
    // its own the moment the provider retargets it, which is when its parent
    // merges — no separate release step (see `isStackedPr`).
    const mergeReady =
      !isStackedPr(pr, s.defaultBranch) &&
      pr.ciStatus === 'passing' &&
      pr.approved === true &&
      pr.mergeable === true &&
      pr.mergeableState !== 'behind' &&
      pr.mergeableState !== 'blocked' &&
      pr.mergeableState !== 'dirty' &&
      pr.unresolvedComments.every((c) => c.handled);
    // A merge already put to a human is not put to them again: while the
    // verdict on `pr:<n>:merge` stands — unanswered, or a "no" — this rule is
    // held off that PR. Without it every pulse re-proposes the same merge and
    // "Needs you" fills with copies of one question, which is what made the
    // approval inert to begin with (issue #109). The pending item in the inbox
    // is the visible state; there is no action to audit because none was taken.
    //
    // A "no" stops standing once something has happened to the PR since it was
    // given (phase 4) — the rule then fires again, and its own preconditions
    // above still decide whether the merge is proposed at all.
    const mergeHeld = proposalHold('merge', mergeProposalRef(pr.number), ctx.proposals ?? [], {
      rejectionSignals: ctx.rejectionSignals,
    });
    if (mergeReady && !mergeHeld) {
      s.raw.push({
        type: 'merge_pr',
        prNumber: pr.number,
        method: 'squash',
        confidence: 0.9,
        rule: 'pr-merge-ready',
        reason: `PR #${pr.number} is green, approved and mergeable; merge it in.`,
      } satisfies RawAction);
    }
  }

  // Cross-PR ranking: an operator-flagged urgent check first, then the most
  // urgent concern class (review comment > CI > base-update), tie-break by PR
  // number for determinism.
  prCandidates.sort(
    (a, b) =>
      Number(b.urgent) - Number(a.urgent) ||
      concernUrgency(a.top.rule) - concernUrgency(b.top.rule) ||
      a.pr.number - b.pr.number,
  );
  for (const { pr, top } of prCandidates) {
    const escalate = (attempts: number): RawAction => ({
      type: 'escalate_to_human',
      escalationType: 'resolve_ambiguity',
      prompt: s.templates.render('pr-concern-escalation', {
        title: top.title,
        number: pr.number,
        attempts,
      }),
      context: { originRef: top.origin, prNumber: pr.number, taskTitle: top.title },
      // The concern that was throttled, then what throttling did to it. This
      // escalation stands in for exactly one proposal — `top`, the concern the
      // dispatch would have gone out for — so it has a proposer, unlike the
      // branch note above.
      rule: top.rule,
      admission: 'cooldown-escalate',
      reason: `Origin ${top.origin} hit the ${s.cooldown.maxAttempts}-attempt cap without clearing — escalating instead of looping.`,
    });
    // A concern with an act of its own is settled here rather than staffed: no
    // candidate, no headroom claimed, and no Up next row for something that
    // completes in one request. It is still **throttled on its origin**, and by
    // the same verdict a dispatch would take — an act that runs and leaves the
    // concern standing is the loop the cooldown exists for, whoever performed it.
    if (top.act) {
      const verdict = dispatchVerdict(top.origin, s.now, ctx.recentDecisions, s.cooldown);
      if (verdict.kind === 'escalate') s.raw.push(escalate(verdict.attempts));
      else if (verdict.kind === 'dispatch') s.raw.push(top.act);
      // 'cooldown' — attempted too recently, and there is nothing to queue: the
      // act claims no slot, so a held row would say the fleet is busy when it is
      // not. 'hold' — already escalated; leave the origin alone.
      continue;
    }
    s.consider(
      {
        origin: top.origin,
        rule: top.rule,
        title: top.title,
        kind: 'code',
        branch: pr.branch,
        reason: top.dispatchReason,
        action: {
          type: 'dispatch_code_agent',
          branch: pr.branch,
          title: top.title,
          prompt: top.prompt,
          originRef: top.origin,
          originTitle: top.originTitle,
          originSummary: top.originSummary,
          // What this agent is being launched to answer. Recorded so the next
          // pulse doesn't read the same review threads back to it as news —
          // the dispatch origin alone can't say, since it names the branch's
          // whole review rather than any one thread.
          signalRefs: signalsOf(top).map((sig) => sig.ref),
          ciChecks: top.ciChecks,
          rule: top.rule,
          reason: top.dispatchReason,
        } satisfies RawAction,
      },
      escalate,
    );
  }
}

/**
 * Did the last direct base update on this origin fail to happen?
 *
 * The memory behind the fallback, read from the audit log alone — the same place
 * the cooldown reads its attempts, so the two cannot hold different opinions
 * about what has been tried. Both unperformed outcomes count and mean one thing
 * to the rule: `skipped` is a provider with no update-branch endpoint at all,
 * `rejected` is one that has it and refused, and either way the branch still
 * needs merging and only an agent is left to do it.
 *
 * Best-effort over the recent-decision window, and harmless as it ages out: the
 * cheap path is simply tried once more, which is the right answer for a refusal
 * that was transient and one wasted request for a provider that never had it.
 */
function directUpdateUnperformed(origin: string, decisions: Decision[]): boolean {
  return decisions.some(
    (d) =>
      d.action.type === 'update_pr_branch' &&
      d.action.originRef === origin &&
      (d.outcome === 'skipped' || d.outcome === 'rejected'),
  );
}

/** One thing wrong with a PR that would warrant a code agent on its branch. */
interface PrConcern {
  /** Which dispatcher rule raised this concern, carried onto the emitted action. */
  rule: DispatchRuleId;
  origin: string;
  /**
   * The act that settles this concern **without an agent**, when one can (issue
   * #332) — today only the base update of a pull request the provider reported as
   * merely `behind`. Set, and this concern's turn on a free branch emits the act
   * instead of a dispatch; absent, everything below is what happens, unchanged.
   *
   * It rides on the concern rather than replacing it, because the concern is more
   * than a dispatch: a branch that already has a running agent is *told* about the
   * base moving (`note`) rather than having it merged under its feet, and a branch
   * that is busy holds the signal for later. Both of those are as true of the
   * cheap path as of the expensive one — the saving is in not staffing a free
   * branch, not in acting where the harness would not have.
   */
  act?: RawAction;
  title: string;
  prompt: string;
  dispatchReason: string;
  note: string;
  // Human-readable context about the originating item, carried onto the task so
  // the cockpit can explain a running agent at a glance (issue #17).
  originTitle: string;
  originSummary: string;
  /**
   * Sort this PR ahead of every other PR concern. Set only by a CI check rule
   * carrying `urgent` — the operator saying a red security scan outranks a
   * behind-base branch elsewhere. Never re-orders past a held verdict or the
   * headroom cut; it decides position in the queue and nothing else.
   *
   * Read across the PR's whole concern list rather than off the one that won,
   * because the concern that carries it is no longer the one that wins.
   */
  urgent?: boolean;
  /**
   * The individual world signals this concern folds, for notify de-dup. Defaults
   * to the concern itself ({@link signalsOf}), which is right for CI and
   * base-update: one origin, one signal.
   *
   * The review-comment concern is the one that differs, and it has to. It
   * deliberately collapses every open thread onto **one** dispatch origin so a
   * single agent answers a whole review — but "has this agent been told about
   * this comment" is still a per-thread question, and answering it per origin
   * would mean a reviewer's later comments never reached the agent already on the
   * branch. Dispatch at branch granularity, de-dup at thread granularity.
   */
  signals?: PrSignal[];
  /**
   * The CI checks this concern is about, carried onto the dispatch and from there
   * onto the task. Set by the two CI rules; every other concern leaves it unset,
   * which is what "this run was not about a named check" means downstream.
   */
  ciChecks?: string[];
}

/** One world signal inside a {@link PrConcern}: what it is about, and how it reads. */
interface PrSignal {
  /** The world ref this signal names — the notify de-dup key. */
  ref: string;
  /** The line delivered to a running agent on the branch when this signal is fresh. */
  note: string;
}

/**
 * The signals a concern folds. A concern that names none is its own single
 * signal, so every rule but the review-comment one is unchanged by the split.
 */
function signalsOf(concern: PrConcern): PrSignal[] {
  return concern.signals ?? [{ ref: concern.origin, note: concern.note }];
}

/**
 * Name the failing checks in the audit line when the provider reported them, so
 * the decision log says *why* an agent went out rather than only that CI was red.
 */
function ciDispatchReason(prNumber: number, verdict: CiVerdict): string {
  const names = verdict.dispatch.map((m) => m.name);
  if (names.length === 0) return `PR #${prNumber} has failing CI and no agent is on it.`;
  return `PR #${prNumber} has failing CI (${names.join(', ')}) and no agent is on it.`;
}

/**
 * Name the waiting checks in the audit line, so the decision log distinguishes
 * this from the red-build dispatch it sits next to — the two are one word apart
 * in the cockpit and a month later only the check name says which happened.
 */
function gateDispatchReason(prNumber: number, verdict: CiWatchVerdict): string {
  const names = verdict.watched.map((m) => m.name).join(', ');
  return `PR #${prNumber} has a check waiting on an action (${names}) and no agent is on it.`;
}

/**
 * Cross-PR rank of a concern class: review comment beats CI beats base-update.
 *
 * Read off the pipeline rather than restated here. It used to be three hardcoded
 * numbers that happened to agree with the order the concerns are pushed in and
 * with the registry's own numbering — three copies of one fact, which is the
 * arrangement the rule numbers rotted under. A rule with no pipeline position
 * sorts last rather than throwing: this only orders concerns, and a wrong order
 * is a worse failure than a late one.
 */
function concernUrgency(rule: DispatchRuleId): number {
  const at = DISPATCH_PIPELINE.findIndex((r) => r.id === rule);
  return at === -1 ? Number.MAX_SAFE_INTEGER : at;
}

/** The agent state of a PR's branch: a running agent to notify, busy (hold), or free (dispatch). */
type BranchAgent = { kind: 'running'; agent: Agent } | { kind: 'busy' } | { kind: 'free' };

function resolveBranchAgent(ctx: DispatchContext, branch: string): BranchAgent {
  const task = ctx.tasks.find((t) => isActive(t) && t.branch === branch);
  if (!task) return { kind: 'free' };
  const agent = task.agentId ? ctx.agents.find((a) => a.id === task.agentId) : undefined;
  if (agent && agent.status === 'running') return { kind: 'running', agent };
  return { kind: 'busy' }; // queued / starting / waiting — hold new notes.
}
