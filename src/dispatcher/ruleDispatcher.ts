import type { Dispatcher, DispatchContext, DispatchResult, QueueItem } from './dispatcher.js';
import type { ValidatedAction } from './actions.js';
import { parseActions } from './actions.js';
import { ciNeedsAttention, inheritedCiFailure, isStackedPr, needsBaseUpdate } from '../prHealth.js';
import type { Agent, Decision, Issue, IssueAssay, Plan, PlanPart, PullRequest, Task } from '../types.js';
import {
  isIssuePickupEligible,
  issueBranch,
  issuePriority,
  issueWatchGateReason,
  openPrForIssue,
  type IssuePickupPolicy,
} from './issuePickup.js';
import { dispatchVerdict, DEFAULT_COOLDOWN, type CooldownPolicy } from './dispatchCooldown.js';
import { askedAlready, supersededReason, type RuleHeld } from './admission.js';
import { ciFailureNote, ciNeedsHuman, classifyCiFailures, type CiPolicy, type CiVerdict } from '../ci/ciPolicy.js';
import { mergeProposalRef, planProposalHold, planProposalRef, proposalHold } from '../proposals/proposals.js';
import { DISPATCH_PIPELINE, type DispatchRuleId, type RuleConditions, type StageRuleId } from './rules.js';
import { rankByPriorityOverride } from './priorityOverride.js';
import { prCommentOrigin, prCommentsOrigin, reviewThreadNote, reviewThreadsNote } from './reviewThreads.js';
import { resolveIssueConclusion } from '../issueConclusion.js';
import { jobBranch } from '../jobs.js';
import { deliveryHold } from '../delivery/delivery.js';
import { shortfallArm, shortfallRef } from '../delivery/shortfall.js';
import { assayBranch, assayHold, assayOrigin, hasWorkStarted, isAssayed, type AssayPolicy } from '../intake/assay.js';
import { retroOrigin, type RetrospectivePolicy } from '../retro/retro.js';
import { assessBranch, assessOrigin, hasPriorWork, type AssessmentPolicy } from '../delivery/assessment.js';
import { PromptTemplates, defaultPromptTemplates } from './promptTemplates.js';
import { PLAN_FILE } from '../plans/planDocument.js';
import {
  DEFAULT_PLANNING,
  issueOrigin,
  planBranch,
  planOrigin,
  plannerVerdict,
  resolvePlanRoute,
  type PlanningPolicy,
  type PlanRouteVerdict,
} from '../plans/planning.js';
import { describeProposedParts } from '../plans/planApproval.js';
import { planApprovalWarnings, planIsWedged, wedgedPlanPrompt } from '../plans/planWedge.js';
import { isPlanInDiscussion } from '../plans/planDiscussion.js';
import {
  bySlug,
  currentPlanSummary,
  liveParts,
  partBase,
  partBranch,
  partDepth,
  partOrigin,
  partOutcomeNote,
  planIssueNumber,
  siblingContext,
} from '../plans/parts.js';

/**
 * A deterministic, dependency-free dispatcher that encodes the harness's default
 * priorities directly from the product vision.
 *
 * **What it does, and in what order, is not written here.** The rules are
 * `DISPATCH_PIPELINE` in `rules.ts` — named, described, ordered, and each
 * carrying the operator switch that turns it on — and `decide` walks that array.
 * This doc used to restate the order as a numbered list, the registry restated it
 * again as a hand-written `number` on each entry, and `concernUrgency` restated a
 * slice of it a third time; by the time they were collapsed the three disagreed.
 * One ordering, in one place, rendered nowhere as a position.
 *
 * Two vocabularies meet in `decide`:
 *
 * - **Rules** propose work from the world. Each is a `stages` entry, run when the
 *   walk reaches it and its `enabled` predicate passes.
 * - **Admission** decides what becomes of a proposal — dispatch, a note to the
 *   agent already on the branch, an escalation when the attempt cap is spent, or
 *   a named hold that keeps it visible in the queue (`admission.ts`).
 *
 * At most one code agent works a given PR branch: when a fresh signal lands on a
 * branch that already has a *running* agent, it's delivered to that agent via
 * `respond_to_agent` (deduped through `recentDecisions`) rather than spawning a
 * second one; while the branch's agent is `waiting`, the note is held so a
 * pending human escalation is never disturbed.
 *
 * It is the safe default and the reference the LLM dispatcher is measured
 * against. Every branch produces actions with an explicit `reason` and tags
 * them with its rule id from the {@link DISPATCH_RULES} registry (`rules.ts`),
 * so the audit log can show *which rule* fired, not just a sentence.
 */
export class RuleDispatcher implements Dispatcher {
  private readonly pickup: IssuePickupPolicy;
  private readonly cooldown: CooldownPolicy;
  private readonly templates: PromptTemplates;
  private readonly defaultBranch: string;
  private readonly planning: PlanningPolicy;
  private readonly assessment: AssessmentPolicy;
  private readonly assay: AssayPolicy;
  private readonly retrospective: RetrospectivePolicy;
  private readonly ci: CiPolicy;

  /**
   * `pickup` gates and orders issue pickup (rule 4). Omitted/partial => no gate
   * and flat priority, so `new RuleDispatcher()` keeps the pre-gate behaviour of
   * acting on every open issue (used by unit tests; the composition root passes
   * the operator's config). `cooldown` throttles re-dispatch of a persistent
   * concern (see {@link dispatchVerdict}); defaults keep the loop bounded.
   * `templates` supplies the agent/escalation prompt bodies; omitted => the
   * built-in defaults (the composition root loads operator overrides).
   * `defaultBranch` names the base a PR is assumed to target when the provider
   * doesn't report one, and only phrases the base-update prompt. `planning` turns
   * the plan funnel (rule 3c) on; omitted/disabled leaves rule 4 un-narrowed and
   * behaviour exactly as it is without plans. `assessment` turns rule 3e on;
   * omitted/disabled means no assessor fires and no issue is ever parked as
   * delivered, so pickup behaves exactly as it does today. `ci` decides rule 1
   * per failing check; omitted/empty means every failure is acted on generically,
   * which is what the rule did before per-check policy existed. `assay` turns the
   * goal assay (rule 3f) on; omitted/disabled means no assayer fires, no verdict is
   * written, and nothing in front of an issue changes. `retrospective` turns rule 3h
   * on; omitted/disabled means no delivered goal is written up, which changes no
   * dispatch and no gate — it only leaves the Manifest station with nothing to read.
   */
  constructor(
    pickup: Partial<IssuePickupPolicy> = {},
    cooldown: Partial<CooldownPolicy> = {},
    templates: PromptTemplates = defaultPromptTemplates(),
    defaultBranch = 'main',
    planning: Partial<PlanningPolicy> = {},
    assessment: Partial<AssessmentPolicy> = {},
    ci: Partial<CiPolicy> = {},
    assay: Partial<AssayPolicy> = {},
    retrospective: Partial<RetrospectivePolicy> = {},
  ) {
    // An **omitted** policy means the feature is out, for every one of the four
    // below — the contract `pickup` already states two paragraphs up ("omitted =>
    // no gate"), and deliberately not the same thing as the operator default in
    // `src/config.ts`, which turns all four on. The composition root always passes
    // config explicitly, so the two never both answer for one deployment: this
    // fallback exists for a caller that has named no policy at all, and such a
    // caller is asking for the rule not to fire.
    this.assay = { enabled: assay.enabled ?? false };
    this.retrospective = { enabled: retrospective.enabled ?? false };
    this.defaultBranch = defaultBranch;
    this.ci = { checks: ci.checks ?? [] };
    this.planning = {
      enabled: planning.enabled ?? false,
      maxConcurrentPartsPerIssue: planning.maxConcurrentPartsPerIssue ?? DEFAULT_PLANNING.maxConcurrentPartsPerIssue,
      requireApproval: planning.requireApproval ?? DEFAULT_PLANNING.requireApproval,
      // Reconciliation's knob, not the dispatcher's; carried so the policy stays one object.
      gitFetchIntervalMs: planning.gitFetchIntervalMs ?? DEFAULT_PLANNING.gitFetchIntervalMs,
    };
    this.assessment = { enabled: assessment.enabled ?? false };
    this.templates = templates;
    this.pickup = {
      watchLabel: pickup.watchLabel,
      ignoreLabel: pickup.ignoreLabel,
      requireOwnLabel: pickup.requireOwnLabel,
      priorityLabels: pickup.priorityLabels ?? {},
      defaultPriority: pickup.defaultPriority ?? 0,
      pickupStates: pickup.pickupStates,
      inReviewState: pickup.inReviewState,
    };
    this.cooldown = {
      maxAttempts: cooldown.maxAttempts ?? DEFAULT_COOLDOWN.maxAttempts,
      cooldownMs: cooldown.cooldownMs ?? DEFAULT_COOLDOWN.cooldownMs,
    };
  }

  async decide(ctx: DispatchContext): Promise<DispatchResult> {
    const raw: unknown[] = [];
    const activeOrigins = new Set(
      ctx.tasks.filter((t) => isActive(t) && t.originRef).map((t) => t.originRef as string),
    );
    // Ranked agent-dispatch candidates in dispatch-priority order. The headroom
    // cut is applied *after* ranking (rank-then-slice), so below-cut candidates
    // survive as the visible "Up next" queue instead of being dropped (issue #69).
    const candidates: Candidate[] = [];
    // Origins we've already told a live agent about (from the audit log), so a
    // persistent signal isn't re-notified every cycle. Best-effort over the
    // recent decision window — a note that ages out is harmless (the agent just
    // gets told again).
    const notified = notifiedOriginsByAgent(ctx.recentDecisions);
    // The signals each branch's dispatch already carried into an agent's prompt —
    // the half `notified` cannot see, since a dispatch is not a note.
    const dispatchedSignals = dispatchedSignalsByBranch(ctx.recentDecisions);
    // "Now" for cooldown arithmetic — the snapshot's own timestamp, so a cycle is
    // judged against when its world was observed, not wall-clock at decision time.
    const now = ctx.world.takenAt;
    // Throttle a persistent concern: a finished agent that didn't clear its origin
    // cools down instead of re-dispatching every cycle, and escalates once its
    // attempts are spent. Escalations don't claim headroom (no agent is started);
    // a dispatchable candidate joins the ranked queue, a cooling one is kept there
    // greyed so the cockpit can explain why it isn't moving.
    const consider = (candidate: Candidate, onEscalate: (attempts: number) => RawAction): void => {
      const verdict = dispatchVerdict(candidate.origin, now, ctx.recentDecisions, this.cooldown);
      if (verdict.kind === 'escalate') raw.push(onEscalate(verdict.attempts));
      else if (verdict.kind === 'cooldown') candidates.push({ ...candidate, held: 'cooldown' });
      else if (verdict.kind === 'dispatch') candidates.push(candidate);
      // 'hold' — already escalated; leave the origin alone this cycle.
    };

    /**
     * What each rule does, keyed by its id. The **order they run in is not here**
     * — it is {@link DISPATCH_PIPELINE}, walked at the bottom of this method, and
     * this map answers only "what does that rule do". Splitting the two is the
     * point: a rule's position used to be its position in this method's prose,
     * with a hand-written number on the registry entry claiming to mirror it, and
     * the two had drifted.
     *
     * `Partial` because an id here may be **covered by an earlier pass**: the four
     * PR-concern rules and `pr-merge-ready` share one walk over the open PRs, since
     * at most one agent works a branch and the fold that picks the top concern has
     * to see all of them together. That pass is registered under the first of them
     * and the rest map to nothing.
     */
    const stages: Partial<Record<StageRuleId, () => void>> = {};

    // Operator-launched jobs outrank every world-driven rule, which is what its
    // first position in the pipeline says. Queued oldest-first so the headroom cut
    // dispatches them ahead of every world-driven candidate — a manual request wins
    // the next free slot; one that doesn't fit stays in the queue as `waiting` and
    // is retried next cycle. No cooldown throttle applies (a job is a one-shot
    // request, not a persistent signal): once dispatched it's marked so and leaves
    // the queue. The `jobId` rides on the action so the executor marks the job
    // dispatched only once its agent actually spawns.
    stages['manual-job'] = () => {
      for (const job of ctx.queuedJobs) {
        const origin = `job:${job.id}`;
        if (activeOrigins.has(origin)) continue;
        // Shared with the work graph's fold, which recognises this job's PR by it.
        const branch = jobBranch(job);
        const reason = `Operator-launched job "${job.title}" takes priority for the next free slot.`;
        const action: RawAction =
          job.kind === 'code'
            ? {
                type: 'dispatch_code_agent',
                branch: branch!,
                title: job.title,
                prompt: job.prompt,
                originRef: origin,
                originTitle: job.title,
                originSummary: 'Operator-launched job.',
                jobId: job.id,
                rule: 'manual-job',
                reason,
              }
            : {
                type: 'dispatch_desk_agent',
                title: job.title,
                prompt: job.prompt,
                originRef: origin,
                originTitle: job.title,
                originSummary: 'Operator-launched job.',
                jobId: job.id,
                rule: 'manual-job',
                reason,
              };
        candidates.push({ origin, rule: 'manual-job', title: job.title, kind: job.kind, branch, reason, action });
      }
    };

    // The plan funnel's memory, read by the work-item, plan and pickup rules alike
    // so none of them can hold a different opinion about an issue. Empty with the
    // funnel off.
    const plansByOrigin = new Map((ctx.plans ?? []).map((p) => [p.originRef, p]));
    // Standing "is this issue finished" verdicts, keyed on the same `issue:<n>`
    // origin. Empty until someone declares one, which resolves every issue to
    // `undeclared` — the direction that stops rather than acts.
    const conclusions = new Map((ctx.conclusions ?? []).map((c) => [c.originRef, c]));
    // The negative half of that verdict, on the same origin. Rule 3b resolves the
    // two together or it reads the assessor's "not delivered" as the working
    // agent's `done` — and `shortfallRecordedNote`'s no-cause arm promises this
    // exact behaviour ("it comes back round for pickup with your summary").
    const shortfallsByOrigin = new Map((ctx.shortfalls ?? []).map((s) => [s.originRef, s]));
    /** Is this issue decomposed — i.e. owned by the part scheduler, not by pickup? */
    const partsPlanFor = (issueNumber: number): Plan | null => {
      if (!this.planning.enabled) return null;
      const plan = plansByOrigin.get(issueOrigin(issueNumber));
      return plan && (plan.status === 'active' || plan.status === 'complete') ? plan : null;
    };

    // Every open PR the world knows about: the dispatch view plus the ones the
    // operator's ignore tag hid from it. Nothing below *acts* on an excluded PR —
    // they're here only so "no PR in the world" can't be mistaken for "the PR
    // merged", which would put a second agent on an ignored PR's own branch, and
    // so a stack's base PR is still found when the operator has ignored it.
    const openPrs = ctx.excludedPrs?.length ? [...ctx.world.pullRequests, ...ctx.excludedPrs] : ctx.world.pullRequests;

    // React to PR signals first — they're time-sensitive. At most one code
    // agent works a given branch, so a fresh signal for a branch that already
    // has a running agent is delivered to it, never a second dispatch. Dispatch
    // candidates are collected here and ranked across PRs below — world order is
    // arbitrary, so it must not decide who wins scarce headroom.
    //
    // **One pass covering five rules**, registered under the first of them, which
    // is why `pr-ci-blocked`, `pr-base-update`, `pr-review-comment` and
    // `pr-merge-ready` have no `stages` entry of their own. They are not
    // independent: the four concern rules feed one per-PR list whose *top* entry
    // alone becomes a dispatch, because one agent works a branch. Their relative
    // urgency is their order in {@link DISPATCH_PIPELINE} — see `concernUrgency`,
    // which reads it rather than restating it.
    stages['pr-ci-failing'] = () => {
      const prCandidates: Array<{ pr: PullRequest; top: PrConcern }> = [];
      for (const pr of ctx.world.pullRequests) {
        if (pr.merged) continue; // a merged PR is done — never act on it.

        // Every concern that would, on its own, warrant a code agent on this
        // branch, ordered by urgency: CI > base-update > review comments.
        const concerns: PrConcern[] = [];
        // A stacked PR's CI runs the commits of the PR underneath it, so a red base
        // turns every PR above it red. Dispatching on that would put an agent on each
        // of them to fix code that is not theirs — the failure multiplies up the
        // stack and none of those agents can do anything about it. Suppress the rule
        // here and leave it at that: the failing PR at the bottom is in this same
        // world and rule 1 fires on it under its own steam, so there is no concern to
        // push down. Only the CI rule is suppressed — the base-update rule below still
        // fires, which is what keeps a stack restacking when its parent pushes.
        const inheritedFailure = inheritedCiFailure(pr, openPrs);
        // Which checks failed decides what happens, not merely that CI is red. An
        // unconfigured harness — and a provider that reports no per-check detail —
        // yields `actionable` with empty lists, i.e. exactly the behaviour above.
        const ciVerdict = classifyCiFailures(pr.ciChecks, this.ci);
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
              this.templates.render('pr-ci-fix', { number: pr.number, title: pr.title, branch: pr.branch }) +
              ciFailureNote(ciVerdict),
            dispatchReason: ciDispatchReason(pr.number, ciVerdict),
            note: `CI is now failing on PR #${pr.number} — investigate and push a fix.${ciFailureNote(ciVerdict)}`,
            originTitle: pr.title,
            originSummary: `PR #${pr.number} on branch ${pr.branch} · CI ${pr.ciStatus}${pr.approved ? ' · approved' : ''}`,
            urgent: ciVerdict.urgent,
          });
        } else if (ciFailing && ciNeedsHuman(ciVerdict)) {
          // Nothing an agent can fix, and the operator asked to be told. Put it to
          // a human once — see `askedAlready` for why that takes two readings.
          const ciOrigin = `pr:${pr.number}:ci`;
          if (!askedAlready(ciOrigin, ctx.openEscalations, ctx.recentDecisions)) {
            const names = ciVerdict.escalate.map((m) => m.name).join(', ');
            raw.push({
              type: 'escalate_to_human',
              escalationType: 'resolve_ambiguity',
              prompt:
                `CI is failing on PR #${pr.number} ("${pr.title}"), and every failing check is one you have told ` +
                `the harness not to act on: ${names}. No agent has been dispatched. This needs someone who can ` +
                `reach whoever owns those checks.`,
              context: { originRef: ciOrigin, prNumber: pr.number, taskTitle: pr.title },
              rule: 'pr-ci-blocked',
              reason: `PR #${pr.number} is red only on checks configured to escalate (${names}).`,
            } satisfies RawAction);
          }
        }
        if (needsBaseUpdate(pr)) {
          const base = pr.baseBranch ?? this.defaultBranch;
          const behind = pr.mergeableState === 'behind';
          concerns.push({
            rule: 'pr-base-update',
            origin: `pr:${pr.number}:mergeable`,
            title: behind ? `Update PR #${pr.number} with ${base}` : `Resolve merge conflicts on PR #${pr.number}`,
            prompt: this.templates.render(behind ? 'pr-base-update-behind' : 'pr-base-update-conflict', {
              number: pr.number,
              title: pr.title,
              branch: pr.branch,
              base,
            }),
            dispatchReason: behind
              ? `PR #${pr.number} is behind ${base} and no agent is on it.`
              : `PR #${pr.number} has merge conflicts with ${base} and no agent is on it.`,
            note: behind
              ? `PR #${pr.number} is now behind ${base} — merge ${base} in to bring it up to date, then push.`
              : `The base branch ${base} now conflicts with PR #${pr.number} — merge ${base} in, resolve the conflicts, and push.`,
            originTitle: pr.title,
            originSummary: `PR #${pr.number} on branch ${pr.branch} · ${behind ? `behind ${base}` : `conflicts with ${base}`}`,
          });
        }
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
            // follows it either way.
            prompt:
              this.templates.render('pr-review-comment', {
                number: pr.number,
                branch: pr.branch,
                author: authors.join(', '),
                comment: unhandled[0]!.body,
              }) + reviewThreadsNote(unhandled),
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
                (s) =>
                  !activeOrigins.has(s.ref) &&
                  !dispatchedSignals.has(`${pr.branch}::${s.ref}`) &&
                  !notified.has(`${branch.agent.id}::${s.ref}`),
              ),
            );
            if (fresh.length > 0) {
              raw.push({
                type: 'respond_to_agent',
                agentId: branch.agent.id,
                response:
                  `An update on the branch you're working (PR #${pr.number}):\n` +
                  fresh.map((s) => `- ${s.note}`).join('\n') +
                  (fresh.length > 1
                    ? '\n\nRead them together before changing anything — they may resolve or contradict one another.'
                    : ''),
                originRefs: fresh.map((s) => s.ref),
                rule: 'branch-notify',
                reason: `New PR signal(s) for a branch already staffed by agent ${branch.agent.id}.`,
              } satisfies RawAction);
            }
          } else if (branch.kind === 'free') {
            // No agent on this branch — a dispatch candidate for the most urgent
            // concern; ranked cross-PR (and throttled) after the loop.
            prCandidates.push({ pr, top: concerns[0]! });
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
          !isStackedPr(pr, this.defaultBranch) &&
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
          raw.push({
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
      // urgent concern class (CI > base-update > review comment), tie-break by PR
      // number for determinism.
      prCandidates.sort(
        (a, b) =>
          Number(b.top.urgent ?? false) - Number(a.top.urgent ?? false) ||
          concernUrgency(a.top.rule) - concernUrgency(b.top.rule) ||
          a.pr.number - b.pr.number,
      );
      for (const { pr, top } of prCandidates) {
        consider(
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
              signalRefs: signalsOf(top).map((s) => s.ref),
              rule: top.rule,
              reason: top.dispatchReason,
            } satisfies RawAction,
          },
          (attempts) => ({
            type: 'escalate_to_human',
            escalationType: 'resolve_ambiguity',
            prompt: this.templates.render('pr-concern-escalation', {
              title: top.title,
              number: pr.number,
              attempts,
            }),
            context: { originRef: top.origin, prNumber: pr.number, taskTitle: top.title },
            rule: 'cooldown-escalate',
            reason: `Origin ${top.origin} hit the ${this.cooldown.maxAttempts}-attempt cap without clearing — escalating instead of looping.`,
          }),
        );
      }
    };

    // Keep a work item's state in step with whether a PR is open for it. An
    // item in a pickup state ("Ready"/"Doing") with an open PR moves to the review
    // state, so it isn't re-picked while it waits on CI/review.
    //
    // The inverse arm returns an item to the *first* pickup state — but **only on
    // an explicit `more_work` verdict**, never on the mere absence of a PR. That
    // used to be the other way round, and it was the bug: `openPrForIssue` reads
    // only the open list, so "this PR merged" and "there was never a PR" are one
    // observation, and a merged PR bounced its ticket back to "Ready" for rule 4
    // to put a fresh agent on work already on the default branch. A review state
    // does not distinguish "waiting on test" from "still has work in it", so the
    // harness now stops on silence and says so, rather than guessing (see
    // `src/issueConclusion.ts`).
    //
    // A decomposed issue needs no special case here any more: an in-flight plan
    // resolves to `more_work` through the roll-up and a complete one to `done`,
    // which is the same behaviour the explicit `decomposed` check used to give it.
    //
    // Both directions are idempotent (after either move the item no longer
    // matches) and neither fires on a closed item. Opt-in — off unless the
    // operator set both a review state and pickup states, and only for items
    // carrying a native state (Azure work items; GitHub issues have none, so this
    // is a no-op for them).
    // Both arms are gated on the same operator config (`workItemStates`), so the
    // `enabled` predicate on each registry entry is what switches them in — the
    // shared `if` they used to sit inside is gone. They run as two passes now
    // rather than the two arms of one `if/else`, which is why the second re-states
    // the first's condition as an exclusion: identical behaviour under every
    // config, including the degenerate one where an operator has named their review
    // state as a pickup state too.
    //
    // `workItemStates` narrows both to non-null, but that predicate lives at the
    // bottom of this method — too far from these two bodies for a `!` assertion to
    // be honest about what guarantees it. Narrowed once, here, so each stage reads
    // its config off a value the type system already knows is present.
    const workItemStates =
      this.pickup.inReviewState && this.pickup.pickupStates?.length
        ? { inReviewState: this.pickup.inReviewState, pickupStates: this.pickup.pickupStates }
        : null;
    stages['work-item-in-review'] = () => {
      if (!workItemStates) return;
      const { inReviewState, pickupStates } = workItemStates;
      for (const issue of ctx.world.issues) {
        const state = issue.workItemState;
        if (state === undefined || issue.state !== 'open') continue;
        if (!pickupStates.includes(state)) continue;
        // The agent for an issue works branch `issue/<n>` (see `issue-pickup`), so
        // its PR lands on that branch — the reliable link even when Azure hasn't
        // wired the ArtifactLink relation. `openPrForIssue` falls back to the
        // linked-PR number.
        const pr = openPrForIssue(issue, openPrs);
        // A decomposed item belongs in the review state for the whole life of its
        // plan: it isn't waiting on one PR, it's waiting on several, and the inverse
        // below would bounce it back to "Ready" in every gap between parts — and
        // again the moment the last one merges. This is also the design's
        // "completion moves an Azure work item to the review state", reusing the
        // action rather than inventing a second path to it.
        const decomposed = partsPlanFor(issue.number) !== null;
        if (!pr && !decomposed) continue;
        raw.push({
          type: 'set_work_item_state',
          number: issue.number,
          state: inReviewState,
          rule: 'work-item-in-review',
          reason: decomposed
            ? `Work item #${issue.number} is delivered as a multi-part plan; move it to "${inReviewState}" for the life of the plan.`
            : `PR #${pr!.number} is open for work item #${issue.number}; move it to "${inReviewState}" so it isn't re-picked while under review.`,
        } satisfies RawAction);
      }
    };

    stages['work-item-back-to-pickup'] = () => {
      if (!workItemStates) return;
      const { inReviewState, pickupStates } = workItemStates;
      // No separate config for where an item returns to: the first pickup state is
      // the operator's own "start here" (e.g. "Ready" in ["Ready","Doing"]).
      const returnState = pickupStates[0]!;
      for (const issue of ctx.world.issues) {
        const state = issue.workItemState;
        if (state === undefined || issue.state !== 'open') continue;
        // The back-off arm above owns an item in a pickup state, whatever else is
        // true of it — preserving the `else if` these two used to share.
        if (pickupStates.includes(state)) continue;
        if (state !== inReviewState) continue;
        if (openPrForIssue(issue, openPrs)) continue;
        // The one question that decides it: did whoever owns this issue say
        // there is more to do? A plan says so by having parts in flight, an
        // agent by calling `conclude_work`. `done` and `undeclared` both leave
        // the item where it is — the first because it is finished, the second
        // because nobody vouched for it and re-doing merged work is the more
        // expensive mistake than waiting for a human to look.
        const conclusion = resolveIssueConclusion(
          conclusions.get(issueOrigin(issue.number)) ?? null,
          plansByOrigin.get(issueOrigin(issue.number)) ?? null,
          shortfallsByOrigin.get(issueOrigin(issue.number)) ?? null,
        );
        if (conclusion.verdict !== 'more_work') continue;
        raw.push({
          type: 'set_work_item_state',
          number: issue.number,
          state: returnState,
          rule: 'work-item-back-to-pickup',
          reason:
            `Work item #${issue.number} is open in "${inReviewState}" with no open PR, and ` +
            `${
              conclusion.by === 'plan'
                ? conclusion.note
                : conclusion.by === 'assessor'
                  ? 'an assessment of the delivered work found the goal is not reached'
                  : `${conclusion.by === 'operator' ? 'you' : 'the agent that worked it'} reported work outstanding`
            }` +
            `; move it back to "${returnState}" so the rest can be picked up.`,
        } satisfies RawAction);
      }
    };

    // The issue-side world, derived once and shared by every rule below. Gate on
    // *no open PR* rather than on `linkedPrNumber` being unset: that field is
    // sticky (the last PR to ever cross-reference the issue), so gating on it retires
    // an issue the first time any PR touches it, even when the issue needs a second
    // one. Also gate on the pickup label (when configured) so operators can say "work
    // these, leave the rest" — untagged issues stay visible in the world, just
    // unacted-on — and order by label-encoded priority so the important ones claim
    // limited headroom first (tie-break by issue number for determinism).
    // Standing `delivered` verdicts, keyed on the same `issue:<n>` origin. Unlike a
    // conclusion this one gates: an assessed issue is parked until the world moves
    // or the operator says otherwise. Asked through the same pure `deliveryHold`
    // the cockpit chip asks, so the two can never disagree about an issue.
    const deliveries = new Map((ctx.deliveries ?? []).map((d) => [d.originRef, d]));
    const deliveryParked = (issue: Issue): boolean =>
      deliveryHold(deliveries.get(issueOrigin(issue.number)) ?? null, issue, {
        pickupStates: this.pickup.pickupStates,
        signals: ctx.deliverySignals,
      }) !== null;

    // Standing goal assays, on the same origin again (issue #158). Where a delivery
    // verdict parks an issue that is *finished*, this parks one that could never be
    // started: only an explicit `unclear` holds, and a missing verdict holds nothing,
    // which is what makes an assayer that crashed or spent its cap fail the issue
    // open to ordinary pickup. Asked through the same pure `assayHold` the cockpit
    // chip asks, so the two can never disagree about an issue.
    const assays = new Map((ctx.assays ?? []).map((a) => [a.originRef, a]));
    const assayFor = (issue: Issue): IssueAssay | null => assays.get(issueOrigin(issue.number)) ?? null;
    const assayParked = (issue: Issue): boolean =>
      assayHold(assayFor(issue), issue, { signals: ctx.assaySignals }) !== null;

    const eligibleIssues = ctx.world.issues
      .filter(
        (i) =>
          i.state === 'open' &&
          openPrForIssue(i, openPrs) === null &&
          !deliveryParked(i) &&
          // The content gate, in front of both the planner and pickup: an issue
          // whose goal the assay could not work from is not eligible for either,
          // which is what stops a decomposition of a question nobody could answer.
          !assayParked(i) &&
          isIssuePickupEligible(i, this.pickup).eligible,
      )
      .map((issue) => ({ issue, weight: issuePriority(issue.labels, this.pickup) }))
      .sort((a, b) => b.weight - a.weight || a.issue.number - b.issue.number);

    // 3f: Check the goal before anything is dispatched against it (issue #158).
    //
    // The gap this closes: every gate an issue passes on its way to an agent asks
    // about policy — the watch tag, the workflow state, the cooldown, the attempt
    // cap, headroom, `resolvePlanRoute` — and none of them asks whether the ticket
    // says anything an agent could act on. So a vague or already-obsolete issue goes
    // straight into the funnel, and the first sign anything was wrong is an agent
    // spending its attempt cap and escalating in a way that reads as its own failure.
    //
    // Ranked ahead of the planner and suppressing it for the same issue, for rule
    // 3c's own reason pointed one stage earlier: a planner *unblocks* work, and
    // decomposing a goal nobody could answer is the specific waste this exists to
    // stop — the operator would be asked to approve a decomposition of a question.
    //
    // Fires only for an issue nothing has been started for. `hasPriorWork` is the
    // same discriminator rule 3e uses, taking the other arm: nothing started means
    // the goal is still the only thing there is to judge, something started means
    // the question has been answered by someone acting on it (and, once it finishes,
    // it is the assessor's). An issue that already has a plan is likewise past this
    // gate — the funnel has read it — so a plan row skips it whatever its status.
    const assaying = new Set<number>();
    stages['issue-assay'] = () => {
      for (const { issue } of eligibleIssues) {
        // Already judged, and judged against *this* text — an edited ticket
        // fingerprints differently and is assayed again, which is the same
        // comparison that ends a hold (see `assayHold`).
        if (isAssayed(assayFor(issue), issue)) continue;
        if (hasWorkStarted(issue.number, ctx.tasks)) continue;
        if (plansByOrigin.has(issueOrigin(issue.number))) continue;
        const root = issueOrigin(issue.number);
        if ([...activeOrigins].some((o) => o === root || o.startsWith(`${root}:`))) continue;

        const origin = assayOrigin(issue.number);
        const verdict = dispatchVerdict(origin, now, ctx.recentDecisions, this.cooldown);
        // Fails open, exactly as the planner and the assessor do: a spent cap
        // returns the issue to the funnel it would have entered anyway, with no
        // escalation. Without it, every assayer crash is a permanently parked
        // issue — which would make this gate the most effective way to stop the
        // harness working, the failure issue #158 names in its first decision.
        if (verdict.kind === 'escalate' || verdict.kind === 'hold') continue;

        assaying.add(issue.number);
        const branch = assayBranch(issue.number);
        const title = `Assay issue #${issue.number}`;
        const reason = `Nothing has been started for issue #${issue.number}; check the goal can be worked from before dispatching against it.`;
        candidates.push({
          origin,
          rule: 'issue-assay',
          title,
          kind: 'code',
          branch,
          reason,
          held: verdict.kind === 'cooldown' ? 'cooldown' : undefined,
          action: {
            type: 'dispatch_code_agent',
            branch,
            // Cut from the default branch: the question is whether this goal makes
            // sense against the repository as it stands.
            base: this.defaultBranch,
            title,
            prompt: this.templates.render('issue-assay', {
              number: issue.number,
              title: issue.title,
              body: issue.body,
              branch,
            }),
            originRef: origin,
            // The exact text the verdict will be fingerprinted against — see
            // `AgentManager.recordAssay`, which reads these two fields back off
            // the task rather than re-reading the issue.
            originTitle: issue.title,
            originSummary: issue.body,
            rule: 'issue-assay',
            reason,
          } satisfies RawAction,
        });
      }
    };

    // Which arm of the plan funnel each eligible issue is on. Resolved once, from
    // the persisted plan plus the plan origin's own cooldown verdict, and shared by
    // `issue-plan` and `issue-pickup` so the two can never disagree about an issue.
    // With planning disabled every issue routes to `single`, so `issue-pickup` is
    // un-narrowed.
    const routes = new Map<number, PlanRouteVerdict>();
    for (const { issue } of eligibleIssues) {
      const plan = plansByOrigin.get(issueOrigin(issue.number)) ?? null;
      routes.set(
        issue.number,
        resolvePlanRoute({
          planning: this.planning,
          plan,
          verdict: plannerVerdict(issue.number, plan, now, ctx.recentDecisions, this.cooldown),
          // A replan that spends its attempts falls back to the decomposition the
          // issue already has, not open to `single` — see `resolvePlanRoute`.
          existingParts: plan ? liveParts((ctx.planParts ?? []).filter((p) => p.planId === plan.id)).length : 0,
        }),
      );
    }

    // Put a planning agent in front of pickup. It reads the repo and writes a
    // verdict — one PR or several — which is what makes today's one-agent/one-PR
    // path an explicit outcome of the funnel rather than a bypass. Ranked ahead of
    // `issue-pickup` because a planner *unblocks* work, so it should win a scarce
    // slot before the work it unblocks. There is no escalation arm: a planner that
    // spends its attempt cap without producing a plan fails the issue open to
    // `single` (see `resolvePlanRoute`), so a failure never parks an issue.
    stages['issue-plan'] = () => {
      for (const { issue } of eligibleIssues) {
        const route = routes.get(issue.number);
        if (route?.route !== 'planning') continue;
        // `issue-assay` is deciding whether this goal can be worked from at all.
        // Planning it in the same cycle is the exact waste the assay exists to
        // prevent — and would put the decomposition of an unanswerable question in
        // front of an operator. Queued as `superseded` rather than skipped: a
        // planner that silently never appeared was the same invisibility `capped`
        // was named to fix.
        const supersededBy = assaying.has(issue.number) ? ('issue-assay' as const) : null;
        const origin = planOrigin(issue.number);
        if (activeOrigins.has(origin)) continue; // a planner is already on it
        const branch = planBranch(issue.number);
        // Ingestion only ever writes `single`/`active`, so a plan row sitting in
        // `planning` is an operator's replan request: same rule, same origin, same
        // ingestion path — but the planner is primed with what already exists rather
        // than being asked to plan the issue cold. Without that it would re-derive a
        // decomposition from scratch and give the parts new slugs, which is precisely
        // what would strand the in-flight ones.
        const existing = plansByOrigin.get(issueOrigin(issue.number)) ?? null;
        const replan = existing !== null && existing.status === 'planning';
        // A discussion is a replan whose planner talks first. Same status, same
        // origin, same branch — only the prompt differs, which is why it needs no
        // gate of its own (see `isPlanInDiscussion`).
        const discussing = isPlanInDiscussion(existing);
        const title = discussing
          ? `Discuss the plan for issue #${issue.number}`
          : replan
            ? `Replan issue #${issue.number}`
            : `Plan issue #${issue.number}`;
        const reason = discussing
          ? `An operator is discussing the plan for issue #${issue.number} before approving it.`
          : replan
            ? `Issue #${issue.number} was sent back for replanning; plan it again from its current state.`
            : `Open issue #${issue.number} has no plan yet; plan it before dispatching work.`;
        candidates.push({
          origin,
          rule: 'issue-plan',
          title,
          kind: 'code',
          branch,
          reason: supersededBy ? supersededReason(supersededBy, reason) : reason,
          // Superseded outranks the throttle as an explanation: this planner is not
          // going out this cycle whatever the cooldown says. Otherwise throttled
          // like any other origin — kept visible in the queue, not dispatched.
          held: supersededBy ? 'superseded' : route.planner === 'cooldown' ? 'cooldown' : undefined,
          action: {
            type: 'dispatch_code_agent',
            branch,
            title,
            prompt:
              discussing || replan
                ? this.templates.render(discussing ? 'discuss-plan' : 'issue-replan', {
                    number: issue.number,
                    title: issue.title,
                    body: issue.body,
                    branch,
                    planFile: PLAN_FILE,
                    current: currentPlanSummary(
                      existing!,
                      (ctx.planParts ?? []).filter((p) => p.planId === existing!.id),
                    ),
                  })
                : this.templates.render('issue-plan', {
                    number: issue.number,
                    title: issue.title,
                    body: issue.body,
                    branch,
                    planFile: PLAN_FILE,
                  }),
            originRef: origin,
            originTitle: issue.title,
            originSummary: issue.body,
            rule: 'issue-plan',
            reason,
          } satisfies RawAction,
        });
      }
    };

    // Ask whether an issue that has already had work is finished.
    //
    // The gap this closes: `openPrForIssue` reads only the *open* list, so the
    // moment a delivering PR merges the issue is once again "open, watched, no open
    // PR" — rule 4's entire precondition — and a fresh agent is put on work already
    // sitting on the default branch. Azure is half-covered by accident (rule 3b
    // parks the item in the review state), but that park is a *tracker* state and
    // GitHub has none, so there the only thing bounding the loop is the attempt cap.
    //
    // Deliberately **not** driven off `eligibleIssues`, for rule 4a's reason: that
    // list applies the workflow-state gate, and the Azure case this must cover is
    // precisely an item parked in the review state. The watch/ignore tag is the only
    // pickup gate that applies, evaluated once on the issue.
    //
    // Ranked ahead of rule 4 and suppressing it for the same issue. An open watched
    // issue with no open PR is a candidate for both, and `hasPriorWork` is what tells
    // them apart: nothing started means pickup, something finished means ask. Without
    // the suppression both fire and two agents land on one issue, one assessing and
    // one redoing the work.
    const assessing = new Set<number>();
    stages['issue-assess'] = () => {
      for (const issue of ctx.world.issues) {
        if (issue.state !== 'open') continue;
        if (issueWatchGateReason(issue, this.pickup) !== null) continue;
        if (openPrForIssue(issue, openPrs) !== null) continue;
        if (deliveryParked(issue)) continue; // already assessed; the verdict stands
        if (!hasPriorWork(issue.number, ctx.tasks)) continue;
        // A plan that still schedules something owns the issue — a decomposition in
        // flight is not a finished one, and an unapproved one is not even decided.
        const plan = plansByOrigin.get(issueOrigin(issue.number));
        if (plan && (plan.status === 'planning' || plan.status === 'active' || plan.status === 'awaiting_approval'))
          continue;
        // Anything live under the issue — a pickup agent, a planner, a part — means
        // the answer is not yet knowable.
        const root = issueOrigin(issue.number);
        if ([...activeOrigins].some((o) => o === root || o.startsWith(`${root}:`))) continue;

        const origin = assessOrigin(issue.number);
        const verdict = dispatchVerdict(origin, now, ctx.recentDecisions, this.cooldown);
        // Fails open, exactly as the planner does and for its reason: narrowing rule
        // 4 without this turns any assessor crash into a permanently parked issue.
        // A spent cap returns the issue to ordinary pickup, with no escalation —
        // there is nothing for a human to do about an assessment that did not happen
        // that they cannot do by looking at the issue.
        if (verdict.kind === 'escalate' || verdict.kind === 'hold') continue;

        assessing.add(issue.number);
        const branch = assessBranch(issue.number);
        const title = `Assess issue #${issue.number}`;
        const reason = `Issue #${issue.number} has had work and has nothing in flight; assess whether it is finished.`;
        candidates.push({
          origin,
          rule: 'issue-assess',
          title,
          kind: 'code',
          branch,
          reason,
          held: verdict.kind === 'cooldown' ? 'cooldown' : undefined,
          action: {
            type: 'dispatch_code_agent',
            branch,
            // Cut from the default branch: merged work is *on* it, so it is the only
            // checkout in which "was this delivered" can be answered at all.
            base: this.defaultBranch,
            title,
            prompt: this.templates.render('issue-assess', {
              number: issue.number,
              title: issue.title,
              body: issue.body,
              branch,
            }),
            originRef: origin,
            originTitle: issue.title,
            originSummary: issue.body,
            rule: 'issue-assess',
            reason,
          } satisfies RawAction,
        });
      }
    };

    // Act on an assessment that said the goal was *not* reached (issue #159).
    //
    // The gap this closes: the check existed (`issue-assess`) and the replan existed
    // (`POST /api/plans/:id/replan`), and nothing joined them. A negative verdict
    // was written into `issue_conclusions`, whose only consumer emits a *tracker*
    // move — so on GitHub it changed no dispatch at all, and on either provider,
    // for a decomposed issue, rule 4 is gated on the `single` route and rule 4a
    // finds every part settled. The assessor said "not delivered" and the harness
    // scheduled nothing, anywhere. This is the one consumer of the row that says so.
    //
    // Three arms, chosen by the cause the assessor *declared* — deriving it would
    // route every shortfall to a replan and re-decompose plans whose shape was
    // never the problem, which is the issue's own stated failure mode. Two of them
    // spend a fleet, so they are put to a human; the third asks a human and
    // schedules nothing, so it is an escalation rather than a proposal (accepting
    // and rejecting "do nothing" are the same act, and that is not a decision).
    //
    // Read off `ctx.shortfalls` rather than `eligibleIssues` for rules 3e/4a's
    // reason: an issue that has been worked has a PR, open or not, and the
    // workflow-state gate is exactly what parks it while this question matters.
    stages['issue-shortfall'] = () => {
      for (const shortfall of ctx.shortfalls ?? []) {
        const issueNumber = planIssueNumber(shortfall.originRef);
        if (issueNumber === null) continue;
        const issue = ctx.world.issues.find((i) => i.number === issueNumber);
        if (!issue || issue.state !== 'open') continue;
        if (issueWatchGateReason(issue, this.pickup) !== null) continue;
        const plan = plansByOrigin.get(issueOrigin(issueNumber)) ?? null;
        // Both plan-shaped arms are performed by rules that only exist with the
        // funnel on — a replan needs rule 3c to pick the `planning` plan up, and a
        // follow-up part needs rule 4a to schedule it. With planning off, accepting
        // either would park the issue on a transition nothing consumes, so the arm
        // degrades to the one that asks a person. Same fail-safe direction as the
        // planner's and the assessor's.
        const routable = plan !== null && this.planning.enabled;
        const arm = shortfallArm(shortfall.cause, routable);
        // Nothing was named beyond "the work is not finished", so there is nothing to
        // route. The verdict still stands and `resolveIssueConclusion` still reads it
        // as `more_work` — what does not happen is a route invented out of silence.
        if (arm === 'none') continue;

        const ref = shortfallRef(issueNumber);
        if (arm === 'escalate') {
          if (askedAlready(ref, ctx.openEscalations, ctx.recentDecisions)) continue;
          raw.push({
            type: 'escalate_to_human',
            escalationType: 'resolve_ambiguity',
            prompt:
              `An assessment of issue #${issueNumber} ("${issue.title}") found that the work is done and the ` +
              `goal is still not reached${shortfall.cause === 'goal' ? ', and that the issue itself is what is wrong' : ''}. ` +
              `No agent has been dispatched and none will be: ${
                shortfall.cause === 'goal'
                  ? 'a wrong or ambiguous goal is not something a planner or an agent can fix'
                  : 'there is no delivery plan here to re-plan or add a part to'
              }. What the assessor found:\n\n"${shortfall.summary}"`,
            context: { originRef: ref, issueNumber, taskTitle: issue.title },
            rule: 'issue-shortfall',
            reason:
              `Issue #${issueNumber} was assessed as not delivered with cause "${shortfall.cause}", which routes to ` +
              `nobody the harness can dispatch.`,
          } satisfies RawAction);
          continue;
        }

        // Arms A and B spend a fleet, so a human authorizes them. The full
        // `proposalHold` applies — including the durable `rejected` arm, unlike a
        // plan proposal — because this row persists until its arm is performed, so
        // without it one refusal would be re-asked every pulse. It expires on world
        // signal like any other rejection.
        if (proposalHold('shortfall', ref, ctx.proposals ?? [], { rejectionSignals: ctx.rejectionSignals }) !== null)
          continue;
        // Both remaining arms transition a plan, so `routable` above already
        // established there is one; this is the narrowing, not a guard.
        if (!plan) continue;
        // Narrowed to the two routable causes by `shortfallArm` above; re-stated here
        // because the action's schema is narrower than the row's column.
        const cause = arm === 'replan' ? 'plan' : 'part';
        raw.push({
          type: 'propose_shortfall',
          originRef: shortfall.originRef,
          issueNumber,
          planId: plan.id,
          cause,
          partSlug: shortfall.partSlug,
          summary: shortfall.summary,
          prompt: this.templates.render('issue-shortfall', {
            number: issueNumber,
            title: issue.title,
            summary: shortfall.summary,
            consequence:
              cause === 'plan'
                ? 'Accepting sends the plan back to a planner, which sees the current decomposition and this ' +
                  'assessment and amends it. Nothing already in flight is retired.'
                : `Accepting appends one new part to the plan for the scope "${shortfall.partSlug}" fell short of. ` +
                  `That part is left exactly as it is — its branch is spent — and no other part is touched.`,
          }),
          rule: 'issue-shortfall',
          reason:
            `Issue #${issueNumber} was assessed as not delivered, with "${cause}" named as what fell short; ` +
            `acting on it spends agents, so it goes to you first.`,
        } satisfies RawAction);
      }
    };

    // Write up a goal the harness has parked as delivered.
    //
    // The Goal Floor's Manifest station has always named this step and the harness
    // has never taken it: the station drew `issue.conclusion?.note` or an em dash,
    // and nothing anywhere produced an account of the run. This is that account.
    //
    // Ranked after the assessor — an issue whose delivery is still being judged is
    // not one to write up — and it suppresses nothing, because a delivered issue is
    // already out of `issue-pickup` through `deliveryHold`. It gates nothing at all:
    // a goal is delivered whether or not anybody wrote it up, which is what makes
    // the fail-open below cost only the report.
    stages['issue-retro'] = () => {
      const written = new Set(ctx.retrospectiveOrigins ?? []);
      for (const issue of ctx.world.issues) {
        if (issueWatchGateReason(issue, this.pickup) !== null) continue;
        const root = issueOrigin(issue.number);
        if (written.has(root)) continue;
        // The harness's *own* park is the signal, not the tracker's `closed`: it is
        // what `deliveryHold` reads, and it exists precisely for the providers that
        // have no review state to move an item into.
        if (!deliveryParked(issue)) continue;
        // Anything live under the issue — a part, a late pickup, a previous retro
        // agent — means the run is not over yet.
        if ([...activeOrigins].some((o) => o === root || o.startsWith(`${root}:`))) continue;

        const origin = retroOrigin(issue.number);
        const verdict = dispatchVerdict(origin, now, ctx.recentDecisions, this.cooldown);
        // Fails open and *silent*, for the assayer's reason and more cheaply than
        // any of them: nothing is gated on a retrospective, so a spent cap costs the
        // write-up and nothing else. No escalation — there is nothing a human can do
        // about a report that did not happen that they cannot do by reading the issue.
        if (verdict.kind === 'escalate' || verdict.kind === 'hold') continue;

        const title = `Write up issue #${issue.number}`;
        const reason = `Issue #${issue.number} is delivered and has no retrospective; write the run up.`;
        candidates.push({
          origin,
          rule: 'issue-retro',
          title,
          kind: 'desk',
          // No branch and no worktree: it writes no files, and a checkout would only
          // be a temptation to start work on a goal that is finished.
          branch: null,
          reason,
          held: verdict.kind === 'cooldown' ? 'cooldown' : undefined,
          action: {
            type: 'dispatch_desk_agent',
            title,
            prompt: this.templates.render('issue-retro', {
              number: issue.number,
              title: issue.title,
              body: issue.body,
            }),
            originRef: origin,
            originTitle: issue.title,
            originSummary: issue.body,
            rule: 'issue-retro',
            reason,
          } satisfies RawAction,
        });
      }
    };

    // With `planning.requireApproval` on, a decomposition is a proposal before it
    // is work. Ingestion parks the verdict as `awaiting_approval` and this puts it
    // to the operator — once: the executor writes the proposal, and a pending one
    // holds this rule off the plan (`planProposalHold`, asked here *and* there for
    // the same reason `pr-merge-ready` and the executor both ask about a merge). It
    // claims no headroom; it starts nothing. Accepting releases the plan to
    // `active` and `plan-part` takes over on the next pulse.
    //
    // Read off `ctx.plans` rather than `eligibleIssues` for the same reason
    // `plan-part` is: a replan of an in-flight plan needs re-approving, and by then
    // the issue's parts have PRs, so the "no open PR" gate would hide it exactly
    // when the question matters most.
    stages['plan-approval'] = () => {
      for (const plan of ctx.plans ?? []) {
        if (plan.status !== 'awaiting_approval') continue;
        const issueNumber = planIssueNumber(plan.originRef);
        if (issueNumber === null) continue;
        const issue = ctx.world.issues.find((i) => i.number === issueNumber);
        if (!issue || issue.state !== 'open') continue;
        if (issueWatchGateReason(issue, this.pickup) !== null) continue;
        if (planProposalHold(planProposalRef(plan.originRef), ctx.proposals ?? []) !== null) continue;
        const parts = liveParts((ctx.planParts ?? []).filter((p) => p.planId === plan.id));
        raw.push({
          type: 'propose_plan',
          planId: plan.id,
          originRef: plan.originRef,
          // Appended, never interpolated, for `ciFailureNote`'s reason: an override
          // that never learned a `{warnings}` token would silently drop this on
          // exactly the deployments that customised most.
          prompt:
            this.templates.render('plan-approval', {
              number: issueNumber,
              title: issue.title,
              parts: parts.length,
              reason: plan.reason ?? 'the planner gave no reason',
              list: describeProposedParts(parts),
            }) + planApprovalWarnings(issue, parts, openPrs),
          rule: 'plan-approval',
          reason: `Issue #${issueNumber} was decomposed into ${parts.length} part(s) and approval is required before any of them is scheduled.`,
        } satisfies RawAction);
      }
    };

    // A released plan that is going nowhere. The reconciler already knows —
    // it blocks the parts and records the reason — but an error is a feed entry,
    // and a feed is not a question. Without this, an approved decomposition whose
    // parts all blocked showed two red machines, no agent, and nothing in "Needs
    // you"; the operator's own approval was the last thing that happened to it.
    //
    // Only `active` plans. An unapproved one is already in front of a human, and
    // `planApprovalWarnings` puts the same fact in that ask — escalating as well
    // would be the same sentence twice, to the same person, about a decomposition
    // they have not authorized.
    stages['plan-blocked'] = () => {
      for (const plan of ctx.plans ?? []) {
        if (plan.status !== 'active') continue;
        const issueNumber = planIssueNumber(plan.originRef);
        if (issueNumber === null) continue;
        const issue = ctx.world.issues.find((i) => i.number === issueNumber);
        if (!issue || issue.state !== 'open') continue;
        if (issueWatchGateReason(issue, this.pickup) !== null) continue;
        const parts = liveParts((ctx.planParts ?? []).filter((p) => p.planId === plan.id));
        if (!planIsWedged(parts)) continue;
        const wedgeOrigin = planOrigin(issueNumber);
        if (askedAlready(wedgeOrigin, ctx.openEscalations, ctx.recentDecisions)) continue;
        raw.push({
          type: 'escalate_to_human',
          escalationType: 'resolve_ambiguity',
          prompt: wedgedPlanPrompt(issueNumber, issue, parts),
          context: { originRef: wedgeOrigin, taskTitle: issue.title },
          rule: 'plan-blocked',
          reason: `Every part of issue #${issueNumber}'s approved plan is blocked, so nothing will be dispatched for it.`,
        } satisfies RawAction);
      }
    };

    // Schedule the parts of a decomposed issue — what makes a `parts` verdict mean
    // anything. Ranked *after* planners (a planner unblocks work) and *before*
    // one-shot pickups, and within that by dependency depth, so the bottom of a
    // stack is cut before the branch its dependents will base on is needed.
    //
    // Deliberately not driven off `eligibleIssues`: that list gates on the issue
    // having no open PR, and a part's PR is exactly what makes the parent issue
    // look taken. Parts inherit the issue's watch/ignore tag (evaluated once, on
    // the parent) and nothing else — see `issueWatchGateReason` for why the
    // workflow-state gate must not apply here.
    stages['plan-part'] = () => {
      const partCandidates: PartCandidate[] = [];
      for (const plan of ctx.plans ?? []) {
        // `awaiting_approval` is walked too, and dispatches nothing: its parts are
        // queued as `unapproved` so the hold is visible. Skipping the plan outright
        // would make an unapproved decomposition look like an idle fleet with no
        // work in it — the same invisibility that gave `capped` its name.
        const unapproved = plan.status === 'awaiting_approval';
        if (plan.status !== 'active' && !unapproved) continue; // complete/abandoned/single schedule nothing
        const issueNumber = planIssueNumber(plan.originRef);
        if (issueNumber === null) continue;
        const issue = ctx.world.issues.find((i) => i.number === issueNumber);
        if (!issue || issue.state !== 'open') continue;
        if (issueWatchGateReason(issue, this.pickup) !== null) continue;

        const parts = liveParts((ctx.planParts ?? []).filter((p) => p.planId === plan.id));
        const index = bySlug(parts);
        // The concurrency cap is on *agents*, so it counts live tasks rather than the
        // `dispatched` status — a part whose agent died is not occupying a slot.
        const inFlight = parts.filter((p) => activeOrigins.has(partOrigin(issueNumber, p.slug))).length;
        let room = this.planning.maxConcurrentPartsPerIssue - inFlight;
        const ready = parts
          .filter((p) => p.status === 'ready' && !activeOrigins.has(partOrigin(issueNumber, p.slug)))
          .map((part) => ({ part, depth: partDepth(part, index) }))
          .sort((a, b) => a.depth - b.depth || a.part.seq - b.part.seq);
        for (const { part, depth } of ready) {
          const origin = partOrigin(issueNumber, part.slug);
          // An unapproved plan is queued and nothing else: no cooldown arithmetic,
          // no attempt-cap escalation. Both would be answering "why did this part
          // not get an agent" with the wrong reason — it did not get one because
          // you have not approved the plan, and that is the only thing to say.
          if (unapproved) {
            partCandidates.push({
              depth,
              issueNumber,
              seq: part.seq,
              candidate: this.partCandidate(plan, issue, part, parts, index, issueNumber, 'unapproved'),
            });
            continue;
          }
          const verdict = dispatchVerdict(origin, now, ctx.recentDecisions, this.cooldown);
          // 'hold' (already escalated) must not eat a slot the plan could give to a
          // sibling — that is how one stuck part would stall a whole plan.
          if (verdict.kind === 'hold') continue;
          if (verdict.kind === 'escalate') {
            raw.push({
              type: 'escalate_to_human',
              escalationType: 'resolve_ambiguity',
              prompt: this.templates.render('plan-part-escalation', {
                number: issueNumber,
                part: part.title,
                attempts: verdict.attempts,
              }),
              context: { originRef: origin, taskTitle: part.title },
              rule: 'cooldown-escalate',
              reason: `Origin ${origin} hit the ${this.cooldown.maxAttempts}-attempt cap without producing a PR — escalating instead of looping.`,
            } satisfies RawAction);
            continue;
          }
          // Beyond the plan's own concurrency cap the part is *queued as capped*, not
          // skipped. Skipping made the cap invisible: a part with every dependency
          // satisfied and the whole fleet idle simply never appeared anywhere, and the
          // only way to find out why was to read `maxConcurrentPartsPerIssue`. It is
          // still never dispatched — the cut below treats a held candidate as held.
          const capped = room <= 0;
          if (!capped) room -= 1;
          const held = capped ? 'capped' : verdict.kind === 'cooldown' ? 'cooldown' : undefined;
          partCandidates.push({
            depth,
            issueNumber,
            seq: part.seq,
            candidate: this.partCandidate(plan, issue, part, parts, index, issueNumber, held),
          });
        }
      }
      partCandidates.sort((a, b) => a.depth - b.depth || a.issueNumber - b.issueNumber || a.seq - b.seq);
      for (const c of partCandidates) candidates.push(c.candidate);
    };

    // Resolve an open issue into a PR — the front of the issue → PR → merge loop,
    // and last in the pipeline because everything above it narrows it.
    stages['issue-pickup'] = () => {
      for (const { issue } of eligibleIssues) {
        // Narrowed by the funnel: an issue is picked up only once its plan says one
        // PR will do. Everything below is byte-for-byte what it was before the gate.
        if (routes.get(issue.number)?.route !== 'single') continue;
        const origin = `issue:${issue.number}`;
        // An agent already on this issue owns it — don't throttle/escalate over a
        // live attempt; the active-task de-dup handles it.
        if (activeOrigins.has(origin)) continue;
        // `issue-assess` is asking whether this issue is already finished and
        // `issue-assay` whether its goal can be worked from at all. Picking it up in
        // the same cycle would put a second agent on it to redo work the first is
        // still judging, or answer the assay's question by ignoring it. Both sets are
        // built once, above, so no two rules can hold different opinions about which
        // issues are in them.
        const supersededBy = assessing.has(issue.number)
          ? ('issue-assess' as const)
          : assaying.has(issue.number)
            ? ('issue-assay' as const)
            : null;
        const branch = issueBranch(issue.number);
        const reason = `Open issue #${issue.number} has no open PR and no agent is on it.`;
        const candidate: Candidate = {
          origin,
          rule: 'issue-pickup',
          title: `Resolve issue #${issue.number}`,
          kind: 'code',
          branch,
          reason,
          action: {
            type: 'dispatch_code_agent',
            branch,
            title: `Resolve issue #${issue.number}`,
            prompt: this.templates.render('issue-pickup', {
              number: issue.number,
              title: issue.title,
              body: issue.body,
              branch,
            }),
            originRef: origin,
            originTitle: issue.title,
            originSummary: issue.body,
            rule: 'issue-pickup',
            reason,
          } satisfies RawAction,
        };
        // Queued as held rather than skipped, and *not* routed through `consider`:
        // the cooldown has no bearing on a pickup that is not going out this cycle
        // for a different reason entirely, and escalating an attempt cap over a
        // suppressed dispatch would blame the pickup for the assay's turn.
        if (supersededBy) {
          candidates.push({ ...candidate, held: 'superseded', reason: supersededReason(supersededBy, reason) });
          continue;
        }
        consider(candidate, (attempts) => ({
          type: 'escalate_to_human',
          escalationType: 'resolve_ambiguity',
          prompt: this.templates.render('issue-pickup-escalation', {
            number: issue.number,
            title: issue.title,
            attempts,
          }),
          context: { originRef: origin, taskTitle: `Resolve issue #${issue.number}` },
          rule: 'cooldown-escalate',
          reason: `Origin ${origin} hit the ${this.cooldown.maxAttempts}-attempt cap without producing a PR — escalating instead of looping.`,
        }));
      }
    };

    // ---- The pipeline. -----------------------------------------------------
    //
    // This is the whole of the dispatcher's priority order, and the only place it
    // is written down. A rule runs when it is reached and its `enabled` predicate
    // says the operator has it on; an id with no stage was covered by an earlier
    // pass (see `stages`). Adding a rule is adding a registry entry in the position
    // it should run and a stage here — there is no third thing to keep in step, and
    // nothing renders a position, so inserting one renumbers nothing.
    const conditions: RuleConditions = {
      planning: this.planning.enabled,
      assessment: this.assessment.enabled,
      assay: this.assay.enabled,
      retrospective: this.retrospective.enabled,
      workItemStates: workItemStates !== null,
    };
    for (const rule of DISPATCH_PIPELINE) {
      if (rule.enabled && !rule.enabled(conditions)) continue;
      stages[rule.id]?.();
    }

    // Apply the operator's "Up next" re-ordering (issue #128) before the cut:
    // an override jumps a world item ahead of the natural cross-rule ranking,
    // but stays behind `manual-job` and never clears a `held` verdict — the cut
    // below still holds a held candidate wherever the override placed it.
    const overrideRank = new Map((ctx.priorityOverrides ?? []).map((o) => [o.origin, o.rank]));
    const ranked = rankByPriorityOverride(candidates, overrideRank);

    // The headroom cut: dispatch the above-cut prefix (each claiming a slot),
    // keep everything ranked as the visible queue. A cooling-down candidate is
    // shown but never dispatched, whatever the headroom.
    let headroom = ctx.agentHeadroom;
    const upcoming: QueueItem[] = [];
    for (const c of ranked) {
      if (activeOrigins.has(c.origin)) continue; // staffed — not "up next"
      const { origin, rule, title, kind, branch, reason } = c;
      if (c.held) {
        upcoming.push({ origin, rule, title, kind, branch, status: c.held, reason });
      } else if (headroom > 0) {
        raw.push(c.action);
        activeOrigins.add(origin);
        headroom -= 1;
        upcoming.push({ origin, rule, title, kind, branch, status: 'dispatching', reason });
      } else {
        upcoming.push({ origin, rule, title, kind, branch, status: 'waiting', reason });
      }
    }

    if (raw.length === 0) {
      raw.push({ type: 'no_op', rule: 'idle', reason: 'Nothing actionable this cycle.' } satisfies RawAction);
    }

    const parsed = parseActions(raw);
    return {
      ...parsed,
      rationale: buildRationale(parsed.actions),
      upcoming,
    };
  }

  /**
   * One part's dispatch candidate. The prompt carries what the siblings have done
   * and what is still to come — goal 3 of the multi-PR design, and the thing a
   * second agent on the same issue has never had.
   *
   * `base` is the branch this part stacks on, resolved from the dependency's state
   * (its branch while its PR is open, the integration branch once it merged) and
   * carried on the action so the executor cuts the worktree from it. Whether the
   * PR *body* states the plan context is left to the prompt: making it automatic
   * would need either a new outbound capability or an instruction the agent may
   * ignore anyway, and prompt-only degrades quietly rather than wrongly.
   */
  private partCandidate(
    plan: Plan,
    issue: { number: number; title: string },
    part: PlanPart,
    parts: PlanPart[],
    index: Map<string, PlanPart>,
    issueNumber: number,
    held: 'cooldown' | 'capped' | 'unapproved' | undefined,
  ): Candidate {
    const origin = partOrigin(issueNumber, part.slug);
    const branch = part.branch ?? partBranch(issueNumber, part.slug);
    const base = partBase(part, index, issueNumber, this.defaultBranch);
    const { done, remaining } = siblingContext(parts, part);
    const title = `Issue #${issueNumber} part: ${part.title}`;
    const stacks =
      base === this.defaultBranch
        ? `Part "${part.slug}" of issue #${issueNumber} is ready and has no agent.`
        : `Part "${part.slug}" of issue #${issueNumber} is ready and stacks on ${base}.`;
    const reason =
      held === 'capped'
        ? `${stacks} Held: issue #${issueNumber} is already at its ${this.planning.maxConcurrentPartsPerIssue}-part concurrency cap.`
        : held === 'unapproved'
          ? `${stacks} Held: the plan for issue #${issueNumber} is awaiting your approval — nothing is scheduled until you accept it.`
          : stacks;
    return {
      origin,
      rule: 'plan-part',
      title,
      kind: 'code',
      branch,
      reason,
      held,
      action: {
        type: 'dispatch_code_agent',
        branch,
        base,
        partId: part.id,
        title,
        // Appended, not interpolated: `loadPromptTemplates` rejects only *unknown*
        // placeholders, so an override that never learned a `{kind}` token would
        // silently drop the one instruction a non-code part needs to finish at all.
        prompt:
          this.templates.render('plan-part', {
            number: issueNumber,
            title: issue.title,
            part: part.title,
            scope: part.scope,
            branch,
            base,
            plan: plan.reason ?? 'the planner gave no reason',
            done,
            remaining,
          }) + partOutcomeNote(part),
        originRef: origin,
        originTitle: `${issue.title} — ${part.title}`,
        originSummary: part.scope,
        rule: 'plan-part',
        reason,
      } satisfies RawAction,
    };
  }
}

/** A part candidate awaiting the cross-plan depth ranking. */
interface PartCandidate {
  depth: number;
  issueNumber: number;
  seq: number;
  candidate: Candidate;
}

type RawAction = Record<string, unknown> & { type: string; reason: string; rule: DispatchRuleId };

/** One thing wrong with a PR that would warrant a code agent on its branch. */
interface PrConcern {
  /** Which dispatcher rule raised this concern, carried onto the emitted action. */
  rule: DispatchRuleId;
  origin: string;
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

/** A ranked agent-dispatch candidate awaiting the headroom cut. */
interface Candidate {
  origin: string;
  rule: DispatchRuleId;
  title: string;
  kind: 'code' | 'desk';
  branch: string | null;
  reason: string;
  action: RawAction;
  /**
   * Held this cycle for a reason that isn't fleet headroom — kept visible in the
   * queue, never dispatched. See {@link RuleHeld}; `waiting` is absent because
   * only the headroom cut can decide it.
   */
  held?: RuleHeld;
}

/**
 * Cross-PR rank of a concern class: CI beats base-update beats review comment.
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

/** Agent+origin pairs we've already notified, from executed respond_to_agent decisions. */
function notifiedOriginsByAgent(decisions: Decision[]): Set<string> {
  const set = new Set<string>();
  for (const d of decisions) {
    if (d.outcome !== 'executed') continue;
    const a = d.action;
    if (a.type !== 'respond_to_agent') continue;
    const agentId = a.agentId;
    const origins = a.originRefs;
    if (typeof agentId !== 'string' || !Array.isArray(origins)) continue;
    for (const o of origins) if (typeof o === 'string') set.add(`${agentId}::${o}`);
  }
  return set;
}

/**
 * Branch+signal pairs a dispatch has already put in front of an agent, from
 * executed `dispatch_code_agent` decisions carrying `signalRefs`.
 *
 * This exists because the review-comment concern dispatches on an origin
 * (`pr:<n>:comments`) that is *not* any one of the signals it folds, so
 * `activeOrigins` — which sees task origins only — cannot tell that the running
 * agent was launched with those three threads in its prompt. Without it every
 * thread an agent was dispatched to answer would be read back to it as news on the
 * next pulse. Keyed on the branch rather than the agent because the dispatch
 * decision is recorded before an agent exists to key on.
 *
 * Best-effort over the same recent-decision window `notified` uses, and harmless
 * in the same way: a dispatch that ages out costs one redundant note.
 */
function dispatchedSignalsByBranch(decisions: Decision[]): Set<string> {
  const set = new Set<string>();
  for (const d of decisions) {
    if (d.outcome !== 'executed') continue;
    const a = d.action;
    if (a.type !== 'dispatch_code_agent') continue;
    const branch = a.branch;
    const refs = a.signalRefs;
    if (typeof branch !== 'string' || !Array.isArray(refs)) continue;
    for (const r of refs) if (typeof r === 'string') set.add(`${branch}::${r}`);
  }
  return set;
}

function isActive(t: Task): boolean {
  return t.status === 'queued' || t.status === 'running' || t.status === 'waiting';
}

function buildRationale(actions: ValidatedAction[]): string {
  if (actions.length === 1 && actions[0]?.type === 'no_op') return 'Rule dispatcher: nothing actionable.';
  return `Rule dispatcher chose ${actions.length} action(s): ` + actions.map((a) => a.type).join(', ');
}
