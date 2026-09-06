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
import { concernUrgency, type DispatchRuleId } from '../rules.js';
import {
  prCommentSignalRef,
  prCommentsOrigin,
  reviewRecheckNote,
  reviewThreadNote,
  reviewThreadsNote,
  replyToolNote,
} from '../reviewThreads.js';
import { priorCiRemediesNote, priorReviewRemediesNote } from '../../remedies/priorRemedies.js';
import { remedyAskNote } from '../../remedies/remedies.js';
import {
  charterNote,
  modeCharterHeading,
  needsFleetReview,
  publishNote,
  resolvedReviewMode,
  reviewBranch,
  reviewOrigin,
  reviewSatisfied,
  reviewTriageOrigin,
  reviewReading,
  triageRuns,
} from '../../review/prReview.js';
import { readOnlyDispatch } from './readOnlyDispatch.js';
import { isActive, type RawAction, type StageContext } from './context.js';

/**
 * React to PR signals. At most one code agent works a given branch, so a fresh
 * signal for a branch that already has a running agent is delivered to it, never
 * a second dispatch. Candidates are ranked across PRs below — world order is
 * arbitrary and must not decide who wins scarce headroom.
 *
 * One pass covering eight rules, registered under `pr-ci-failing`: the concern
 * rules feed one per-PR list whose *top* entry alone becomes a dispatch, ordered
 * via {@link concernUrgency} (which `prAttention`'s lens also reads, so the two
 * cannot disagree). → `docs/spec/05-dispatcher.md#the-rule-book`
 */
export function prCiFailing(s: StageContext): void {
  const { ctx } = s;
  const prCandidates: Array<{ pr: PullRequest; top: PrConcern; urgent: boolean }> = [];
  for (const pr of ctx.world.pullRequests) {
    if (pr.merged) continue; // a merged PR is done — never act on it.
    // A stale reading describes an agent's own just-finished work as still to do,
    // dispatching a second agent for it. Skipped whole, not per concern.
    // → {@link StageContext.readingBehindFleet}
    if (s.readingBehindFleet(pr.number)) continue;

    // Every concern that would, on its own, warrant a code agent on this
    // branch, ordered by urgency: review comments > CI > base-update.
    const concerns: PrConcern[] = [];
    // One concern for the whole PR, never per thread — a review is written as a
    // unit. De-dup stays per *thread* (`signals` below). Leads the ordering
    // because a review can invalidate the diff, unlike CI or base-update fixes.
    const unhandled = pr.unresolvedComments.filter((c) => !c.handled);
    // The fleet's own read of the diff, first because its value decays fastest.
    // `needsFleetReview` is the whole gate. One reading per PR, shared with the
    // merge gate below so the two cannot differ.
    const reading = reviewReading(s, pr.number);
    const route = reading.route;
    // Resolved here, not in the prompt: the mode decides the profile, priced first.
    const mode = resolvedReviewMode(route, s.review);
    // A routing still to come is a review still to come — dispatching now could
    // spend the deep profile on work triage was about to route cheaply. A wait,
    // not a hold: `pr-review-triage` fails open.
    const routing = route === null && triageRuns(s.review) && !triageSpent(s, pr.number);
    // Is the fleet's own review still coming, including one dispatched and not
    // yet reported? Makes review *lead* rather than merely sort above the other
    // concerns. Finite by the review's own attempt ledger, or a review nobody
    // can complete is a PR nothing may ever fix, with nothing red.
    const reviewComing = needsFleetReview(pr, reading, s.review) && !reviewSpent(s, pr.number);
    if (reviewComing && !routing) {
      const origin = reviewOrigin(pr.number);
      const branch = reviewBranch(pr.number);
      concerns.push({
        rule: 'pr-review',
        origin,
        // Read-only checkout, so the reviewer neither holds the lease a CI fix
        // needs nor can commit what it found.
        dispatch: readOnlyDispatch(branch, pr.branch),
        // The mode's profile, only where the project named one; an operator pin
        // on this origin still wins (`pinFor`).
        profile: (mode === null ? null : (s.review.modes[mode]?.profile ?? null)) ?? undefined,
        title: mode === null ? `Review PR #${pr.number}` : `Review PR #${pr.number} (${mode})`,
        // Appended, never interpolated — an override that never learned the
        // charter would silently drop it.
        prompt:
          s.templates.render('pr-review', {
            number: pr.number,
            title: pr.title,
            branch: pr.branch,
            base: pr.baseBranch ?? s.defaultBranch,
          }) +
          publishNote(s.review.publish) +
          charterNote(mode === null ? null : (s.reviewCharters.modes[mode] ?? null), modeCharterHeading(mode)),
        dispatchReason:
          `PR #${pr.number} has not been reviewed by the fleet and no agent is on it` +
          (mode === null ? '.' : ` (${mode}${route === null ? ', by default' : ''}).`),
        note: `PR #${pr.number} has not been reviewed yet — read the diff and report what you find.`,
        originTitle: pr.title,
        originSummary: `PR #${pr.number} on branch ${pr.branch} · awaiting the fleet's review`,
      });
    }
    if (unhandled.length > 0) {
      const authors = [...new Set(unhandled.map((c) => c.author))];
      const many = unhandled.length > 1;
      concerns.push({
        rule: 'pr-review-comment',
        origin: prCommentsOrigin(pr.number),
        title: many
          ? `Address ${unhandled.length} review comments on PR #${pr.number}`
          : `Address review comment on PR #${pr.number}`,
        // Appended, never interpolated (see `reviewThreadsNote`); `author`/`comment`
        // stay filled so an old one-comment override still renders true.
        prompt:
          s.templates.render('pr-review-comment', {
            number: pr.number,
            branch: pr.branch,
            author: authors.join(', '),
            comment: unhandled[0]!.body,
          }) +
          reviewThreadsNote(unhandled) +
          reviewRecheckNote(pr.number) +
          // After threads/re-check (what to do with an answer), before remedies
          // (about the repository, not this review).
          replyToolNote() +
          priorReviewRemediesNote(ctx.priorRemedies ?? []) +
          remedyAskNote('review'),
        dispatchReason: many
          ? `${unhandled.length} unhandled review comments from ${authors.join(', ')} on PR #${pr.number}.`
          : `Unhandled review comment from ${authors[0]} on PR #${pr.number}.`,
        // Never reached — this concern always carries fresh signals of its own —
        // kept honest rather than unreachable-by-luck.
        note: `Unhandled review feedback on PR #${pr.number} from ${authors.join(', ')}.`,
        originTitle: pr.title,
        originSummary: many
          ? `${unhandled.length} review threads on PR #${pr.number} from ${authors.join(', ')}`
          : `Review comment from ${authors[0]}: ${unhandled[0]!.body}`,
        // Keyed on `prCommentSignalRef`, which moves on a reply — a plain thread
        // ref would swallow a follow-up as already delivered.
        signals: unhandled.map((c) => ({
          ref: prCommentSignalRef(pr.number, c),
          note: reviewThreadNote(pr.number, c),
        })),
      });
    }
    // A red base turns every PR above it red, so only the CI rule is suppressed
    // here — the failing PR at the bottom fires on its own, and base-update below
    // still fires, keeping a stack restacking when its parent pushes.
    const inheritedFailure = inheritedCiFailure(pr, s.openPrs);
    // Which checks failed decides what happens, not merely that CI is red.
    const ciVerdict = classifyCiFailures(pr.ciChecks, s.ci, pr.ciChecksWithheld);
    // `ciNeedsAttention`, not the aggregate: a non-blocking failing check still
    // wants a fix.
    const ciFailing = ciNeedsAttention(pr) && inheritedFailure === null;
    if (ciFailing && ciVerdict.actionable) {
      const ciOrigin = `pr:${pr.number}:ci`;
      concerns.push({
        rule: 'pr-ci-failing',
        origin: ciOrigin,
        title: `Fix failing CI on PR #${pr.number}`,
        // Appended, never interpolated — an override would silently drop the
        // operator's per-check guidance (see `ciFailureNote`).
        prompt:
          s.templates.render('pr-ci-fix', { number: pr.number, title: pr.title, branch: pr.branch }) +
          ciFailureNote(ciVerdict) +
          // Scoped to checks red now, after the failure note (what's failing before
          // what has failed before). Evidence is appended later by the executor.
          priorCiRemediesNote(
            ctx.priorRemedies ?? [],
            ciVerdict.dispatch.map((m) => m.name),
          ) +
          remedyAskNote('ci'),
        dispatchReason: ciDispatchReason(pr.number, ciVerdict),
        note: `CI is now failing on PR #${pr.number} — investigate and push a fix.${ciFailureNote(ciVerdict)}`,
        originTitle: pr.title,
        originSummary: `PR #${pr.number} on branch ${pr.branch} · CI ${pr.ciStatus}${pr.approved ? ' · approved' : ''}`,
        urgent: ciVerdict.urgent,
        // Same names as `ciDispatchReason`'s sentence, as data — spend reads per
        // check without parsing prose.
        ciChecks: ciVerdict.dispatch.map((m) => m.name),
      });
    } else if (ciFailing && ciNeedsHuman(ciVerdict)) {
      // Nothing an agent can fix, and the operator asked to be told — once.
      // See `askedAlready` for why that takes two readings.
      const ciOrigin = `pr:${pr.number}:ci`;
      if (!askedAlready(ciOrigin, ctx.openEscalations, ctx.recentDecisions)) {
        const names = ciVerdict.escalate.map((m) => m.name).join(', ');
        s.raw.push({
          type: 'escalate_to_human',
          escalationType: 'resolve_ambiguity',
          prompt:
            `CI is failing on PR #${pr.number} ("${pr.title}") only on checks you told the harness not to act ` +
            `on, so nothing has been dispatched — this needs someone who can reach whoever owns them.`,
          // Unbounded list, so it goes in the body rather than mid-sentence.
          context: {
            originRef: ciOrigin,
            prNumber: pr.number,
            taskTitle: pr.title,
            detail: ciVerdict.escalate.map((m) => `- \`${m.name}\``).join('\n'), // unbounded list, so the body not the sentence
            detailFrom: 'Failing, and configured to be left alone',
          },
          rule: 'pr-ci-blocked',
          reason: `PR #${pr.number} is red only on checks configured to escalate (${names}).`,
        } satisfies RawAction);
      }
    }
    // A watched check in a non-failing state — a blocking gate sitting `queued`
    // until somebody releases it, or the PR waits forever reading "CI still
    // running". Behind the same inherited-failure guard as the CI concern.
    const gateVerdict = classifyWatchedChecks(pr.ciChecks, s.ci);
    if (gateVerdict.watched.length > 0 && inheritedFailure === null) {
      const waiting = gateVerdict.watched.map((m) => m.name).join(', ');
      const gateOrigin = `pr:${pr.number}:ci-gate`;
      // The expired arm is taken directly (no judgement, just a write); the guided
      // arm keeps its agent. All-or-nothing across the gate's checks. An
      // unperformed last attempt falls back to dispatch.
      const requeues = gateRequeues(gateVerdict);
      const direct = requeues !== null && !directActUnperformed('requeue_ci_check', gateOrigin, ctx.recentDecisions);
      concerns.push({
        rule: 'pr-ci-gate',
        act:
          direct && requeues
            ? ({
                type: 'requeue_ci_check',
                prNumber: pr.number,
                checks: requeues,
                originRef: gateOrigin,
                rule: 'pr-ci-gate',
                reason: `The build policy on PR #${pr.number} is expired (${waiting}); queueing a run through the provider rather than spending an agent on it.`,
              } satisfies RawAction)
            : undefined,
        // Own origin, not `pr:<n>:ci`: sharing would cap the gate on an unrelated
        // problem's cooldown and confuse notify de-dup.
        origin: gateOrigin,
        title: `Clear the waiting check on PR #${pr.number}`,
        // Appended, never interpolated — the check names are the half an agent
        // cannot act without.
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
      // `behind` is a merge already asserted clean, taken directly rather than
      // costing a worktree and a model. The conflicted arm keeps its agent —
      // resolving a conflict is judgement. An unperformed last attempt falls back.
      const direct = behind && !directActUnperformed('update_pr_branch', mergeableOrigin, ctx.recentDecisions);
      concerns.push({
        // The rule id splits where cost does (`agentModels.byRule` keys on it);
        // the origin deliberately doesn't — same PR, one cooldown budget.
        rule: behind ? 'pr-base-update' : 'pr-base-update-conflict',
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
      // Who holds the PR's **own** branch — not the branch the winning dispatch
      // below checks out.
      const branch = resolveBranchAgent(ctx, pr.branch);
      if (branch.kind === 'running') {
        // A running agent already owns this branch — notify it, don't duplicate.
        // De-dup is per *signal*, not per concern, or the first three comments
        // would swallow the fourth under one origin.
        //
        // A concern that takes its own checkout is never a note: rule `pr-review`
        // delivered here would ask the diff's own author to review it, on an
        // origin its `review_report` can't land on.
        const fresh = concerns
          .filter((c) => !c.dispatch?.readOnly)
          .flatMap((c) =>
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
            // Null deliberately: `fresh` folds every concern on this PR, so no
            // single rule proposed it. `originRefs` lists what the note covers.
            rule: null,
            admission: 'branch-notify',
            reason: `New PR signal(s) for a branch already staffed by agent ${branch.agent.id}.`,
          } satisfies RawAction);
        }
      }
      // branch.kind === 'busy' (queued / starting / parked waiting): hold every note.
      // Injecting into a waiting agent would un-park a human escalation, and a
      // starting one has no session yet. The signals persist for a later cycle.

      const top = concerns[0]!;
      // The lease the winning concern needs, not always the PR's own branch:
      // `pr-review` takes a read-only checkout.
      const lease = resolveBranchAgent(ctx, top.dispatch?.branch ?? pr.branch);
      // Nothing else is worked while the fleet's own review is still coming —
      // this PR contributes no candidate until the review is done or given up
      // on. Notes above are unaffected.
      if (lease.kind === 'free' && (!reviewComing || top.rule === 'pr-review')) {
        // `urgent` is read off **every** concern, not `top`: it's set by a CI
        // check, which isn't the top concern when a review is open.
        prCandidates.push({ pr, top, urgent: concerns.some((c) => c.urgent === true) });
      }
    }

    // Propose merging a settled PR in. `merge_pr` claims no headroom and is
    // never performed on the harness's own authority — the executor writes it
    // as a proposal. A stacked PR is held: merging would land into its parent's
    // branch mid-flight.
    const mergeReady =
      !isStackedPr(pr, s.defaultBranch) &&
      pr.ciStatus === 'passing' &&
      pr.approved === true &&
      pr.mergeable === true &&
      pr.mergeableState !== 'behind' &&
      pr.mergeableState !== 'blocked' &&
      pr.mergeableState !== 'dirty' &&
      pr.unresolvedComments.every((c) => c.handled) &&
      // Nothing merges that nobody read — whether it *happened*, not liked what
      // it saw. See `reviewSatisfied`.
      reviewSatisfied(pr, reading, s.review);
    // A merge already put to a human is not put again while the verdict stands,
    // or every pulse re-proposes it. A "no" stops standing once something has
    // happened to the PR since it was given.
    const mergeHeld = proposalHold('merge', mergeProposalRef(pr.number), ctx.proposals ?? [], {
      rejectionSignals: ctx.rejectionSignals,
    });
    if (mergeReady && !mergeHeld) {
      s.raw.push({
        type: 'merge_pr',
        prNumber: pr.number,
        method: 'squash',
        rule: 'pr-merge-ready',
        reason: `PR #${pr.number} is green, approved and mergeable; merge it in.`,
      } satisfies RawAction);
    }
  }

  // Cross-PR ranking: operator-flagged urgent first, then concern urgency,
  // tie-broken by PR number for determinism.
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
      // Stands in for exactly one proposal — `top` — unlike the branch note above.
      rule: top.rule,
      admission: 'cooldown-escalate',
      reason: `Origin ${top.origin} hit the ${s.cooldown.maxAttempts}-attempt cap without clearing — escalating instead of looping.`,
    });
    // A concern with an act of its own is settled here, not staffed: no
    // candidate, no headroom, no Up next row. Still throttled on its origin.
    if (top.act) {
      const verdict = dispatchVerdict(top.origin, s.now, ctx.recentDecisions, s.cooldown);
      if (verdict.kind === 'escalate') s.raw.push(escalate(verdict.attempts));
      else if (verdict.kind === 'dispatch') s.raw.push(top.act);
      // 'cooldown' — nothing to queue: the act claims no slot, so a held row would
      // say the fleet is busy when it is not. 'hold' — already escalated.
      continue;
    }
    s.consider(
      {
        origin: top.origin,
        rule: top.rule,
        title: top.title,
        kind: 'code',
        branch: top.dispatch?.branch ?? pr.branch,
        reason: top.dispatchReason,
        action: {
          type: 'dispatch_code_agent',
          // The PR's branch for a fixing concern; a read-only checkout for one
          // that only reads.
          ...(top.dispatch ?? { branch: pr.branch }),
          ...(top.profile === undefined ? {} : { profile: top.profile }),
          title: top.title,
          prompt: top.prompt,
          originRef: top.origin,
          originTitle: top.originTitle,
          originSummary: top.originSummary,
          // So the next pulse doesn't read the same threads back as news.
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
 * Did the last agentless act of this type on this origin fail to happen? Read
 * from the same audit log the cooldown reads. `skipped` and `rejected` both
 * count — either way only an agent is left to settle the concern.
 */
function directActUnperformed(
  type: 'update_pr_branch' | 'requeue_ci_check',
  origin: string,
  decisions: Decision[],
): boolean {
  return decisions.some(
    (d) =>
      d.action.type === type && d.action.originRef === origin && (d.outcome === 'skipped' || d.outcome === 'rejected'),
  );
}

/**
 * The expired checks this gate can be cleared by requeueing, or null when it
 * needs an agent — null for the whole gate the moment any one watched check
 * needs a model (not expired, expired-but-guided, or no `requeueRef`), since
 * one agent covers the whole concern.
 */
function gateRequeues(verdict: CiWatchVerdict): Array<{ name: string; requeueRef: string }> | null {
  const requeues: Array<{ name: string; requeueRef: string }> = [];
  for (const m of verdict.watched) {
    if (!m.expired || m.rule?.guidance?.trim() || !m.requeueRef) return null;
    requeues.push({ name: m.name, requeueRef: m.requeueRef });
  }
  return requeues.length > 0 ? requeues : null;
}

/** One thing wrong with a PR that would warrant a code agent on its branch. */
interface PrConcern {
  /** Which dispatcher rule raised this concern, carried onto the emitted action. */
  rule: DispatchRuleId;
  origin: string;
  /**
   * The act that settles this concern **without an agent**, when the provider has
   * already stated the resolution. Set, and a free branch emits the act instead
   * of a dispatch; a staffed branch is still *told* rather than having it done
   * under its feet.
   */
  act?: RawAction;
  /**
   * Where this concern's agent is checked out, when not the PR's own branch.
   * `pr-review` differs — read-only checkout, leaves the lease alone.
   */
  dispatch?: { branch: string; base: string; readOnly: true };
  /**
   * The model profile this concern's dispatch is priced on (rule `pr-review`,
   * from the triage's mode). Absent resolves on the rule; an operator's pin
   * still overrides (`pinFor`).
   */
  profile?: string;
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
   * carrying `urgent`; decides queue position only, read across the PR's whole
   * concern list rather than off the one that won.
   */
  urgent?: boolean;
  /**
   * The individual world signals this concern folds, for notify de-dup. Defaults
   * to the concern itself ({@link signalsOf}). The review-comment concern differs:
   * dispatch is branch granularity, de-dup is thread granularity.
   */
  signals?: PrSignal[];
  /**
   * The CI checks this concern is about, carried onto the dispatch and task.
   * Set by the two CI rules; unset elsewhere means "not about a named check".
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
 * Name the waiting checks in the audit line, so the decision log distinguishes this
 * from the red-build dispatch it sits next to.
 */
function gateDispatchReason(prNumber: number, verdict: CiWatchVerdict): string {
  const names = verdict.watched.map((m) => m.name).join(', ');
  return `PR #${prNumber} has a check waiting on an action (${names}) and no agent is on it.`;
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

/**
 * Has the triage given up on this pull request? Makes rule `pr-review`'s wait
 * finite: `pr-review-triage` fails open silently, so only its own ledger can
 * tell "a route is coming" from "none ever will".
 */
function triageSpent(s: StageContext, prNumber: number): boolean {
  const verdict = dispatchVerdict(reviewTriageOrigin(prNumber), s.now, s.ctx.recentDecisions, s.cooldown);
  return verdict.kind === 'escalate' || verdict.kind === 'hold';
}

/**
 * Has the review itself given up on this pull request? Makes the wait finite
 * rather than a wedge, off the same ledger {@link triageSpent} reads. A cooldown
 * is deliberately **not** spent — releasing the branch for one pulse would
 * rewrite the diff the review is about to read. `hold` alone, not `escalate`:
 * standing down on `escalate` would drop the review with nobody told.
 */
function reviewSpent(s: StageContext, prNumber: number): boolean {
  return dispatchVerdict(reviewOrigin(prNumber), s.now, s.ctx.recentDecisions, s.cooldown).kind === 'hold';
}
