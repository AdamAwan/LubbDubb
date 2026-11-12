import type {
  BotPrOutcome,
  BotPrRisk,
  FeatureSummary,
  Agent,
  Decision,
  Escalation,
  FeatureSequence,
  GoalPause,
  GoalPriority,
  IssueConclusion,
  IssueAppraisal,
  IssueInvestigation,
  IssueDelivery,
  IssueShortfall,
  Job,
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
  PendingBotPrRiskRun,
  ValidationCheck,
  ValidationPlanRecord,
  WatchPlanRecord,
  PlanCaveatAnswer,
  Ejection,
  WorldEvent,
  WorldSnapshot,
} from '../types.js';
import type { AgentModels, ProfileSource } from '../agents/modelPolicy.js';
import type { ParseResult } from './actions.js';
import type { QueueStatus } from './admission.js';
import type { DispatchRuleId } from './rules.js';
import type { DiscussionReader } from '../discussions/reader.js';

// → docs/spec/05-dispatcher.md

export interface DispatchContext {
  world: WorldSnapshot;
  hiddenPrs?: PullRequest[];
  retainedIssues?: number[];
  modelPins?: { labelPrefix: string; models: AgentModels };
  priorRemedies?: Remedy[];
  /** Outcomes on the current heads of watched bot pull requests. → docs/spec/37-bot-prs.md#when-ci-fails-on-one */
  botPrOutcomes?: BotPrOutcome[];
  botPrRisks?: BotPrRisk[];
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
  watchPlans?: WatchPlanRecord[];
  /** Goal refs carrying a live watch check. */
  watchedGoals?: string[];
  /** Answers on plans' `watch` caveat, which reach the watch author with the hint. */
  watchTickAnswers?: PlanCaveatAnswer[];
  localRun?: LocalRun | null;
  localValidations?: LocalValidation[];
  remoteRuns?: RemoteRunBrief[];
  /** The one risk run waiting for its agent, if there is one. → 37-bot-prs.md#the-risk-summary */
  botPrRiskRun?: PendingBotPrRiskRun | null;
  priorityOverrides?: PriorityOverride[];
  goalPriorities?: GoalPriority[];
  goalPauses?: GoalPause[];
  profileOverrides?: ProfileOverride[];
  conclusions?: IssueConclusion[];
  deliveries?: IssueDelivery[];
  deliverySignals?: WorldEvent[];
  shortfalls?: IssueShortfall[];
  appraisals?: IssueAppraisal[];
  investigations?: IssueInvestigation[];
  /** Each issue's discussion file, read at most once a cycle. → docs/spec/40-discussions.md */
  discussion?: DiscussionReader;
  retrospectiveOrigins?: string[];
  featureStandings?: { number: number; title: string; key: string; lines: string[] }[];
  featureSummaryKeys?: Pick<FeatureSummary, 'originRef' | 'standingKey' | 'standingLines' | 'repeats' | 'repeatKeys'>[];
  featureSequences?: FeatureSequence[];
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
