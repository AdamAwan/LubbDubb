import type { Dispatcher, DispatchContext, DispatchResult, QueueItem } from './dispatcher.js';
import type { PrRefStyle } from '../prRef.js';
import type { ValidatedAction } from './actions.js';
import { parseActions } from './actions.js';
import type { Decision, Issue, ValidationCheck } from '../types.js';
import {
  effectivePickupStates,
  isIssuePickupEligible,
  issuePriority,
  openPrForIssue,
  type IssuePickupPolicy,
} from './issuePickup.js';
import { dispatchVerdict, DEFAULT_COOLDOWN, type CooldownPolicy } from './dispatchCooldown.js';
import { type CiPolicy } from '../ci/ciPolicy.js';
import { DISPATCH_PIPELINE, type DispatchRuleId, type RuleConditions, type StageRuleId } from './rules.js';
import { DEFAULT_PR_REVIEW, type PrReviewPolicy } from '../review/policy.js';
import type { PrReviewCharters } from '../review/prReview.js';
import { rankByPriorityOverride } from './priorityOverride.js';
import { expeditedOrigins } from './goalPriority.js';
import { redBaseChecks } from '../obstacles/ownership.js';
import { blockedGoals } from '../obstacles/blocked.js';
import { deliveryHold } from '../delivery/delivery.js';
import { candidateParents } from '../issueRelations.js';
import { appraisalHold } from '../intake/appraisal.js';
import { resolveModelTag } from '../modelLabels.js';
import { pinnedProfileFor } from '../profilePin.js';
import { resolveAgentProfile } from '../agents/modelPolicy.js';
import { prReadRef, refsFinishedSince } from '../world/readPlan.js';
import { DEFAULT_VALIDATION, type ValidationPolicy } from '../validation/policy.js';
import { PromptTemplates, defaultPromptTemplates } from './promptTemplates.js';
import {
  DEFAULT_PLANNING,
  issueOrigin,
  plannerVerdict,
  resolvePlanRoute,
  type PlanningPolicy,
  type PlanRouteVerdict,
} from '../plans/planning.js';
import { liveParts } from '../plans/parts.js';
import { isActive, type Candidate, type RawAction, type StageContext } from './rules/context.js';
import { manualJob } from './rules/manualJob.js';
import { obstacleRepair } from './rules/obstacleRepair.js';
import { prCiFailing } from './rules/prCiFailing.js';
import { prReviewTriage } from './rules/prReviewTriage.js';
import { workItemInReview } from './rules/workItemInReview.js';
import { workItemBackToPickup } from './rules/workItemBackToPickup.js';
import { workItemInProgress } from './rules/workItemInProgress.js';
import { issueAppraisal } from './rules/issueAppraisal.js';
import { issuePlan } from './rules/issuePlan.js';
import { issueAssess } from './rules/issueAssess.js';
import { issueShortfall } from './rules/issueShortfall.js';
import { issueRetro } from './rules/issueRetro.js';
import { planAmendment } from './rules/planAmendment.js';
import { planApproval } from './rules/planApproval.js';
import { planBlocked } from './rules/planBlocked.js';
import { planPart } from './rules/planPart.js';
import { issuePickup } from './rules/issuePickup.js';
import { validateCheck } from './rules/validateCheck.js';
import { featureSummary } from './rules/featureSummary.js';
import { validationFailed } from './rules/validationFailed.js';

/**
 * What each rule does, keyed by its id. The **order they run in is not here** —
 * it is {@link DISPATCH_PIPELINE}, walked in `decide`, and this map answers only
 * "what does that rule do". Splitting the two is the point: a rule's position used
 * to be its position in one long method's prose, with a hand-written number on the
 * registry entry claiming to mirror it, and the two had drifted.
 *
 * Each body lives in its own module under `rules/`, taking the {@link StageContext}
 * `decide` builds once. They were closures over some twenty locals of that method,
 * which made every one of those reads — and the two writes a later stage depends on
 * — invisible.
 *
 * `Partial` because an id here may be **covered by an earlier pass**: the four
 * PR-concern rules and `pr-merge-ready` share one walk over the open PRs, since at
 * most one agent works a branch and the fold that picks the top concern has to see
 * all of them together. That pass is registered under the first of them and the
 * rest map to nothing.
 */
const STAGES: Partial<Record<StageRuleId, (s: StageContext) => void>> = {
  'manual-job': manualJob,
  'obstacle-repair': obstacleRepair,
  'pr-review-triage': prReviewTriage,
  'pr-ci-failing': prCiFailing,
  'work-item-in-progress': workItemInProgress,
  'work-item-in-review': workItemInReview,
  'work-item-back-to-pickup': workItemBackToPickup,
  'issue-appraisal': issueAppraisal,
  'issue-plan': issuePlan,
  'issue-assess': issueAssess,
  'issue-shortfall': issueShortfall,
  'issue-retro': issueRetro,
  'plan-approval': planApproval,
  'plan-amendment': planAmendment,
  'plan-blocked': planBlocked,
  'plan-part': planPart,
  'issue-pickup': issuePickup,
  'validate-check': validateCheck,
  'validation-failed': validationFailed,
  'feature-summary': featureSummary,
};

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
 * - **Rules** propose work from the world. Each is a {@link STAGES} entry — a
 *   module under `rules/` — run when the walk reaches it and its `enabled`
 *   predicate passes.
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
 * Every branch produces actions with an explicit `reason` and tags
 * them with its rule id from the {@link DISPATCH_RULES} registry (`rules.ts`),
 * so the audit log can show *which rule* fired, not just a sentence.
 */
export class RuleDispatcher implements Dispatcher {
  private readonly pickup: IssuePickupPolicy;
  private readonly cooldown: CooldownPolicy;
  private readonly templates: PromptTemplates;
  private readonly defaultBranch: string;
  private readonly prRefStyle: PrRefStyle;
  /** Rendered above this, in the composition root — see {@link StageContext.watchNote}. */
  private readonly watchNote: string;
  /** The same, for the agent that does the work — see {@link StageContext.watchDeclareNote}. */
  private readonly watchDeclareNote: string;
  private readonly planning: PlanningPolicy;
  /** Only the one field any rule reads — see the constructor's narrowing below. */
  private readonly validation: Pick<ValidationPolicy, 'desktopClaimMinutes'>;
  private readonly validationRoot: string;
  private readonly review: PrReviewPolicy;
  private readonly reviewCharters: PrReviewCharters;
  private ci: CiPolicy;

  /**
   * `pickup` gates and orders issue pickup (`issue-pickup`). Omitted/partial => no
   * gate and flat priority, so `new RuleDispatcher()` keeps the pre-gate behaviour
   * of acting on every open issue (used by unit tests; the composition root passes
   * the operator's config). `cooldown` throttles re-dispatch of a persistent
   * concern (see {@link dispatchVerdict}); defaults keep the loop bounded.
   * `templates` supplies the agent/escalation prompt bodies; omitted => the
   * built-in defaults (the composition root loads operator overrides).
   * `defaultBranch` names the base a PR is assumed to target when the provider
   * doesn't report one, and only phrases the base-update prompt. `planning` carries
   * the funnel's pacing — the part-concurrency cap and the reconciliation fetch
   * floor; omitted means their defaults, never an absent funnel. `ci` decides
   * `pr-ci-failing` per failing check; omitted/empty means every failure is acted
   * on generically, which is what the rule did before per-check policy existed.
   * `prRefStyle` is how the configured provider links a pull request in prose;
   * omitted means `#`, which is right everywhere but Azure DevOps.
   *
   * The appraisal, the assessor and the retrospective take no policy at all: they are
   * unconditional, and the only thing that ever holds one is the state of the issue
   * in front of it.
   */
  constructor(
    pickup: Partial<IssuePickupPolicy> = {},
    cooldown: Partial<CooldownPolicy> = {},
    templates: PromptTemplates = defaultPromptTemplates(),
    defaultBranch = 'main',
    planning: Partial<PlanningPolicy> = {},
    ci: Partial<CiPolicy> = {},
    validation: Partial<ValidationPolicy> = {},
    validationRoot = '.lubbdubb/validation',
    prRefStyle: PrRefStyle = '#',
    review: Partial<PrReviewPolicy> = {},
    reviewCharters: PrReviewCharters = { routing: null, modes: {} },
    watchNote = '',
    watchDeclareNote = '',
  ) {
    this.watchNote = watchNote;
    this.watchDeclareNote = watchDeclareNote;
    this.review = { ...DEFAULT_PR_REVIEW, ...review };
    this.reviewCharters = reviewCharters;
    this.validation = {
      // An omitted *duration* is not a feature being switched off, and zero would
      // expire every claim the instant it was taken — so this falls back to the
      // operator default rather than to nothing.
      desktopClaimMinutes: validation.desktopClaimMinutes ?? DEFAULT_VALIDATION.desktopClaimMinutes,
    };
    this.validationRoot = validationRoot;
    this.defaultBranch = defaultBranch;
    this.prRefStyle = prRefStyle;
    this.ci = { checks: ci.checks ?? [] };
    this.planning = {
      maxConcurrentPartsPerIssue: planning.maxConcurrentPartsPerIssue ?? DEFAULT_PLANNING.maxConcurrentPartsPerIssue,
      // Reconciliation's knob, not the dispatcher's; carried so the policy stays one object.
      gitFetchIntervalMs: planning.gitFetchIntervalMs ?? DEFAULT_PLANNING.gitFetchIntervalMs,
    };
    this.templates = templates;
    // Spread, then default only the two fields that are required on the policy.
    // Re-listing the fields instead drops any the list has not learned about yet —
    // silently, since every one of them is optional and reads as `undefined` rather
    // than erroring. That is how `containerTypes` came to be honoured by the cockpit
    // and ignored by the dispatcher.
    this.pickup = {
      ...pickup,
      priorityLabels: pickup.priorityLabels ?? {},
      defaultPriority: pickup.defaultPriority ?? 0,
    };
    this.cooldown = {
      maxAttempts: cooldown.maxAttempts ?? DEFAULT_COOLDOWN.maxAttempts,
      cooldownMs: cooldown.cooldownMs ?? DEFAULT_COOLDOWN.cooldownMs,
    };
  }

  /**
   * Re-seat the CI policy on a running dispatcher.
   *
   * The constructor takes a *copy* (`{checks: ci.checks ?? []}`), so a config
   * reload that only assigned onto the config object would leave the cockpit
   * drawing one policy while this went on running another — silently, with
   * nothing red. This is the arm that makes `ci.checks` a live key.
   *
   * @public — reached structurally, as `CiPolicyHolder` in `src/configApply.ts`.
   */
  setCiPolicy(ci: CiPolicy): void {
    this.ci = { checks: ci.checks ?? [] };
  }

  async decide(ctx: DispatchContext): Promise<DispatchResult> {
    const s = this.stageContext(ctx);

    // ---- The pipeline. -----------------------------------------------------
    //
    // This is the whole of the dispatcher's priority order, and the only place it
    // is written down. A rule runs when it is reached and its `enabled` predicate
    // says the world can answer it; an id with no stage was covered by an earlier
    // pass (see {@link STAGES}). Adding a rule is adding a registry entry in the
    // position it should run and a stage module here — there is no third thing to
    // keep in step, and nothing renders a position, so inserting one renumbers
    // nothing.
    //
    // One condition remains, and it is about the *provider* rather than about a
    // policy: a work-item state rule has nothing to read where the tracker has no
    // state model to read it from.
    const conditions: RuleConditions = {
      workItemStates: s.workItemStates !== null,
      workItemInProgress: s.workItemInProgress !== null,
      // The one operator switch here, and it reads the same field
      // `needsFleetReview` does — the PR concerns share one stage, so this
      // decides what the pipeline *advertises* while the concern's own gate is
      // what holds it. One field underneath both, so they cannot disagree.
      review: this.review.enabled,
    };
    for (const rule of DISPATCH_PIPELINE) {
      if (rule.enabled && !rule.enabled(conditions)) continue;
      STAGES[rule.id]?.(s);
    }

    // Apply the operator's "Up next" re-ordering (issue #128) before the cut:
    // an override jumps a world item ahead of the natural cross-rule ranking,
    // but stays behind `manual-job` and never clears a `held` verdict — the cut
    // below still holds a held candidate wherever the override placed it.
    const overrideRank = new Map((ctx.priorityOverrides ?? []).map((o) => [o.origin, o.rank]));
    // A goal the operator marked a priority takes the tier above that drag, and
    // takes it for *every* origin its work is spread across — see `expeditedOrigins`
    // for why the flag has to be expanded rather than matched. Built from the same
    // `openPrs` the rules ranked against, so a PR the ignore tag hid from dispatch
    // cannot resolve to a different goal here than it did there.
    const expedited = expeditedOrigins(ctx.goalPriorities ?? [], {
      openPrs: s.openPrs,
      issues: ctx.world.issues,
      plans: ctx.plans ?? [],
      parts: ctx.planParts ?? [],
      // A flagged goal waiting on an obstacle is the strongest case there is for
      // lifting that obstacle's repair: the repair is the last thing between the
      // goal and any progress at all.
      obstacles: ctx.obstacles ?? [],
      obstacleBlocks: ctx.obstacleBlocks ?? [],
    });
    const ranked = rankByPriorityOverride(s.candidates, overrideRank, expedited);

    // The headroom cut: dispatch the above-cut prefix (each claiming a slot),
    // keep everything ranked as the visible queue. A cooling-down candidate is
    // shown but never dispatched, whatever the headroom.
    let headroom = ctx.agentHeadroom;
    // What one row says about its own price. A closure rather than three inline
    // copies because the three arms below differ in status and in nothing else,
    // and the arm that got a different answer would be the one nobody reads.
    const priceOf = (
      origin: string,
      rule: DispatchRuleId,
    ): Pick<QueueItem, 'profile' | 'profileSource' | 'override'> => {
      const override = s.profileOverrides.get(origin);
      const resolved = resolveAgentProfile(ctx.modelPins?.models, rule, s.pinFor(origin));
      return {
        profile: resolved?.name ?? null,
        ...(resolved ? { profileSource: resolved.source } : {}),
        ...(override === undefined ? {} : { override }),
      };
    };
    const upcoming: QueueItem[] = [];
    for (const c of ranked) {
      if (s.activeOrigins.has(c.origin)) continue; // staffed — not "up next"
      const { origin, rule, title, kind, branch, reason } = c;
      // Absent unless it is true, so an unflagged row keeps the shape it had.
      const flag = expedited(origin) ? { expedited: true } : {};
      // What this row would launch on, answered by the same two inputs and the
      // same function the dispatch itself resolves through — never a second
      // reading of the policy. A held or waiting row is priced too: "what will it
      // cost when it finally runs" is the whole question the operator is asking of
      // the row they are about to make cheaper.
      const priced = priceOf(origin, rule);
      if (c.held) {
        upcoming.push({ origin, rule, title, kind, branch, status: c.held, reason, ...flag, ...priced });
      } else if (headroom > 0) {
        // The one place a pin is stamped onto a dispatch. Every agent dispatch
        // routes through the candidate list — an inline `raw.push` of a
        // `dispatch_*` action bypasses the headroom cut and the Up next queue
        // already — so stamping here covers all of them and cannot be forgotten
        // by a new rule.
        s.raw.push(pinAction(c.action, s.pinFor(c.origin)));
        s.activeOrigins.add(origin);
        headroom -= 1;
        upcoming.push({ origin, rule, title, kind, branch, status: 'dispatching', reason, ...flag, ...priced });
      } else {
        upcoming.push({ origin, rule, title, kind, branch, status: 'waiting', reason, ...flag, ...priced });
      }
    }

    if (s.raw.length === 0) {
      s.raw.push({ type: 'no_op', rule: 'idle', reason: 'Nothing actionable this cycle.' } satisfies RawAction);
    }

    const parsed = parseActions(s.raw);
    return {
      ...parsed,
      rationale: buildRationale(parsed.actions),
      upcoming,
    };
  }

  /**
   * Everything the stages share, derived from the world once per cycle.
   *
   * This is the coupling the stage modules used to have implicitly, as closures
   * over this method's locals. Nothing here decides anything — every field is
   * either a collector the walk appends to, a projection of the world, or a
   * predicate several rules must answer identically (which is *why* each is
   * derived once: two rules re-deriving one of these is how they come to disagree
   * about an issue).
   */
  private stageContext(ctx: DispatchContext): StageContext {
    const raw: unknown[] = [];
    const activeOrigins = new Set(
      ctx.tasks.filter((t) => isActive(t) && t.originRef).map((t) => t.originRef as string),
    );
    // Work a requeue is redoing is in flight too, and its task says `job:<id>` —
    // the origin the rule that produced it keys on is on the job (issue #249).
    for (const job of ctx.standingJobs ?? []) if (job.originRef) activeOrigins.add(job.originRef);
    // Ranked agent-dispatch candidates in dispatch-priority order. The headroom
    // cut is applied *after* ranking (rank-then-slice), so below-cut candidates
    // survive as the visible "Up next" queue instead of being dropped (issue #69).
    const candidates: Candidate[] = [];
    // "Now" for cooldown arithmetic — the snapshot's own timestamp, so a cycle is
    // judged against when its world was observed, not wall-clock at decision time.
    const now = ctx.world.takenAt;

    // The plan funnel's memory, read by the work-item, plan and pickup rules alike
    // so none of them can hold a different opinion about an issue. Empty with the
    // funnel off.
    const plansByOrigin = new Map((ctx.plans ?? []).map((p) => [p.originRef, p]));

    // The operator's per-origin profile overrides, as a lookup. Read once for the
    // same reason the plans are: `pinFor` is called per candidate, and per-cycle
    // work that is per-candidate work is how a queue of thirty rows becomes thirty
    // linear scans.
    const profileOverrides = new Map((ctx.profileOverrides ?? []).map((o) => [o.origin, o.profile]));

    // The operator's pickup list with the state the harness writes itself folded
    // in — see `effectivePickupStates`. Every state gate below reads this; the one
    // that must not is `deliveryHold`, whose whole meaning is "a human moved it
    // back", which a harness write is not.
    const pickupStates = effectivePickupStates(this.pickup);

    // Every open PR the world knows about: the dispatch view plus the unwatched
    // ones hidden from it. Nothing acts on an unwatched PR — they are here only so
    // "no PR in the world" cannot be mistaken for "the PR merged", which would put a
    // second agent on an unwatched PR's own branch, and so a stack's base PR is
    // still found when it is one nobody opted in.
    const openPrs = ctx.hiddenPrs?.length ? [...ctx.world.pullRequests, ...ctx.hiddenPrs] : ctx.world.pullRequests;

    // The entities whose reading predates the fleet's own last act on them — built
    // over `openPrs` rather than the dispatch view, so the answer for one pull
    // request does not depend on whether another is watched.
    const behind = refsFinishedSince(ctx.tasks, openPrs, now);

    // Standing `delivered` verdicts, keyed on the `issue:<n>` origin. Unlike a
    // conclusion this one gates: an assessed issue is parked until the world moves
    // or the operator says otherwise. Asked through the same pure `deliveryHold`
    // the cockpit chip asks, so the two can never disagree about an issue.
    const deliveries = new Map((ctx.deliveries ?? []).map((d) => [d.originRef, d]));
    const deliveryParked = (issue: Issue): boolean =>
      deliveryHold(deliveries.get(issueOrigin(issue.number)) ?? null, issue, {
        pickupStates: this.pickup.pickupStates,
        signals: ctx.deliverySignals,
      }) !== null;

    // Standing goal appraisals, on the same origin again (issue #158). Where a delivery
    // verdict parks an issue that is *finished*, this parks one that could never be
    // started: only an explicit `unclear` holds, and a missing verdict holds nothing,
    // which is what makes an appraiser that crashed or spent its cap fail the issue
    // open to ordinary pickup. Asked through the same pure `appraisalHold` the cockpit
    // chip asks, so the two can never disagree about an issue.
    const appraisals = new Map((ctx.appraisals ?? []).map((a) => [a.originRef, a]));
    const appraisalParked = (issue: Issue): boolean =>
      appraisalHold(appraisals.get(issueOrigin(issue.number)) ?? null, issue, { signals: ctx.appraisalSignals }) !==
      null;

    // The goals an agent concluded `blocked` on, still behind an obstacle that
    // reaches agents. A third park beside the delivery and the appraisal, and the
    // one whose exit is not the issue at all: the goal comes back the moment the
    // obstacle stops reaching agents, which the ownership desk sweeps for on the
    // pulse. Asked through the same pure `blockedGoals` the desk asks, so the gate
    // and the sweep cannot disagree about which goals are parked.
    // → `docs/spec/32-obstacles.md#blocked-is-an-answer`
    const blocked = blockedGoals(ctx.obstacleBlocks ?? [], ctx.obstacles ?? []);

    // The runs in the issue list that the tracker has forgotten (issue #234).
    // Read by the rules that must not act on one — which is all of them but
    // `issue-assess` and `issue-retro` — each saying so in its own body.
    const retained = new Set(ctx.retainedIssues ?? []);

    // The issue-side world. Gate on *no open PR* rather than on `linkedPrNumber`
    // being unset: that field is sticky (the last PR to ever cross-reference the
    // issue), so gating on it retires an issue the first time any PR touches it,
    // even when the issue needs a second one. Also gate on the pickup label (when
    // configured) so operators can say "work these, leave the rest" — untagged
    // issues stay visible in the world, just unacted-on — and order by
    // label-encoded priority so the important ones claim limited headroom first
    // (tie-break by issue number for determinism).
    const eligibleIssues = ctx.world.issues
      .filter(
        (i) =>
          // A retained run is never eligible for anything this list feeds
          // (`issue-plan`, `issue-pickup`): the harness has already worked this
          // goal and the operator has not ended the run, so putting a fresh agent
          // on it is the one thing the union must not cause. Stated here rather
          // than left to `state === 'open'` below, which would be true by
          // coincidence — see {@link StageContext.retained}.
          !retained.has(i.number) &&
          i.state === 'open' &&
          openPrForIssue(i, openPrs) === null &&
          !deliveryParked(i) &&
          // The content gate, in front of both the planner and pickup: an issue
          // whose goal the appraisal could not work from is not eligible for either,
          // which is what stops a decomposition of a question nobody could answer.
          !appraisalParked(i) &&
          // An agent said it could not finish this goal because of something that
          // is not this goal, and named it. Picking it up again while that thing
          // still stands is the fleet queueing behind one obstacle instead of
          // spending its allowance on it.
          !blocked.has(issueOrigin(i.number)) &&
          isIssuePickupEligible(i, this.pickup).eligible,
      )
      .map((issue) => ({ issue, weight: issuePriority(issue.labels, this.pickup) }))
      .sort((a, b) => b.weight - a.weight || a.issue.number - b.issue.number);

    // Which arm of the plan funnel each eligible issue is on. Resolved once, from
    // the persisted plan plus the plan origin's own cooldown verdict, and shared by
    // `issue-plan` and `issue-pickup` so the two can never disagree about an issue.
    const routes = new Map<number, PlanRouteVerdict>();
    for (const { issue } of eligibleIssues) {
      const plan = plansByOrigin.get(issueOrigin(issue.number)) ?? null;
      routes.set(
        issue.number,
        resolvePlanRoute({
          plan,
          verdict: plannerVerdict(issue.number, plan, now, ctx.recentDecisions, this.cooldown),
          // A replan that spends its attempts falls back to the decomposition the
          // issue already has, not open to `single` — see `resolvePlanRoute`.
          existingParts: plan ? liveParts((ctx.planParts ?? []).filter((p) => p.planId === plan.id)).length : 0,
        }),
      );
    }

    // The validation plans, grouped by the goal they belong to.
    const validationChecks = new Map<string, ValidationCheck[]>();
    for (const check of ctx.validationChecks ?? []) {
      const group = validationChecks.get(check.originRef);
      if (group) group.push(check);
      else validationChecks.set(check.originRef, [check]);
    }

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

    return {
      ctx,
      now,
      raw,
      candidates,
      activeOrigins,
      // Origins we've already told a live agent about (from the audit log), so a
      // persistent signal isn't re-notified every cycle. Best-effort over the
      // recent decision window — a note that ages out is harmless (the agent just
      // gets told again).
      notified: notifiedOriginsByAgent(ctx.recentDecisions),
      // The signals each branch's dispatch already carried into an agent's prompt —
      // the half `notified` cannot see, since a dispatch is not a note.
      dispatchedSignals: dispatchedSignalsByBranch(ctx.recentDecisions),
      openPrs,
      readingBehindFleet: (prNumber: number) => behind.has(prReadRef(prNumber)),
      plansByOrigin,
      // Standing "is this issue finished" verdicts, keyed on the same `issue:<n>`
      // origin. Empty until someone declares one, which resolves every issue to
      // `undeclared` — the direction that stops rather than acts.
      conclusions: new Map((ctx.conclusions ?? []).map((c) => [c.originRef, c])),
      // The negative half of that verdict, on the same origin.
      // `work-item-back-to-pickup` resolves the two together or it reads the
      // assessor's "not delivered" as the working agent's `done` — and
      // `shortfallRecordedNote`'s no-cause arm promises this exact behaviour ("it
      // comes back round for pickup with your summary").
      shortfallsByOrigin: new Map((ctx.shortfalls ?? []).map((sf) => [sf.originRef, sf])),
      appraisals,
      retained,
      liveIssue: (issueNumber: number) =>
        retained.has(issueNumber) ? null : (ctx.world.issues.find((i) => i.number === issueNumber) ?? null),
      /**
       * Is this issue planned — i.e. owned by the part scheduler, not by pickup?
       *
       * The status answers it on its own. It briefly had to consult the parts as
       * well, back when a plan delivering one pull request carried none and was
       * scheduled by rule `issue-pickup`: an `active` plan could then be scheduling
       * nothing, and reading it as owned parked the work item in the review state
       * for the life of a plan with no parts to finish. Every plan has parts now,
       * so the second reading is gone with the shape that needed it.
       */
      partsPlanFor: (issueNumber: number) => {
        const plan = plansByOrigin.get(issueOrigin(issueNumber));
        if (!plan || (plan.status !== 'active' && plan.status !== 'complete')) return null;
        return plan;
      },
      deliveryParked,
      appraisalParked,
      // The pins, resolved from the operator's overrides, the world's own tags and
      // the plans' own parts. Every lookup is total and all of them answer null
      // when this deployment has no `agentModels` — see `pinnedProfileFor`.
      //
      // The override is consulted *outside* `pinnedProfileFor` rather than as a
      // fourth level inside it, because it is keyed on the whole origin and not on
      // the `issue:<n>` subtree: a queue row against `pr:<n>` — the conflict fix
      // this lever was asked for — has no goal and no part, and a level that only
      // answered for issues would leave exactly the rows an operator most wants to
      // price cheaply with a control that does nothing.
      profileOverrides,
      pinFor: (originRef: string | null) =>
        (originRef === null ? undefined : profileOverrides.get(originRef)) ??
        pinnedProfileFor(originRef, {
          goal: (issueNumber) =>
            resolveModelTag(
              ctx.world.issues.find((i) => i.number === issueNumber)?.labels,
              ctx.modelPins?.labelPrefix ?? '',
              ctx.modelPins?.models,
            ).profile,
          part: (issueNumber, slug) => {
            const plan = plansByOrigin.get(issueOrigin(issueNumber));
            if (!plan) return null;
            return (ctx.planParts ?? []).find((p) => p.planId === plan.id && p.slug === slug)?.profile ?? null;
          },
        }),
      eligibleIssues,
      // Derived from the whole world rather than the eligible subset: a feature an
      // orphan could hang off is a feature whether or not it is workable itself,
      // and most are visible only as some other item's parent.
      parentCandidates: candidateParents(ctx.world.issues, this.pickup.containerTypes),
      routes,
      validationChecks,
      // Written by `issue-appraisal` / `issue-assess`, read by the stages the pipeline
      // runs after them. See {@link StageContext} — the ordering is load-bearing.
      appraising: new Set<number>(),
      assessing: new Set<number>(),
      // The obstacle board, and the one reading of *which checks are red on a base*
      // that the ownership desk also takes — one function, so the rule and the desk
      // cannot hold different opinions about what is blocking the fleet.
      obstacles: ctx.obstacles ?? [],
      redBaseChecks: redBaseChecks(openPrs),
      consider,
      pickup: this.pickup,
      cooldown: this.cooldown,
      templates: this.templates,
      planning: this.planning,
      ci: this.ci,
      review: this.review,
      reviewCharters: this.reviewCharters,
      prReviewRoutes: new Map((ctx.prReviewRoutes ?? []).map((route) => [route.prNumber, route])),
      prReviews: new Map((ctx.prReviews ?? []).map((review) => [review.prNumber, review])),
      prReviewedElsewhere: ctx.prReviewedElsewhere ?? new Set<number>(),
      defaultBranch: this.defaultBranch,
      prRefStyle: this.prRefStyle,
      watchNote: this.watchNote,
      watchDeclareNote: this.watchDeclareNote,
      validationRoot: this.validationRoot,
      validationClaimMinutes: this.validation.desktopClaimMinutes,
      // `workItemStates` narrows both work-item rules' config to non-null. Narrowed
      // once, here, so each stage reads it off a value the type system already
      // knows is present — and the same predicate is what the registry's `enabled`
      // condition switches those two rules in on. The states are the *effective*
      // ones, so an item parked in the in-progress state is still one these rules
      // can move on.
      workItemStates:
        this.pickup.inReviewState && pickupStates?.length
          ? { inReviewState: this.pickup.inReviewState, pickupStates }
          : null,
      // The same fold, and the reason `work-item-in-progress` can move an item
      // somewhere `work-item-in-review` will still find it.
      workItemInProgress:
        this.pickup.inProgressState && pickupStates?.length
          ? { inProgressState: this.pickup.inProgressState, pickupStates }
          : null,
    };
  }
}

/** Agent+origin pairs we've already notified, from executed respond_to_agent decisions. */
/**
 * Carry the origin's pin onto the action about to be dispatched.
 *
 * Absent rather than null when there is no pin, so an unpinned dispatch produces
 * exactly the action it produced before pins existed and no test asserting on a
 * whole action object has to learn about a field it does not care about.
 */
function pinAction(action: RawAction, profile: string | null): RawAction {
  return profile === null ? action : { ...action, profile };
}

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

function buildRationale(actions: ValidatedAction[]): string {
  if (actions.length === 1 && actions[0]?.type === 'no_op') return 'Rule dispatcher: nothing actionable.';
  return `Rule dispatcher chose ${actions.length} action(s): ` + actions.map((a) => a.type).join(', ');
}
