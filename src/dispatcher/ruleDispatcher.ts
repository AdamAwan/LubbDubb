import type { Dispatcher, DispatchContext, DispatchResult, QueueItem } from './dispatcher.js';
import type { PrRefStyle } from '../pr/prRef.js';
import type { ValidatedAction } from './actions.js';
import { parseActions } from './actions.js';
import { pausedIssueNumbers } from '../goalPause.js';
import { type IssuePickupPolicy } from './issuePickup.js';
import { DEFAULT_COOLDOWN, type CooldownPolicy } from './dispatchCooldown.js';
import { type CiPolicy } from '../ci/ciPolicy.js';
import { DISPATCH_PIPELINE, type DispatchRuleId, type OwnStageRuleId, type RuleConditions } from './rules.js';
import { DEFAULT_PR_REVIEW, type PrReviewPolicy } from '../review/policy.js';
import type { PrReviewCharters } from '../review/prReview.js';
import { rankByPriorityOverride } from './priorityOverride.js';
import { expeditedOrigins } from './goalPriority.js';
import { redBaseChecks } from '../obstacles/ownership.js';
import { candidateParents } from '../issueRelations.js';
import { resolveAgentProfile } from '../agents/modelPolicy.js';
import { prReadRef, refsFinishedSince } from '../world/readPlan.js';
import { DEFAULT_VALIDATION, type ValidationPolicy } from '../validation/policy.js';
import { PromptTemplates, defaultPromptTemplates } from './promptTemplates.js';
import { DEFAULT_PLANNING, issueOrigin, type PlanningPolicy } from '../plans/planning.js';
import { sittingHolds } from '../intake/sitting.js';
import { type Candidate, type RawAction, type StageContext } from './rules/context.js';
import {
  activeOriginsOf,
  checksByOrigin,
  considerWith,
  cycleLookups,
  issueGates,
  pinResolver,
  planRoutes,
  sequencingView,
  workItemGates,
} from './ruleDispatcherStage.js';
import { manualJob } from './rules/manualJob.js';
import { obstacleRepair } from './rules/obstacleRepair.js';
import { prConcerns } from './rules/prConcerns.js';
import { prReviewTriage } from './rules/prReviewTriage.js';
import { prSplit } from './rules/prSplit.js';
import { prDescribe } from './rules/prDescribe.js';
import { prDescriptionCheck } from './rules/prDescriptionCheck.js';
import { workItemInReview } from './rules/workItemInReview.js';
import { workItemBackToPickup } from './rules/workItemBackToPickup.js';
import { workItemInProgress } from './rules/workItemInProgress.js';
import { issueAppraisal } from './rules/issueAppraisal.js';
import { issuePlan } from './rules/issuePlan.js';
import { criteriaAlignment } from './rules/criteriaAlignment.js';
import { predictionJudge } from './rules/predictionJudge.js';
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
import { DEFAULT_LOCAL_VALIDATION, type LocalValidationPolicy } from '../validation/local/policy.js';
import { featureSummary } from './rules/featureSummary.js';
import { featureSequence } from './rules/featureSequence.js';
import { validationFailed } from './rules/validationFailed.js';
import { validationPlan } from './rules/validationPlan.js';
import { validationPlanApproval } from './rules/validationPlanApproval.js';
import { remoteValidation } from './rules/remoteValidation.js';

// → docs/spec/05-dispatcher.md

export const STAGES: Record<OwnStageRuleId, (s: StageContext) => void> = {
  'manual-job': manualJob,
  'obstacle-repair': obstacleRepair,
  'pr-review-triage': prReviewTriage,
  'pr-split': prSplit,
  'pr-describe': prDescribe,
  'pr-description-check': prDescriptionCheck,
  'pr-ci-failing': prConcerns,
  'work-item-in-progress': workItemInProgress,
  'work-item-in-review': workItemInReview,
  'work-item-back-to-pickup': workItemBackToPickup,
  'issue-appraisal': issueAppraisal,
  'criteria-alignment': criteriaAlignment,
  'issue-plan': issuePlan,
  'issue-assess': issueAssess,
  'issue-shortfall': issueShortfall,
  'issue-retro': issueRetro,
  'plan-approval': planApproval,
  'prediction-judge': predictionJudge,
  'plan-amendment': planAmendment,
  'plan-blocked': planBlocked,
  'plan-part': planPart,
  'issue-pickup': issuePickup,
  'local-validation': localValidation,
  'local-validation-fix': localValidationFix,
  'validation-plan': validationPlan,
  'validation-plan-approval': validationPlanApproval,
  'validate-check': validateCheck,
  'remote-validation': remoteValidation,
  'validation-failed': validationFailed,
  'feature-summary': featureSummary,
  'feature-sequence': featureSequence,
};

interface RuleDispatcherOptions {
  pickup?: Partial<IssuePickupPolicy>;
  cooldown?: Partial<CooldownPolicy>;
  templates?: PromptTemplates;
  defaultBranch?: string;
  planning?: Partial<PlanningPolicy>;
  ci?: Partial<CiPolicy>;
  validation?: Partial<ValidationPolicy>;
  validationRoot?: string;
  prRefStyle?: PrRefStyle;
  review?: Partial<PrReviewPolicy>;
  reviewCharters?: PrReviewCharters;
  watchNote?: string;
  watchDeclareNote?: string;
  localValidation?: () => LocalValidationPolicy;
  testPartNote?: string;
  screenCheckNote?: string;
  stateDeclareNote?: string;
  remoteValidationOn?: boolean;
  checkSets?: boolean;
  validationPlanNote?: string;
}

export class RuleDispatcher implements Dispatcher {
  private readonly pickup: IssuePickupPolicy;
  private readonly cooldown: CooldownPolicy;
  private readonly templates: PromptTemplates;
  private readonly defaultBranch: string;
  private readonly prRefStyle: PrRefStyle;
  private readonly notes: PromptNotes;
  private readonly planning: PlanningPolicy;
  private readonly validation: Pick<ValidationPolicy, 'desktopClaimMinutes'>;
  private readonly validationRoot: string;
  private readonly localValidation: () => LocalValidationPolicy;
  private readonly remoteValidationOn: boolean;
  private readonly checkSets: boolean;
  private readonly review: PrReviewPolicy;
  private readonly reviewCharters: PrReviewCharters;
  private ci: CiPolicy;

  constructor(opts: RuleDispatcherOptions = {}) {
    const {
      templates = defaultPromptTemplates(),
      defaultBranch = 'main',
      validation = {},
      validationRoot = '.lubbdubb/validation',
      prRefStyle = '#',
      review = {},
      reviewCharters = { routing: null, modes: {} },
      localValidation = () => DEFAULT_LOCAL_VALIDATION,
      remoteValidationOn = false,
      checkSets = false,
    } = opts;
    this.remoteValidationOn = remoteValidationOn;
    this.checkSets = checkSets;
    this.notes = promptNotes(opts);
    this.review = { ...DEFAULT_PR_REVIEW, ...review };
    this.reviewCharters = reviewCharters;
    this.validation = {
      desktopClaimMinutes: validation.desktopClaimMinutes ?? DEFAULT_VALIDATION.desktopClaimMinutes,
    };
    this.validationRoot = validationRoot;
    this.localValidation = localValidation;
    this.defaultBranch = defaultBranch;
    this.prRefStyle = prRefStyle;
    this.ci = ciPolicyOf(opts.ci);
    this.planning = planningPolicyOf(opts.planning);
    this.templates = templates;
    this.pickup = pickupPolicyOf(opts.pickup);
    this.cooldown = cooldownPolicyOf(opts.cooldown);
  }

  /**
   * Re-seat the CI policy on a running dispatcher. The constructor takes a copy, so without
   * this a config reload leaves the cockpit drawing one policy while this ran another.
   *
   * @public — reached structurally, as `CiPolicyHolder` in `src/configApply.ts`.
   */
  setCiPolicy(ci: CiPolicy): void {
    this.ci = ciPolicyOf(ci);
  }

  async decide(ctx: DispatchContext): Promise<DispatchResult> {
    const s = this.stageContext(ctx);

    const conditions: RuleConditions = {
      workItemStates: s.workItemStates !== null,
      workItemInProgress: s.workItemInProgress !== null,
      review: this.review.enabled,
      sequencer: this.pickup.sequencing === 'full',
      remoteValidation: this.remoteValidationOn,
      checkSets: this.checkSets,
    };
    for (const rule of DISPATCH_PIPELINE) {
      if (rule.emittedBy !== undefined) continue;
      if (rule.enabled && !rule.enabled(conditions)) continue;
      STAGES[rule.id](s);
    }

    const overrideRank = new Map((ctx.priorityOverrides ?? []).map((o) => [o.origin, o.rank]));
    const expedited = expeditedFor(ctx, s.openPrs, this.pickup.containerTypes);
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
    const activeOrigins = activeOriginsOf(ctx);
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

    const openPrs = ctx.hiddenPrs?.length ? [...ctx.world.pullRequests, ...ctx.hiddenPrs] : ctx.world.pullRequests;

    const behind = refsFinishedSince(ctx.tasks, openPrs, now);

    const gates = issueGates(ctx, pickup, openPrs);
    const { retained } = gates;

    const criteriaByOrigin = new Map((ctx.goalCriteria ?? []).map((c) => [c.originRef, c]));

    return {
      ...cycleLookups(ctx),
      ...gates,
      ...sequencingView(ctx, pickup),
      ...this.policies(),
      ...workItemGates(pickup),
      ctx,
      now,
      raw,
      candidates,
      activeOrigins,
      openPrs,
      readingBehindFleet: (prNumber: number) => behind.has(prReadRef(prNumber)),
      plansByOrigin,
      liveIssue: (issueNumber: number) =>
        retained.has(issueNumber) ? null : (ctx.world.issues.find((i) => i.number === issueNumber) ?? null),
      partsPlanFor: (issueNumber: number) => {
        const plan = plansByOrigin.get(issueOrigin(issueNumber));
        if (!plan || (plan.status !== 'active' && plan.status !== 'complete')) return null;
        return plan;
      },
      sittingHolds: (issueNumber: number) =>
        sittingHolds(ctx.closedSittings, issueNumber, plansByOrigin.get(issueOrigin(issueNumber)) ?? null),
      criteriaFor: (issueNumber: number) => criteriaByOrigin.get(issueOrigin(issueNumber)) ?? null,
      profileOverrides,
      pinFor: pinResolver(ctx, plansByOrigin, profileOverrides),
      parentCandidates: candidateParents(ctx.world.issues, pickup.containerTypes),
      routes: planRoutes(ctx, gates.eligibleIssues, plansByOrigin, this.cooldown),
      validationChecks: checksByOrigin(ctx.validationChecks ?? []),
      appraising: new Set<number>(),
      assessing: new Set<number>(),
      redBaseChecks: redBaseChecks(openPrs),
      consider: considerWith(ctx, this.cooldown, raw, candidates),
      pickup,
    };
  }

  private policies(): Pick<
    StageContext,
    | 'cooldown'
    | 'templates'
    | 'planning'
    | 'ci'
    | 'review'
    | 'reviewCharters'
    | 'defaultBranch'
    | 'prRefStyle'
    | keyof PromptNotes
    | 'checkSets'
    | 'validationRoot'
    | 'localValidation'
    | 'validationClaimMinutes'
  > {
    return {
      cooldown: this.cooldown,
      templates: this.templates,
      planning: this.planning,
      ci: this.ci,
      review: this.review,
      reviewCharters: this.reviewCharters,
      defaultBranch: this.defaultBranch,
      prRefStyle: this.prRefStyle,
      ...this.notes,
      checkSets: this.checkSets,
      validationRoot: this.validationRoot,
      localValidation: this.localValidation(),
      validationClaimMinutes: this.validation.desktopClaimMinutes,
    };
  }
}

type PromptNotes = Pick<
  StageContext,
  'watchNote' | 'watchDeclareNote' | 'testPartNote' | 'screenCheckNote' | 'validationPlanNote' | 'stateDeclareNote'
>;

function promptNotes(opts: RuleDispatcherOptions): PromptNotes {
  const {
    watchNote = '',
    watchDeclareNote = '',
    testPartNote = '',
    screenCheckNote = '',
    validationPlanNote = '',
    stateDeclareNote = '',
  } = opts;
  return { watchNote, watchDeclareNote, testPartNote, screenCheckNote, validationPlanNote, stateDeclareNote };
}

function ciPolicyOf(ci: Partial<CiPolicy> = {}): CiPolicy {
  return { checks: ci.checks ?? [] };
}

function planningPolicyOf(planning: Partial<PlanningPolicy> = {}): PlanningPolicy {
  return {
    maxConcurrentPartsPerIssue: planning.maxConcurrentPartsPerIssue ?? DEFAULT_PLANNING.maxConcurrentPartsPerIssue,
    gitFetchIntervalMs: planning.gitFetchIntervalMs ?? DEFAULT_PLANNING.gitFetchIntervalMs,
    fileBudget: planning.fileBudget ?? DEFAULT_PLANNING.fileBudget,
  };
}

function pickupPolicyOf(pickup: Partial<IssuePickupPolicy> = {}): IssuePickupPolicy {
  return {
    ...pickup,
    priorityLabels: pickup.priorityLabels ?? {},
    defaultPriority: pickup.defaultPriority ?? 0,
  };
}

function cooldownPolicyOf(cooldown: Partial<CooldownPolicy> = {}): CooldownPolicy {
  return {
    maxAttempts: cooldown.maxAttempts ?? DEFAULT_COOLDOWN.maxAttempts,
    cooldownMs: cooldown.cooldownMs ?? DEFAULT_COOLDOWN.cooldownMs,
  };
}

function expeditedFor(
  ctx: DispatchContext,
  openPrs: StageContext['openPrs'],
  containerTypes: string[] | undefined,
): ReturnType<typeof expeditedOrigins> {
  return expeditedOrigins(
    ctx.goalPriorities ?? [],
    {
      openPrs,
      issues: ctx.world.issues,
      plans: ctx.plans ?? [],
      parts: ctx.planParts ?? [],
      obstacles: ctx.obstacles ?? [],
      obstacleBlocks: ctx.obstacleBlocks ?? [],
    },
    containerTypes,
  );
}

function pinAction(action: RawAction, profile: string | null): RawAction {
  return profile === null ? action : { ...action, profile };
}

function buildRationale(actions: ValidatedAction[]): string {
  if (actions.length === 1 && actions[0]?.type === 'no_op') return 'Rule dispatcher: nothing actionable.';
  return `Rule dispatcher chose ${actions.length} action(s): ` + actions.map((a) => a.type).join(', ');
}
