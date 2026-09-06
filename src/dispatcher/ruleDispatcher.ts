import type { Dispatcher, DispatchContext, DispatchResult, QueueItem } from './dispatcher.js';
import type { PrRefStyle } from '../prRef.js';
import type { ValidatedAction } from './actions.js';
import { parseActions } from './actions.js';
import type { Decision, Issue, ValidationCheck } from '../types.js';
import {
  effectivePickupStates,
  isIssuePickupEligible,
  issueWatchGateReason,
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
import { linkEdges, sequenceReadiness } from '../sequence/readiness.js';
import { sequenceableFeatures as sequenceable, DEFAULT_SEQUENCE_MAX_CHILDREN } from '../sequence/sequence.js';
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
import { localValidation } from './rules/localValidation.js';
import { localValidationFix } from './rules/localValidationFix.js';
import { validateCheck } from './rules/validateCheck.js';
import { DEFAULT_LOCAL_VALIDATION, type LocalValidationPolicy } from '../localValidation/policy.js';
import { featureSummary } from './rules/featureSummary.js';
import { featureSequence } from './rules/featureSequence.js';
import { validationFailed } from './rules/validationFailed.js';

/**
 * What each rule does, keyed by its id. The order they run in is NOT here — it is
 * {@link DISPATCH_PIPELINE}, walked in `decide`; this map only answers "what does that rule do".
 * `Partial` because an id may be covered by an earlier pass: the four PR-concern rules and
 * `pr-merge-ready` share one walk over the open PRs, registered under the first of them, since
 * at most one agent works a branch and the concern fold must see them all.
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
  'local-validation': localValidation,
  'local-validation-fix': localValidationFix,
  'validate-check': validateCheck,
  'validation-failed': validationFailed,
  'feature-summary': featureSummary,
  'feature-sequence': featureSequence,
};

/**
 * A deterministic, dependency-free dispatcher that encodes the harness's default priorities.
 *
 * What it does, and in what order, is NOT written here — the pipeline is `DISPATCH_PIPELINE` in
 * `rules.ts` (named, described, ordered, each carrying its own operator switch), and `decide`
 * walks that array. Rules propose work from the world (a {@link STAGES} entry, run when the walk
 * reaches it and its `enabled` predicate passes); admission decides what becomes of a proposal —
 * dispatch, a note to the agent on the branch, an escalation at the attempt cap, or a named hold
 * (`admission.ts`).
 *
 * At most one code agent works a given PR branch: a fresh signal on a branch with a running
 * agent is delivered by `respond_to_agent` (deduped through `recentDecisions`) rather than
 * spawning a second; while that agent is `waiting`, the note is held. Every action carries a
 * `reason` and its rule id.
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
  private readonly localValidation: () => LocalValidationPolicy;
  private readonly review: PrReviewPolicy;
  private readonly reviewCharters: PrReviewCharters;
  private ci: CiPolicy;

  /**
   * `pickup` gates and orders issue pickup; omitted/partial means no gate and flat priority
   * (unit tests only — the composition root passes the operator's config). `cooldown` throttles
   * re-dispatch of a persistent concern; `ci` decides `pr-ci-failing` per check, empty acts on
   * every failure generically; `prRefStyle` is `#` everywhere but Azure DevOps. The appraisal,
   * assessor and retrospective take no policy at all — unconditional, held only by the issue's state.
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
    localValidation: () => LocalValidationPolicy = () => DEFAULT_LOCAL_VALIDATION,
  ) {
    this.watchNote = watchNote;
    this.watchDeclareNote = watchDeclareNote;
    this.review = { ...DEFAULT_PR_REVIEW, ...review };
    this.reviewCharters = reviewCharters;
    this.validation = {
      // An omitted duration is not the feature off, and zero would expire every claim instantly.
      desktopClaimMinutes: validation.desktopClaimMinutes ?? DEFAULT_VALIDATION.desktopClaimMinutes,
    };
    this.validationRoot = validationRoot;
    this.localValidation = localValidation;
    this.defaultBranch = defaultBranch;
    this.prRefStyle = prRefStyle;
    this.ci = { checks: ci.checks ?? [] };
    this.planning = {
      maxConcurrentPartsPerIssue: planning.maxConcurrentPartsPerIssue ?? DEFAULT_PLANNING.maxConcurrentPartsPerIssue,
      gitFetchIntervalMs: planning.gitFetchIntervalMs ?? DEFAULT_PLANNING.gitFetchIntervalMs,
    };
    this.templates = templates;
    // Spread, then default only the two required fields — re-listing them would silently
    // drop any field the list hasn't learned about yet.
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
   * Re-seat the CI policy on a running dispatcher. The constructor takes a copy, so without
   * this a config reload leaves the cockpit drawing one policy while this ran another.
   *
   * @public — reached structurally, as `CiPolicyHolder` in `src/configApply.ts`.
   */
  setCiPolicy(ci: CiPolicy): void {
    this.ci = { checks: ci.checks ?? [] };
  }

  async decide(ctx: DispatchContext): Promise<DispatchResult> {
    const s = this.stageContext(ctx);

    // ---- The pipeline. -----------------------------------------------------
    // The dispatcher's priority order lives in `DISPATCH_PIPELINE` and nowhere else. A rule
    // runs when the walk reaches it and its `enabled` predicate passes; an id with no stage was
    // covered by an earlier pass (see {@link STAGES}). Adding a rule is a registry entry plus a
    // stage module here.
    const conditions: RuleConditions = {
      workItemStates: s.workItemStates !== null,
      workItemInProgress: s.workItemInProgress !== null,
      // The one operator switch here, off the same field `needsFleetReview` reads.
      review: this.review.enabled,
      // `full` alone: at `links` every edge was drawn by a person, nothing for an agent to propose.
      sequencer: this.pickup.sequencing === 'full',
    };
    for (const rule of DISPATCH_PIPELINE) {
      if (rule.enabled && !rule.enabled(conditions)) continue;
      STAGES[rule.id]?.(s);
    }

    // The operator's "Up next" re-ordering, applied before the cut: jumps a world item ahead of
    // the cross-rule ranking, stays behind `manual-job`, never clears a `held` verdict.
    const overrideRank = new Map((ctx.priorityOverrides ?? []).map((o) => [o.origin, o.rank]));
    // A flagged goal takes the tier above that drag, for every origin its work is spread
    // across. Built from the same `openPrs` the rules ranked against.
    const expedited = expeditedOrigins(ctx.goalPriorities ?? [], {
      openPrs: s.openPrs,
      issues: ctx.world.issues,
      plans: ctx.plans ?? [],
      parts: ctx.planParts ?? [],
      obstacles: ctx.obstacles ?? [],
      obstacleBlocks: ctx.obstacleBlocks ?? [],
    });
    // The one hold either statement clears rather than merely outranks: a flag or drag on a
    // `sequenced` story is the operator saying "go now". Every other held reason survives — a
    // cooldown, a cap, an unapproved plan, a superseded claim. The sequence itself is not amended.
    // → `docs/spec/33-story-sequencing.md#precedence`
    const cleared = s.candidates.map((c) =>
      c.held === 'sequenced' && (expedited(c.origin) || overrideRank.has(c.origin)) ? { ...c, held: undefined } : c,
    );
    const ranked = rankByPriorityOverride(cleared, overrideRank, expedited);

    // The headroom cut: dispatch the above-cut prefix (each claiming a slot), keep everything
    // ranked as the visible queue. A cooling-down candidate is shown but never dispatched.
    let headroom = ctx.agentHeadroom;
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
      const flag = expedited(origin) ? { expedited: true } : {};
      // What this row would launch on, through the same function the dispatch resolves through.
      const priced = priceOf(origin, rule);
      if (c.held) {
        upcoming.push({ origin, rule, title, kind, branch, status: c.held, reason, ...flag, ...priced });
      } else if (headroom > 0) {
        // The one place a pin is stamped onto a dispatch; every agent dispatch routes through
        // the candidate list, so this covers all of them.
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
   * Everything the stages share, derived from the world once per cycle. Nothing here decides
   * anything — every field is a collector the walk appends to, a projection of the world, or a
   * predicate several rules must answer identically.
   */
  private stageContext(ctx: DispatchContext): StageContext {
    const raw: unknown[] = [];
    const activeOrigins = new Set(
      ctx.tasks.filter((t) => isActive(t) && t.originRef).map((t) => t.originRef as string),
    );
    // Work a requeue is redoing is in flight too, keyed on the job's origin.
    for (const job of ctx.standingJobs ?? []) if (job.originRef) activeOrigins.add(job.originRef);
    // Ranked agent-dispatch candidates. The headroom cut is applied after ranking, so
    // below-cut candidates survive as the visible "Up next" queue.
    const candidates: Candidate[] = [];
    // "Now" for cooldown arithmetic — the snapshot's timestamp, not wall-clock.
    const now = ctx.world.takenAt;

    // The plan funnel's memory, read by the work-item, plan and pickup rules alike so none can
    // hold a different opinion. Empty with the funnel off.
    const plansByOrigin = new Map((ctx.plans ?? []).map((p) => [p.originRef, p]));

    const profileOverrides = new Map((ctx.profileOverrides ?? []).map((o) => [o.origin, o.profile]));

    // The operator's pickup list with the state the harness writes itself folded in — see
    // `effectivePickupStates`. The one exception is `deliveryHold`, whose whole meaning is "a
    // human moved it back", which a harness write is not.
    const pickupStates = effectivePickupStates(this.pickup);

    // Every open PR the world knows about, unwatched ones included: so "no PR in the world"
    // cannot be read as "the PR merged", and a stack's base PR is found even unwatched.
    const openPrs = ctx.hiddenPrs?.length ? [...ctx.world.pullRequests, ...ctx.hiddenPrs] : ctx.world.pullRequests;

    // Entities whose reading predates the fleet's last act on them.
    const behind = refsFinishedSince(ctx.tasks, openPrs, now);

    // Standing `delivered` verdicts, keyed on `issue:<n>`. Unlike a conclusion this one gates.
    const deliveries = new Map((ctx.deliveries ?? []).map((d) => [d.originRef, d]));
    const deliveryParked = (issue: Issue): boolean =>
      deliveryHold(deliveries.get(issueOrigin(issue.number)) ?? null, issue, {
        pickupStates: this.pickup.pickupStates,
        signals: ctx.deliverySignals,
      }) !== null;

    // Standing goal appraisals, on the same origin. Where a delivery verdict parks a finished
    // issue, this parks one that could never be started: only an explicit `unclear` holds, so a
    // crashed or capped appraiser fails the issue open.
    const appraisals = new Map((ctx.appraisals ?? []).map((a) => [a.originRef, a]));
    const appraisalParked = (issue: Issue): boolean =>
      appraisalHold(appraisals.get(issueOrigin(issue.number)) ?? null, issue) !== null;

    // Goals an agent concluded `blocked` on, still behind an obstacle that reaches agents — a
    // third park, whose exit is the obstacle rather than the issue. → `docs/spec/27-obstacles.md#blocked-is-an-answer`
    const blocked = blockedGoals(ctx.obstacleBlocks ?? [], ctx.obstacles ?? []);

    // Runs in the issue list the tracker has forgotten. Read by every rule that must not act on
    // one — all but `issue-assess` and `issue-retro`.
    const retained = new Set(ctx.retainedIssues ?? []);

    // The issue-side world. Gate on no open PR, never on `linkedPrNumber` (sticky — gating on
    // it retires an issue the first time any PR touches it). Order by label-encoded priority so
    // important issues claim limited headroom first (tie-break by number).
    const eligibleIssues = ctx.world.issues
      .filter(
        (i) =>
          !retained.has(i.number) &&
          i.state === 'open' &&
          openPrForIssue(i, openPrs) === null &&
          !deliveryParked(i) &&
          !appraisalParked(i) &&
          !blocked.has(issueOrigin(i.number)) &&
          isIssuePickupEligible(i, this.pickup).eligible,
      )
      .map((issue) => ({ issue, weight: issuePriority(issue.labels, this.pickup) }))
      .sort((a, b) => b.weight - a.weight || a.issue.number - b.issue.number);

    // Which arm of the plan funnel each eligible issue is on. Resolved once and shared by
    // `issue-plan` and `issue-pickup`, so the two cannot disagree.
    const routes = new Map<number, PlanRouteVerdict>();
    for (const { issue } of eligibleIssues) {
      const plan = plansByOrigin.get(issueOrigin(issue.number)) ?? null;
      routes.set(
        issue.number,
        resolvePlanRoute({
          plan,
          verdict: plannerVerdict(issue.number, plan, now, ctx.recentDecisions, this.cooldown),
          // A replan that spends its attempts falls back to the existing decomposition, never
          // to `single` — see `resolvePlanRoute`.
          existingParts: plan ? liveParts((ctx.planParts ?? []).filter((p) => p.planId === plan.id)).length : 0,
        }),
      );
    }

    // Which stories an accepted order is holding, and what each waits behind. Empty on every
    // fail-open arm: the gate off, no dependencies reported, an edge naming an issue the world
    // doesn't hold. → `docs/spec/33-story-sequencing.md`
    const sequencing = this.pickup.sequencing ?? 'off';
    const sequences = new Map((ctx.featureSequences ?? []).map((s) => [s.originRef, s]));
    // Two sources, one gate: the provider's links (authoritative, re-read every hydration) plus
    // an `accepted` order's edges. `proposed` and `declined` contribute nothing.
    const edges =
      sequencing === 'off'
        ? []
        : [
            ...linkEdges(ctx.world.issues),
            ...[...sequences.values()]
              .filter((s) => s.status === 'accepted')
              .flatMap((s) => s.edges.map((e) => ({ issue: e.issue, dependsOn: e.dependsOn }))),
          ];
    const sequenceWaits = sequenceReadiness(edges, { issues: ctx.world.issues, openPrs });
    // The Features an order could be written for. Only `full` runs an agent.
    const sequenceableFeatures =
      sequencing === 'full'
        ? sequenceable(
            ctx.world.issues,
            this.pickup.containerTypes,
            (issue) => issueWatchGateReason(issue, this.pickup) === null,
            this.pickup.sequenceMaxChildren ?? DEFAULT_SEQUENCE_MAX_CHILDREN,
          )
        : [];

    const validationChecks = new Map<string, ValidationCheck[]>();
    for (const check of ctx.validationChecks ?? []) {
      const group = validationChecks.get(check.originRef);
      if (group) group.push(check);
      else validationChecks.set(check.originRef, [check]);
    }

    // Throttle a persistent concern: a finished agent that didn't clear its origin cools down
    // rather than re-dispatching every cycle, and escalates once its attempts are spent.
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
      // Origins already told to a live agent, so a persistent signal isn't re-notified every
      // cycle. Best-effort: a note that ages out is told again.
      notified: notifiedOriginsByAgent(ctx.recentDecisions),
      dispatchedSignals: dispatchedSignalsByBranch(ctx.recentDecisions),
      openPrs,
      readingBehindFleet: (prNumber: number) => behind.has(prReadRef(prNumber)),
      plansByOrigin,
      // Standing "is this issue finished" verdicts. Empty resolves every issue to `undeclared`.
      conclusions: new Map((ctx.conclusions ?? []).map((c) => [c.originRef, c])),
      // The negative half, on the same origin — `work-item-back-to-pickup` must resolve the two
      // together or it reads the assessor's "not delivered" as the working agent's `done`.
      shortfallsByOrigin: new Map((ctx.shortfalls ?? []).map((sf) => [sf.originRef, sf])),
      appraisals,
      retained,
      liveIssue: (issueNumber: number) =>
        retained.has(issueNumber) ? null : (ctx.world.issues.find((i) => i.number === issueNumber) ?? null),
      /** Is this issue planned — owned by the part scheduler, not by pickup? Every plan has parts. */
      partsPlanFor: (issueNumber: number) => {
        const plan = plansByOrigin.get(issueOrigin(issueNumber));
        if (!plan || (plan.status !== 'active' && plan.status !== 'complete')) return null;
        return plan;
      },
      deliveryParked,
      appraisalParked,
      // The pins, from the operator's overrides, the world's tags and the plans' parts. Every
      // lookup is total and answers null with no `agentModels`. The override is consulted
      // outside `pinnedProfileFor` because it's keyed on the whole origin, not `issue:<n>`.
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
      // From the whole world, not the eligible subset: most containers are visible only as
      // another item's parent.
      parentCandidates: candidateParents(ctx.world.issues, this.pickup.containerTypes),
      routes,
      sequenceWaits,
      sequenceableFeatures,
      sequences,
      validationChecks,
      // Written by `issue-appraisal` / `issue-assess`, read by later stages — the pipeline
      // ordering is load-bearing here.
      appraising: new Set<number>(),
      assessing: new Set<number>(),
      // The obstacle board, and the same reading of which checks are red on a base the
      // ownership desk also takes.
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
      liveLocalRun: ctx.localRun ?? null,
      localValidations: ctx.localValidations ?? [],
      // Read through the thunk on every decision, never snapshotted — keeps `localValidation` live.
      localValidation: this.localValidation(),
      validationClaimMinutes: this.validation.desktopClaimMinutes,
      // Narrows both work-item rules' config to non-null, once, off the same predicate the
      // registry's `enabled` condition uses. The effective states, so a parked item can still move.
      workItemStates:
        this.pickup.inReviewState && pickupStates?.length
          ? { inReviewState: this.pickup.inReviewState, pickupStates }
          : null,
      workItemInProgress:
        this.pickup.inProgressState && pickupStates?.length
          ? { inProgressState: this.pickup.inProgressState, pickupStates }
          : null,
    };
  }
}

/**
 * Carry the origin's pin onto the action about to be dispatched. Absent rather than null when
 * there is no pin, so an unpinned dispatch produces exactly the action it always did.
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
 * Branch+signal pairs a dispatch has already put in front of an agent, from executed
 * `dispatch_code_agent` decisions carrying `signalRefs`. The review-comment concern dispatches
 * on `pr:<n>:comments`, which is none of the signals it folds, so `activeOrigins` alone can't
 * tell a running agent already has those threads. Keyed on branch, since the decision is
 * recorded before an agent exists. Best-effort: a dispatch that ages out costs one redundant note.
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
