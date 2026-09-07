import type { Dispatcher, DispatchContext, DispatchResult, QueueItem } from './dispatcher.js';
import type { PrRefStyle } from '../prRef.js';
import type { ValidatedAction } from './actions.js';
import { parseActions } from './actions.js';
import type { Decision, Issue, ValidationCheck } from '../types.js';
import { pausedIssueNumbers } from '../goalPause.js';
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
import { prSplit } from './rules/prSplit.js';
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

// → docs/spec/05-dispatcher.md

const STAGES: Partial<Record<StageRuleId, (s: StageContext) => void>> = {
  'manual-job': manualJob,
  'obstacle-repair': obstacleRepair,
  'pr-review-triage': prReviewTriage,
  'pr-split': prSplit,
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

export class RuleDispatcher implements Dispatcher {
  private readonly pickup: IssuePickupPolicy;
  private readonly cooldown: CooldownPolicy;
  private readonly templates: PromptTemplates;
  private readonly defaultBranch: string;
  private readonly prRefStyle: PrRefStyle;
  private readonly watchNote: string;
  private readonly watchDeclareNote: string;
  private readonly planning: PlanningPolicy;
  private readonly validation: Pick<ValidationPolicy, 'desktopClaimMinutes'>;
  private readonly validationRoot: string;
  private readonly localValidation: () => LocalValidationPolicy;
  private readonly review: PrReviewPolicy;
  private readonly reviewCharters: PrReviewCharters;
  private ci: CiPolicy;

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
      fileBudget: planning.fileBudget ?? DEFAULT_PLANNING.fileBudget,
    };
    this.templates = templates;
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

    const conditions: RuleConditions = {
      workItemStates: s.workItemStates !== null,
      workItemInProgress: s.workItemInProgress !== null,
      review: this.review.enabled,
      sequencer: this.pickup.sequencing === 'full',
    };
    for (const rule of DISPATCH_PIPELINE) {
      if (rule.enabled && !rule.enabled(conditions)) continue;
      STAGES[rule.id]?.(s);
    }

    const overrideRank = new Map((ctx.priorityOverrides ?? []).map((o) => [o.origin, o.rank]));
    const expedited = expeditedOrigins(ctx.goalPriorities ?? [], {
      openPrs: s.openPrs,
      issues: ctx.world.issues,
      plans: ctx.plans ?? [],
      parts: ctx.planParts ?? [],
      obstacles: ctx.obstacles ?? [],
      obstacleBlocks: ctx.obstacleBlocks ?? [],
    });
    const cleared = s.candidates.map((c) =>
      c.held === 'sequenced' && (expedited(c.origin) || overrideRank.has(c.origin)) ? { ...c, held: undefined } : c,
    );
    const ranked = rankByPriorityOverride(cleared, overrideRank, expedited);

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
      if (s.activeOrigins.has(c.origin)) continue;
      const { origin, rule, title, kind, branch, reason } = c;
      const flag = expedited(origin) ? { expedited: true } : {};
      const priced = priceOf(origin, rule);
      if (c.held) {
        upcoming.push({ origin, rule, title, kind, branch, status: c.held, reason, ...flag, ...priced });
      } else if (headroom > 0) {
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

  private stageContext(ctx: DispatchContext): StageContext {
    const raw: unknown[] = [];
    const activeOrigins = new Set(
      ctx.tasks.filter((t) => isActive(t) && t.originRef).map((t) => t.originRef as string),
    );
    for (const job of ctx.standingJobs ?? []) if (job.originRef) activeOrigins.add(job.originRef);
    for (const held of ctx.ejections ?? []) activeOrigins.add(held.originRef);
    const candidates: Candidate[] = [];
    const now = ctx.world.takenAt;

    const plansByOrigin = new Map((ctx.plans ?? []).map((p) => [p.originRef, p]));

    const profileOverrides = new Map((ctx.profileOverrides ?? []).map((o) => [o.origin, o.profile]));

    // The pause set is folded in per cycle, not at boot: a policy snapshotted once
    // would go on dispatching under a Feature an operator paused ten minutes ago.
    const pickup: IssuePickupPolicy = {
      ...this.pickup,
      pausedIssues: pausedIssueNumbers(ctx.goalPauses ?? [], ctx.world.issues, this.pickup.containerTypes),
    };

    const pickupStates = effectivePickupStates(pickup);

    const openPrs = ctx.hiddenPrs?.length ? [...ctx.world.pullRequests, ...ctx.hiddenPrs] : ctx.world.pullRequests;

    const behind = refsFinishedSince(ctx.tasks, openPrs, now);

    const deliveries = new Map((ctx.deliveries ?? []).map((d) => [d.originRef, d]));
    const deliveryParked = (issue: Issue): boolean =>
      deliveryHold(deliveries.get(issueOrigin(issue.number)) ?? null, issue, {
        pickupStates: pickup.pickupStates,
        signals: ctx.deliverySignals,
      }) !== null;

    const appraisals = new Map((ctx.appraisals ?? []).map((a) => [a.originRef, a]));
    const appraisalParked = (issue: Issue): boolean =>
      appraisalHold(appraisals.get(issueOrigin(issue.number)) ?? null, issue) !== null;

    const blocked = blockedGoals(ctx.obstacleBlocks ?? [], ctx.obstacles ?? []);

    const retained = new Set(ctx.retainedIssues ?? []);

    const eligibleIssues = ctx.world.issues
      .filter(
        (i) =>
          !retained.has(i.number) &&
          i.state === 'open' &&
          openPrForIssue(i, openPrs) === null &&
          !deliveryParked(i) &&
          !appraisalParked(i) &&
          !blocked.has(issueOrigin(i.number)) &&
          isIssuePickupEligible(i, pickup).eligible,
      )
      .map((issue) => ({ issue, weight: issuePriority(issue.labels, pickup) }))
      .sort((a, b) => b.weight - a.weight || a.issue.number - b.issue.number);

    const routes = new Map<number, PlanRouteVerdict>();
    for (const { issue } of eligibleIssues) {
      const plan = plansByOrigin.get(issueOrigin(issue.number)) ?? null;
      routes.set(
        issue.number,
        resolvePlanRoute({
          plan,
          verdict: plannerVerdict(issue.number, plan, now, ctx.recentDecisions, this.cooldown),
          existingParts: plan ? liveParts((ctx.planParts ?? []).filter((p) => p.planId === plan.id)).length : 0,
        }),
      );
    }

    const sequencing = pickup.sequencing ?? 'off';
    const sequences = new Map((ctx.featureSequences ?? []).map((s) => [s.originRef, s]));
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
    const sequenceableFeatures =
      sequencing === 'full'
        ? sequenceable(
            ctx.world.issues,
            pickup.containerTypes,
            (issue) => issueWatchGateReason(issue, pickup) === null,
            pickup.sequenceMaxChildren ?? DEFAULT_SEQUENCE_MAX_CHILDREN,
          )
        : [];

    const validationChecks = new Map<string, ValidationCheck[]>();
    for (const check of ctx.validationChecks ?? []) {
      const group = validationChecks.get(check.originRef);
      if (group) group.push(check);
      else validationChecks.set(check.originRef, [check]);
    }

    const consider = (candidate: Candidate, onEscalate: (attempts: number) => RawAction): void => {
      const verdict = dispatchVerdict(candidate.origin, now, ctx.recentDecisions, this.cooldown);
      if (verdict.kind === 'escalate') raw.push(onEscalate(verdict.attempts));
      else if (verdict.kind === 'cooldown') candidates.push({ ...candidate, held: 'cooldown' });
      else if (verdict.kind === 'dispatch') candidates.push(candidate);
    };

    return {
      ctx,
      now,
      raw,
      candidates,
      activeOrigins,
      notified: notifiedOriginsByAgent(ctx.recentDecisions),
      dispatchedSignals: dispatchedSignalsByBranch(ctx.recentDecisions),
      openPrs,
      readingBehindFleet: (prNumber: number) => behind.has(prReadRef(prNumber)),
      plansByOrigin,
      conclusions: new Map((ctx.conclusions ?? []).map((c) => [c.originRef, c])),
      shortfallsByOrigin: new Map((ctx.shortfalls ?? []).map((sf) => [sf.originRef, sf])),
      appraisals,
      retained,
      liveIssue: (issueNumber: number) =>
        retained.has(issueNumber) ? null : (ctx.world.issues.find((i) => i.number === issueNumber) ?? null),
      partsPlanFor: (issueNumber: number) => {
        const plan = plansByOrigin.get(issueOrigin(issueNumber));
        if (!plan || (plan.status !== 'active' && plan.status !== 'complete')) return null;
        return plan;
      },
      deliveryParked,
      appraisalParked,
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
      parentCandidates: candidateParents(ctx.world.issues, pickup.containerTypes),
      routes,
      sequenceWaits,
      sequenceableFeatures,
      sequences,
      validationChecks,
      appraising: new Set<number>(),
      assessing: new Set<number>(),
      obstacles: ctx.obstacles ?? [],
      redBaseChecks: redBaseChecks(openPrs),
      consider,
      pickup,
      cooldown: this.cooldown,
      templates: this.templates,
      planning: this.planning,
      ci: this.ci,
      review: this.review,
      reviewCharters: this.reviewCharters,
      prReviewRoutes: new Map((ctx.prReviewRoutes ?? []).map((route) => [route.prNumber, route])),
      prSplits: new Map((ctx.prSplits ?? []).map((v) => [v.prNumber, v])),
      prReviews: new Map((ctx.prReviews ?? []).map((review) => [review.prNumber, review])),
      prReviewedElsewhere: ctx.prReviewedElsewhere ?? new Set<number>(),
      defaultBranch: this.defaultBranch,
      prRefStyle: this.prRefStyle,
      watchNote: this.watchNote,
      watchDeclareNote: this.watchDeclareNote,
      validationRoot: this.validationRoot,
      liveLocalRun: ctx.localRun ?? null,
      localValidations: ctx.localValidations ?? [],
      localValidation: this.localValidation(),
      validationClaimMinutes: this.validation.desktopClaimMinutes,
      workItemStates:
        pickup.inReviewState && pickupStates?.length ? { inReviewState: pickup.inReviewState, pickupStates } : null,
      workItemInProgress:
        pickup.inProgressState && pickupStates?.length
          ? { inProgressState: pickup.inProgressState, pickupStates }
          : null,
    };
  }
}

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
