import type { DispatchContext } from '../dispatcher.js';
import type { AdmissionId, DispatchRuleId } from '../rules.js';
import type { CooldownPolicy } from '../dispatchCooldown.js';
import type { IssuePickupPolicy } from '../issuePickup.js';
import type { PromptTemplates } from '../promptTemplates.js';
import type { RuleHeld } from '../admission.js';
import type { CiPolicy } from '../../ci/ciPolicy.js';
import type { PrReviewPolicy } from '../../review/policy.js';
import type { PrReviewCharters } from '../../review/prReview.js';
import type { PlanningPolicy } from '../../plans/planning.js';
import type { LocalValidationPolicy } from '../../localValidation/policy.js';
import type { SequenceableFeature } from '../../sequence/sequence.js';
import type { SequenceWait } from '../../sequence/readiness.js';
import type {
  Decision,
  FeatureSequence,
  Issue,
  IssueAppraisal,
  IssueConclusion,
  IssueRelative,
  IssueShortfall,
  LocalRun,
  LocalValidation,
  ObstacleStanding,
  Plan,
  PrReview,
  PrReviewRoute,
  PrDescriptionDraft,
  DescriptionAwaitingCheck,
  PrSplitVerdict,
  PullRequest,
  RemoteRunBrief,
  TaskSummary,
  ValidationCheck,
  ValidationPlanRecord,
} from '../../types.js';
import type { PlanRouteVerdict } from '../../plans/planning.js';
import type { PrRefStyle } from '../../pr/prRef.js';

// → docs/spec/05-dispatcher.md (the rule book)

export interface StageContext {
  ctx: DispatchContext;
  now: string;
  raw: unknown[];
  candidates: Candidate[];
  activeOrigins: Set<string>;
  notified: Set<string>;
  dispatchedSignals: Set<string>;
  openPrs: PullRequest[];
  readingBehindFleet: (prNumber: number) => boolean;
  plansByOrigin: Map<string, Plan>;
  conclusions: Map<string, IssueConclusion>;
  shortfallsByOrigin: Map<string, IssueShortfall>;
  appraisals: Map<string, IssueAppraisal>;
  retained: Set<number>;
  liveIssue: (issueNumber: number) => Issue | null;
  partsPlanFor: (issueNumber: number) => Plan | null;
  deliveryParked: (issue: Issue) => boolean;
  appraisalParked: (issue: Issue) => boolean;
  pinFor: (originRef: string | null) => string | null;
  profileOverrides: ReadonlyMap<string, string>;
  eligibleIssues: { issue: Issue; weight: number }[];
  parentCandidates: IssueRelative[];
  routes: Map<number, PlanRouteVerdict>;
  sequenceWaits: ReadonlyMap<number, SequenceWait>;
  sequenceableFeatures: readonly SequenceableFeature[];
  sequences: ReadonlyMap<string, FeatureSequence>;
  validationChecks: Map<string, ValidationCheck[]>;
  /** Each goal's validation plan: the plan's hint, and the planner's stamp once it has run. */
  validationPlans: ReadonlyMap<string, ValidationPlanRecord>;
  obstacles: readonly ObstacleStanding[];
  redBaseChecks: ReadonlySet<string>;
  appraising: Set<number>;
  assessing: Set<number>;
  /**
   * The cooldown gate every proposing rule shares: reads `dispatchVerdict` for the candidate's
   * origin, queues it as `held: 'cooldown'` inside the gap, and drops it once the cap is spent.
   * Returns whether it was proposed, for a rule that must record having claimed the origin.
   * → docs/spec/05-dispatcher.md#the-re-dispatch-cooldown
   */
  consider: (candidate: Candidate, opts?: ConsiderOptions) => boolean;

  pickup: IssuePickupPolicy;
  cooldown: CooldownPolicy;
  templates: PromptTemplates;
  planning: PlanningPolicy;
  ci: CiPolicy;
  review: PrReviewPolicy;
  reviewCharters: PrReviewCharters;
  prReviews: ReadonlyMap<number, PrReview>;
  prReviewRoutes: ReadonlyMap<number, PrReviewRoute>;
  prSplits: ReadonlyMap<number, PrSplitVerdict>;
  descriptionDrafts: readonly PrDescriptionDraft[];
  uncheckedDescriptions: readonly DescriptionAwaitingCheck[];
  prReviewedElsewhere: ReadonlySet<number>;
  defaultBranch: string;
  prRefStyle: PrRefStyle;
  watchNote: string;
  watchDeclareNote: string;
  testPartNote: string;
  /** Why a screen the fleet can capture is not a person's by default. → 20-validation.md#who-carries-a-step */
  screenCheckNote: string;
  stateDeclareNote: string;
  /** What each configured environment can drive, and the areas its runner last offered. */
  validationPlanNote: string;
  /**
   * `validation.checkSets`. Read by rule `issue-assess` as well as by the two rules it gates, because
   * the assessor's second output is a check set and the fold asking for it is appended to its prompt.
   * → docs/spec/20-validation.md#the-authoring-gate
   */
  checkSets: boolean;
  validationRoot: string;
  liveLocalRun: LocalRun | null;
  /** Every live run row, with what the agent must read already rendered. → 36-remote-validation.md */
  remoteRuns: readonly RemoteRunBrief[];
  localValidations: LocalValidation[];
  localValidation: LocalValidationPolicy;
  validationClaimMinutes: number;
  workItemStates: { inReviewState: string; pickupStates: string[] } | null;
  workItemInProgress: { inProgressState: string; pickupStates: string[] } | null;
}

export interface ConsiderOptions {
  /** Raised at the attempt cap. A rule that omits it lets the origin fall silent instead. */
  escalate?: (attempts: number) => RawAction;
  /** Narrows the attempt window — the decisions since a reading, rather than all of them. */
  decisions?: Decision[];
}

export type RawAction = Record<string, unknown> & {
  type: string;
  reason: string;
  rule: DispatchRuleId | null;
  admission?: AdmissionId;
};

export interface Candidate {
  origin: string;
  rule: DispatchRuleId;
  title: string;
  kind: 'code' | 'desk';
  branch: string | null;
  reason: string;
  action: RawAction;
  held?: RuleHeld;
}

export function isActive(t: TaskSummary): boolean {
  return t.status === 'queued' || t.status === 'running' || t.status === 'waiting';
}
