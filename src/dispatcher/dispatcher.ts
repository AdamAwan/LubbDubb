import type {
  Agent,
  Decision,
  Escalation,
  FeatureSequence,
  GoalCriteriaAlignment,
  GoalCriteriaVersion,
  GoalPause,
  GoalPriority,
  IssueConclusion,
  IssueAppraisal,
  IssueDelivery,
  IssueShortfall,
  Job,
  ObstacleBlock,
  ObstacleStanding,
  Plan,
  PlanAmendment,
  PlanAtom,
  PlanPart,
  PriorityOverride,
  ProfileOverride,
  Proposal,
  PrReview,
  PrReviewRoute,
  PrSplitVerdict,
  PrDescriptionDraft,
  DescriptionAwaitingCheck,
  PullRequest,
  Remedy,
  TaskSummary,
  LocalRun,
  LocalValidation,
  RemoteRunBrief,
  ValidationCheck,
  ValidationPlanRecord,
  Ejection,
  WorldEvent,
  WorldSnapshot,
} from '../types.js';
import type { AgentModels, ProfileSource } from '../agents/modelPolicy.js';
import type { ParseResult } from './actions.js';
import type { QueueStatus } from './admission.js';
import type { ClosedSittings } from '../intake/sitting.js';
import type { DispatchRuleId } from './rules.js';

// → docs/spec/05-dispatcher.md

export interface DispatchContext {
  world: WorldSnapshot;
  hiddenPrs?: PullRequest[];
  retainedIssues?: number[];
  modelPins?: { labelPrefix: string; models: AgentModels };
  priorRemedies?: Remedy[];
  prReviews?: PrReview[];
  prReviewRoutes?: PrReviewRoute[];
  prSplits?: PrSplitVerdict[];
  descriptionDrafts?: PrDescriptionDraft[];
  uncheckedDescriptions?: DescriptionAwaitingCheck[];
  prReviewedElsewhere?: ReadonlySet<number>;
  tasks: TaskSummary[];
  agents: Agent[];
  openEscalations: Escalation[];
  queuedJobs: Job[];
  standingJobs?: Job[];
  ejections?: Ejection[];
  plans?: Plan[];
  planParts?: PlanPart[];
  planAtoms?: PlanAtom[];
  planAmendments?: PlanAmendment[];
  validationChecks?: ValidationCheck[];
  validationPlans?: ValidationPlanRecord[];
  localRun?: LocalRun | null;
  localValidations?: LocalValidation[];
  remoteRuns?: RemoteRunBrief[];
  priorityOverrides?: PriorityOverride[];
  goalPriorities?: GoalPriority[];
  goalPauses?: GoalPause[];
  profileOverrides?: ProfileOverride[];
  conclusions?: IssueConclusion[];
  deliveries?: IssueDelivery[];
  deliverySignals?: WorldEvent[];
  shortfalls?: IssueShortfall[];
  appraisals?: IssueAppraisal[];
  closedSittings?: ClosedSittings;
  goalCriteria?: GoalCriteriaVersion[];
  criteriaAlignments?: GoalCriteriaAlignment[];
  /** Goals owed a judge's second reading, as root origin refs. → 14-persistence.md#the-prediction-judge */
  judgeOwed?: readonly string[];
  retrospectiveOrigins?: string[];
  featureStandings?: { number: number; title: string; key: string }[];
  featureSummaryKeys?: { originRef: string; standingKey: string }[];
  featureSequences?: FeatureSequence[];
  obstacles?: ObstacleStanding[];
  obstacleBlocks?: ObstacleBlock[];
  agentHeadroom: number;
  recentDecisions: Decision[];
  proposals?: Proposal[];
  rejectionSignals?: WorldEvent[];
}

export interface QueueItem {
  origin: string;
  rule: DispatchRuleId;
  title: string;
  kind: 'code' | 'desk';
  branch: string | null;
  status: QueueStatus;
  reason: string;
  expedited?: boolean;
  profile?: string | null;
  profileSource?: ProfileSource;
  override?: string;
}

export interface DispatchResult extends ParseResult {
  rationale: string;
  upcoming?: QueueItem[];
}

export interface Dispatcher {
  decide(ctx: DispatchContext): Promise<DispatchResult>;
}
