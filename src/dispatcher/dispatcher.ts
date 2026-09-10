import type {
  Agent,
  Decision,
  Escalation,
  FeatureSequence,
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
  PullRequest,
  Remedy,
  TaskSummary,
  LocalRun,
  LocalValidation,
  RemoteRunBrief,
  SelectorOffering,
  ValidationCheck,
  ValidationPlanRecord,
  Ejection,
  WorldEvent,
  WorldSnapshot,
} from '../types.js';
import type { AgentModels, ProfileSource } from '../agents/modelPolicy.js';
import type { ParseResult } from './actions.js';
import type { QueueStatus } from './admission.js';
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
  /** The areas each browser environment's runner last said it offers, for the planner to pick from. */
  selectorOfferings?: SelectorOffering[];
  priorityOverrides?: PriorityOverride[];
  goalPriorities?: GoalPriority[];
  goalPauses?: GoalPause[];
  profileOverrides?: ProfileOverride[];
  conclusions?: IssueConclusion[];
  deliveries?: IssueDelivery[];
  deliverySignals?: WorldEvent[];
  shortfalls?: IssueShortfall[];
  appraisals?: IssueAppraisal[];
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
