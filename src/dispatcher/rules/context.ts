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
import type {
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
  sequenceWaits: ReadonlyMap<number, number[]>;
  sequenceableFeatures: readonly SequenceableFeature[];
  sequences: ReadonlyMap<string, FeatureSequence>;
  validationChecks: Map<string, ValidationCheck[]>;
  /** Each goal's validation plan: the plan's hint, and the planner's stamp once it has run. */
  validationPlans: ReadonlyMap<string, ValidationPlanRecord>;
  obstacles: readonly ObstacleStanding[];
  redBaseChecks: ReadonlySet<string>;
  appraising: Set<number>;
  assessing: Set<number>;
  consider: (candidate: Candidate, onEscalate: (attempts: number) => RawAction) => void;

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
  prReviewedElsewhere: ReadonlySet<number>;
  defaultBranch: string;
  prRefStyle: PrRefStyle;
  watchNote: string;
  watchDeclareNote: string;
  testPartNote: string;
  stateDeclareNote: string;
  /** What each configured environment can drive, and the areas its runner last offered. */
  validationPlanNote: string;
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
