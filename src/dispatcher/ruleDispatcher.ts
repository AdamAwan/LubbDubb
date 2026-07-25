import type { Dispatcher, DispatchContext, DispatchResult, QueueItem } from './dispatcher.js';
import type { ValidatedAction } from './actions.js';
import { parseActions } from './actions.js';
import { inheritedCiFailure, isStackedPr, needsBaseUpdate } from '../prHealth.js';
import type { Agent, Decision, Plan, PlanPart, PullRequest, Task } from '../types.js';
import {
  isIssuePickupEligible,
  issueBranch,
  issuePriority,
  issueWatchGateReason,
  openPrForIssue,
  watchGateReason,
  type IssuePickupPolicy,
} from './issuePickup.js';
import { dispatchVerdict, DEFAULT_COOLDOWN, type CooldownPolicy } from './dispatchCooldown.js';
import type { DispatchRuleId } from './rules.js';
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
import {
  bySlug,
  currentPlanSummary,
  liveParts,
  partBase,
  partBranch,
  partDepth,
  partOrigin,
  planIssueNumber,
  siblingContext,
} from '../plans/parts.js';

/**
 * A deterministic, dependency-free dispatcher that encodes the harness's default
 * priorities directly from the product vision:
 *
 *   1. A PR's CI is failing        -> spin up a code agent to fix it
 *   2. A PR's base is out of date  -> code agent to merge base in (resolve
 *                                     conflicts if 'dirty', clean update if 'behind')
 *   2b. A PR has an unhandled comment -> spin up a code agent to address it
 *   3. A PR is green/approved/mergeable -> merge it in (gated by auto-send)
 *   3b. A work item's state lags its PR -> move it to/from the review state
 *   3c. A watched open issue has no plan -> planning agent (funnel, off by default)
 *   4. An open issue has no open PR   -> code agent to resolve it into a PR
 *
 * At most one code agent works a given PR branch: when a fresh signal lands on a
 * branch that already has a *running* agent, it's delivered to that agent via
 * `respond_to_agent` (deduped through `recentDecisions`) rather than spawning a
 * second one; while the branch's agent is `waiting`, the note is held so a
 * pending human escalation is never disturbed.
 *   5. A ready story lacks a description / acceptance criteria -> desk agent to groom
 *   6. A ready story lacks WAF pillars -> desk agent to fill them
 *   7. Nothing else in flight        -> pick up the highest-priority ready story
 *   8. Otherwise                     -> no_op (recorded, so idleness is auditable)
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
   * behaviour exactly as it is without plans.
   */
  constructor(
    pickup: Partial<IssuePickupPolicy> = {},
    cooldown: Partial<CooldownPolicy> = {},
    templates: PromptTemplates = defaultPromptTemplates(),
    defaultBranch = 'main',
    planning: Partial<PlanningPolicy> = {},
  ) {
    this.defaultBranch = defaultBranch;
    this.planning = {
      enabled: planning.enabled ?? DEFAULT_PLANNING.enabled,
      maxConcurrentPartsPerIssue: planning.maxConcurrentPartsPerIssue ?? DEFAULT_PLANNING.maxConcurrentPartsPerIssue,
      // Reconciliation's knob, not the dispatcher's; carried so the policy stays one object.
      gitFetchIntervalMs: planning.gitFetchIntervalMs ?? DEFAULT_PLANNING.gitFetchIntervalMs,
    };
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

    // 0: Operator-launched jobs outrank every world-driven rule. Queue them
    // first (oldest-first) so the headroom cut below dispatches them ahead of
    // every world-driven candidate — a manual request wins the next free slot;
    // one that doesn't fit stays in the queue as `waiting` and is retried next
    // cycle. No cooldown throttle applies (a job is a one-shot request, not a
    // persistent signal): once dispatched it's marked so and leaves the queue.
    // The `jobId` rides on the action so the executor marks the job dispatched
    // only once its agent actually spawns.
    for (const job of ctx.queuedJobs) {
      const origin = `job:${job.id}`;
      if (activeOrigins.has(origin)) continue;
      const branch = job.kind === 'code' ? (job.branch ?? `job/${job.id}`) : null;
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

    // The plan funnel's memory, read by rules 3b, 3c, 4 and 4a alike so none of
    // them can hold a different opinion about an issue. Empty with the funnel off.
    const plansByOrigin = new Map((ctx.plans ?? []).map((p) => [p.originRef, p]));
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

    // 1–3: React to PR signals first — they're time-sensitive. At most one code
    // agent works a given branch, so a fresh signal for a branch that already
    // has a running agent is delivered to it, never a second dispatch. Dispatch
    // candidates are collected here and ranked across PRs below — world order is
    // arbitrary, so it must not decide who wins scarce headroom.
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
      if (pr.ciStatus === 'failing' && inheritedFailure === null) {
        concerns.push({
          rule: 'pr-ci-failing',
          origin: `pr:${pr.number}:ci`,
          title: `Fix failing CI on PR #${pr.number}`,
          prompt: this.templates.render('pr-ci-fix', { number: pr.number, title: pr.title, branch: pr.branch }),
          dispatchReason: `PR #${pr.number} has failing CI and no agent is on it.`,
          note: `CI is now failing on PR #${pr.number} — investigate and push a fix.`,
          originTitle: pr.title,
          originSummary: `PR #${pr.number} on branch ${pr.branch} · CI ${pr.ciStatus}${pr.approved ? ' · approved' : ''}`,
        });
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
      for (const comment of pr.unresolvedComments) {
        if (comment.handled) continue;
        concerns.push({
          rule: 'pr-review-comment',
          origin: `pr:${pr.number}:comment:${comment.id}`,
          title: `Address review comment on PR #${pr.number}`,
          prompt: this.templates.render('pr-review-comment', {
            number: pr.number,
            branch: pr.branch,
            author: comment.author,
            comment: comment.body,
          }),
          dispatchReason: `Unhandled review comment from ${comment.author} on PR #${pr.number}.`,
          note: `New review comment from ${comment.author} on PR #${pr.number}: "${comment.body}" — address it or prepare a reply.`,
          originTitle: pr.title,
          originSummary: `Review comment from ${comment.author}: ${comment.body}`,
        });
      }

      if (concerns.length > 0) {
        const branch = resolveBranchAgent(ctx, pr.branch);
        if (branch.kind === 'running') {
          // A running agent already owns this branch — notify it, don't duplicate.
          // Collapse all fresh, not-yet-notified concerns into one note.
          const fresh = concerns.filter(
            (c) => !activeOrigins.has(c.origin) && !notified.has(`${branch.agent.id}::${c.origin}`),
          );
          if (fresh.length > 0) {
            raw.push({
              type: 'respond_to_agent',
              agentId: branch.agent.id,
              response:
                `An update on the branch you're working (PR #${pr.number}):\n` +
                fresh.map((c) => `- ${c.note}`).join('\n'),
              originRefs: fresh.map((c) => c.origin),
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
      if (mergeReady) {
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

    // Cross-PR ranking: the most urgent concern class first (CI > base-update >
    // review comment), tie-break by PR number for determinism.
    prCandidates.sort((a, b) => concernUrgency(a.top.rule) - concernUrgency(b.top.rule) || a.pr.number - b.pr.number);
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

    // 3b: Keep a work item's state in step with whether a PR is open for it. An
    // item in a pickup state ("Ready"/"Doing") with an open PR moves to the review
    // state, so it isn't re-picked while it waits on CI/review; the inverse moves
    // an item parked in the review state back to the *first* pickup state once its
    // PR is no longer open, so work left over after that PR merged can be picked up
    // instead of the item staying parked forever. Both directions are idempotent
    // (after either move the item no longer matches) and neither fires on a closed
    // item. Opt-in — off unless the operator set both a review state and pickup
    // states, and only for items carrying a native state (Azure work items; GitHub
    // issues have none, so this is a no-op for them).
    const { inReviewState, pickupStates } = this.pickup;
    if (inReviewState && pickupStates && pickupStates.length > 0) {
      // No separate config for where an item returns to: the first pickup state is
      // the operator's own "start here" (e.g. "Ready" in ["Ready","Doing"]).
      const returnState = pickupStates[0]!;
      for (const issue of ctx.world.issues) {
        const state = issue.workItemState;
        if (state === undefined || issue.state !== 'open') continue;
        // The agent for issue N works branch `issue/N` (see rule 4), so its PR lands
        // on that branch — the reliable link even when Azure hasn't wired the
        // ArtifactLink relation. `openPrForIssue` falls back to the linked-PR number.
        const pr = openPrForIssue(issue, openPrs);
        // A decomposed item belongs in the review state for the whole life of its
        // plan: it isn't waiting on one PR, it's waiting on several, and the inverse
        // below would bounce it back to "Ready" in every gap between parts — and
        // again the moment the last one merges. This is also the design's
        // "completion moves an Azure work item to the review state", reusing the
        // action rather than inventing a second path to it.
        const decomposed = partsPlanFor(issue.number) !== null;
        if (pickupStates.includes(state)) {
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
        } else if (state === inReviewState && !pr && !decomposed) {
          raw.push({
            type: 'set_work_item_state',
            number: issue.number,
            state: returnState,
            rule: 'work-item-back-to-pickup',
            reason: `Work item #${issue.number} is still open in "${inReviewState}" with no open PR; move it back to "${returnState}" so remaining work can be picked up.`,
          } satisfies RawAction);
        }
      }
    }

    // 4: Resolve open GitHub issues into PRs — the front of the issue → PR → merge loop.
    // Gate on *no open PR* rather than on `linkedPrNumber` being unset: that field is
    // sticky (the last PR to ever cross-reference the issue), so gating on it retires
    // an issue the first time any PR touches it, even when the issue needs a second
    // one. Also gate on the pickup label (when configured) so operators can say "work
    // these, leave the rest" — untagged issues stay visible in the world, just
    // unacted-on — and order by label-encoded priority so the important ones claim
    // limited headroom first (tie-break by issue number for determinism).
    const eligibleIssues = ctx.world.issues
      .filter(
        (i) =>
          i.state === 'open' && openPrForIssue(i, openPrs) === null && isIssuePickupEligible(i, this.pickup).eligible,
      )
      .map((issue) => ({ issue, weight: issuePriority(issue.labels, this.pickup) }))
      .sort((a, b) => b.weight - a.weight || a.issue.number - b.issue.number);

    // Which arm of the plan funnel each eligible issue is on. Resolved once, from
    // the persisted plan plus the plan origin's own cooldown verdict, and shared by
    // rules 3c and 4 so the two can never disagree about an issue. With planning
    // disabled every issue routes to `single`, so rule 4 below is un-narrowed.
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

    // 3c: Put a planning agent in front of pickup. It reads the repo and writes a
    // verdict — one PR or several — which is what makes today's one-agent/one-PR
    // path an explicit outcome of the funnel rather than a bypass. Queued ahead of
    // rule 4's pickups because a planner *unblocks* work, so it should win a scarce
    // slot before the work it unblocks. There is no escalation arm: a planner that
    // spends its attempt cap without producing a plan fails the issue open to
    // `single` (see `resolvePlanRoute`), so a failure never parks an issue.
    for (const { issue } of eligibleIssues) {
      const route = routes.get(issue.number);
      if (route?.route !== 'planning') continue;
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
      const title = replan ? `Replan issue #${issue.number}` : `Plan issue #${issue.number}`;
      const reason = replan
        ? `Issue #${issue.number} was sent back for replanning; plan it again from its current state.`
        : `Open issue #${issue.number} has no plan yet; plan it before dispatching work.`;
      candidates.push({
        origin,
        rule: 'issue-plan',
        title,
        kind: 'code',
        branch,
        reason,
        // Throttled like any other origin — kept visible in the queue, not dispatched.
        held: route.planner === 'cooldown' ? 'cooldown' : undefined,
        action: {
          type: 'dispatch_code_agent',
          branch,
          title,
          prompt: replan
            ? this.templates.render('issue-replan', {
                number: issue.number,
                title: issue.title,
                body: issue.body,
                branch,
                planFile: PLAN_FILE,
                current: currentPlanSummary(
                  existing,
                  (ctx.planParts ?? []).filter((p) => p.planId === existing.id),
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

    // 4a: Schedule the parts of a decomposed issue — what makes a `parts` verdict
    // mean anything. Ranked *after* planners (a planner unblocks work) and *before*
    // one-shot pickups, and within that by dependency depth, so the bottom of a
    // stack is cut before the branch its dependents will base on is needed.
    //
    // Deliberately not driven off `eligibleIssues`: that list gates on the issue
    // having no open PR, and a part's PR is exactly what makes the parent issue
    // look taken. Parts inherit the issue's watch/ignore tag (evaluated once, on
    // the parent) and nothing else — see `issueWatchGateReason` for why the
    // workflow-state gate must not apply here.
    const partCandidates: PartCandidate[] = [];
    for (const plan of this.planning.enabled ? (ctx.plans ?? []) : []) {
      if (plan.status !== 'active') continue; // complete/abandoned/single schedule nothing
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

    for (const { issue } of eligibleIssues) {
      // Narrowed by the funnel: an issue is picked up only once its plan says one
      // PR will do. Everything below is byte-for-byte what it was before the gate.
      if (routes.get(issue.number)?.route !== 'single') continue;
      const origin = `issue:${issue.number}`;
      // An agent already on this issue owns it — don't throttle/escalate over a
      // live attempt; the active-task de-dup handles it.
      if (activeOrigins.has(origin)) continue;
      const branch = issueBranch(issue.number);
      const reason = `Open issue #${issue.number} has no open PR and no agent is on it.`;
      consider(
        {
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
        },
        (attempts) => ({
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
        }),
      );
    }

    // 5 & 6: Backlog hygiene on ready stories. Stories are opt-in like issues —
    // an unwatched or ignored story is left alone (no-op when no watch label is
    // configured, so the default behaviour of acting on every ready story holds).
    for (const story of ctx.world.stories) {
      if (story.state !== 'ready') continue;
      if (watchGateReason(story.labels ?? [], this.pickup) !== null) continue;

      if (!story.description || !story.acceptanceCriteria) {
        candidates.push({
          origin: `story:${story.id}:groom`,
          rule: 'story-groom',
          title: `Groom story "${story.title}"`,
          kind: 'desk',
          branch: null,
          reason: `Ready story "${story.title}" lacks description/acceptance criteria.`,
          action: {
            type: 'dispatch_desk_agent',
            title: `Groom story "${story.title}"`,
            prompt: this.templates.render('story-groom', {
              title: story.title,
              missing: `${!story.description ? 'a description' : ''}${!story.description && !story.acceptanceCriteria ? ' and ' : ''}${!story.acceptanceCriteria ? 'acceptance criteria' : ''}`,
            }),
            originRef: `story:${story.id}:groom`,
            originTitle: story.title,
            originSummary: story.description,
            rule: 'story-groom',
            reason: `Ready story "${story.title}" lacks description/acceptance criteria.`,
          } satisfies RawAction,
        });
      }

      if (story.wafPillars.length === 0) {
        candidates.push({
          origin: `story:${story.id}:waf`,
          rule: 'story-waf',
          title: `Fill WAF pillars for "${story.title}"`,
          kind: 'desk',
          branch: null,
          reason: `Ready story "${story.title}" has no WAF pillars.`,
          action: {
            type: 'dispatch_desk_agent',
            title: `Fill WAF pillars for "${story.title}"`,
            prompt: this.templates.render('story-waf', { title: story.title }),
            originRef: `story:${story.id}:waf`,
            originTitle: story.title,
            originSummary: story.description,
            rule: 'story-waf',
            reason: `Ready story "${story.title}" has no WAF pillars.`,
          } satisfies RawAction,
        });
      }
    }

    // 7: With capacity left after everything above, pick up the highest-priority
    // groomed story. Ranked last, so at zero headroom it queues as "waiting"
    // instead of silently vanishing.
    const candidateStory = ctx.world.stories
      .filter(
        (s) =>
          s.state === 'ready' &&
          s.description &&
          s.acceptanceCriteria &&
          watchGateReason(s.labels ?? [], this.pickup) === null,
      )
      .sort((a, b) => b.priority - a.priority)[0];
    if (candidateStory) {
      candidates.push({
        origin: `story:${candidateStory.id}:work`,
        rule: 'story-pickup',
        title: `Implement "${candidateStory.title}"`,
        kind: 'code',
        branch: `story/${candidateStory.id}`,
        reason: `Idle capacity; "${candidateStory.title}" is the highest-priority ready story.`,
        action: {
          type: 'dispatch_code_agent',
          branch: `story/${candidateStory.id}`,
          title: `Implement "${candidateStory.title}"`,
          prompt: this.templates.render('story-pickup', {
            title: candidateStory.title,
            // Guaranteed present by the filter above; coerce for the string-typed template var.
            description: candidateStory.description ?? '',
            acceptanceCriteria: candidateStory.acceptanceCriteria ?? '',
          }),
          originRef: `story:${candidateStory.id}:work`,
          originTitle: candidateStory.title,
          originSummary: candidateStory.description,
          rule: 'story-pickup',
          reason: `Idle capacity; "${candidateStory.title}" is the highest-priority ready story.`,
        } satisfies RawAction,
      });
    }

    // The headroom cut: dispatch the above-cut prefix (each claiming a slot),
    // keep everything ranked as the visible queue. A cooling-down candidate is
    // shown but never dispatched, whatever the headroom.
    let headroom = ctx.agentHeadroom;
    const upcoming: QueueItem[] = [];
    for (const c of candidates) {
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
    held: 'cooldown' | 'capped' | undefined,
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
        prompt: this.templates.render('plan-part', {
          number: issueNumber,
          title: issue.title,
          part: part.title,
          scope: part.scope,
          branch,
          base,
          plan: plan.reason ?? 'the planner gave no reason',
          done,
          remaining,
        }),
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
   * queue, never dispatched. `cooldown` is the per-origin re-dispatch throttle;
   * `capped` is a per-plan concurrency limit (`maxConcurrentPartsPerIssue`).
   */
  held?: 'cooldown' | 'capped';
}

/** Cross-PR rank of a concern class: CI beats base-update beats review comment. */
function concernUrgency(rule: DispatchRuleId): number {
  if (rule === 'pr-ci-failing') return 0;
  if (rule === 'pr-base-update') return 1;
  return 2; // 'pr-review-comment'
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

function isActive(t: Task): boolean {
  return t.status === 'queued' || t.status === 'running' || t.status === 'waiting';
}

function buildRationale(actions: ValidatedAction[]): string {
  if (actions.length === 1 && actions[0]?.type === 'no_op') return 'Rule dispatcher: nothing actionable.';
  return `Rule dispatcher chose ${actions.length} action(s): ` + actions.map((a) => a.type).join(', ');
}
