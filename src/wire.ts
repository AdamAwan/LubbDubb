// → docs/spec/16-http-api.md
export type * from './wire/world.js';
export type * from './wire/localRuns.js';
export type * from './wire/plans.js';
export type * from './wire/state.js';
export type * from './wire/remoteValidation.js';
export type * from './wire/watch.js';
export type * from './wire/agents.js';
export type * from './wire/tickets.js';
export type * from './wire/features.js';
export type * from './wire/insights.js';
export type * from './wire/appErrors.js';
export type * from './wire/settings.js';
export type * from './wire/pets.js';
export type * from './wire/handled.js';
export type * from './wire/observability.js';

export type { SetupCheck, SetupFix } from './setup/reading.js';
export type {
  Agent,
  AgentAskQuestion,
  AgentFile,
  AgentFlag,
  AppErrorDetail,
  AssessedBotPr,
  BotPrOutcome,
  BotPrOutcomeKind,
  BotPrRiskLevel,
  BotPrRiskStanding,
  BugFiling,
  HandledAction,
  HandledKind,
  CheckDecline,
  CiCheck,
  DescriptionFindingKind,
  DescriptionQuestion,
  DiscussionEntry,
  DiscussionEntryState,
  DiscussionKind,
  Ejection,
  EjectionOutcome,
  EnvironmentGate,
  EnvironmentGateRelease,
  EnvironmentHealthReading,
  Escalation,
  FeatureSequence,
  FeatureSequenceEdge,
  FeatureSummary,
  GoalArrival,
  GoalGroupReach,
  GoalLandingReach,
  GoalReachStatus,
  GoalWatch,
  GoalWatchDeclaration,
  GoalWatchInput,
  GoalWatchKind,
  HumanTask,
  InvestigationResolution,
  IssueInvestigation,
  IssueSpend,
  Job,
  JobAttachment,
  JobAttachmentInput,
  JobSchedule,
  ListenItem,
  ListenerView,
  LocalRunFreshness,
  LocalRunPorts,
  LocalRunTurn,
  LocalValidationFinding,
  LocalValidationStatus,
  OkScope,
  OkStatus,
  PetActionKind,
  PetRarity,
  PetSpecies,
  PetStage,
  Plan,
  PlanAtom,
  PlanCaveat,
  PlanCaveatAnswer,
  PlanPart,
  PoolFleetReading,
  PrComment,
  PrDescriptionDraft,
  PrDescriptionVersion,
  Proposal,
  ProposedCheck,
  PrPerson,
  PrReviewThread,
  PrThreadMessage,
  PrThreadState,
  ReadyingAction,
  ReadyingStep,
  ReadyingStepTiming,
  RemoteRowOutcome,
  Retrospective,
  ScratchEntry,
  StackLanding,
  StateQuery,
  TaskSummary,
  TenantPreparation,
  UpdateKind,
  ValidationCheck,
  ValidationCheckActor,
  ValidationCheckResultBy,
  ValidationCheckState,
  ValidationPlanRecord,
  ValidationStep,
  ValidationStepKind,
  ValidationVerdict,
  ViewerAssignment,
  WatchCheckVerdict,
  WatchHint,
  WatchOutcome,
  WatchOutcomeCheck,
  WatchPlanRecord,
  WatchReadingVerdict,
  WatchSourceDeclaration,
  WorkNode,
  WorldEvent,
} from './types.js';
export type { OperatorRow } from './insights/operatorInsights.js';
export type { SurfaceRow } from './insights/surfaceReachInsights.js';
export type { ControlUsage, PlaceKey, UiUsageEvent, UsageArrival, UsageSubject } from './usage/events.js';
export type { RecoveryVerdict, OrphanedWork } from './agents/crashRecovery.js';
export type { BuildReading, SnoozeTarget, UpgradeAction } from './selfUpdate/upgradePlan.js';
export type { AskGroup, AskKind, AskRow, AskUrgency } from './asks/askRow.js';
export { buildAskQueue } from './asks/queue.js';
export { askLine, oneLine } from './asks/lines.js';
export { INVESTIGATION_RESOLUTIONS } from './intake/investigationResolutions.js';
export { KIND_LABEL, KIND_SYMBOL, KIND_TONE } from './asks/kinds.js';
export { PART_GROUP, PART_GROUP_WORD, type PartGroup } from './plans/partGroup.js';
export { askGoal, type AskGoalPart } from './asks/askGoal.js';
export { projectName, upgradeHeadline } from './asks/updateAsks.js';
export { isProposed } from './validation/watchProposed.js';
export { PR_ON_YOU_REASONS, prOnYouReasons, type PrOnYouReason } from './listen/prsOnYou.js';
export { sameItem } from './listen/sameItem.js';
export type { CiPolicyDescription, CiRuleDescription, PolicyKindDescription } from './ci/describeCiPolicy.js';
export type { QueueItem } from './dispatcher/dispatcher.js';
export type { PromptTemplateDescription } from './dispatcher/promptTemplates.js';
export type { UnrecordedWork } from './graph/unrecorded.js';
export type { RunningConfigEntry, RunningConfigGroup } from './server/runningConfig.js';
export type { ConfigChange } from './config/configApply.js';
export type {
  CiHealth,
  CiSubject,
  ReliabilityInsights,
  RunOutcomeTotal,
  RunPhaseHealth,
  RunRepeat,
} from './insights/reliabilityInsights.js';
export type {
  ThroughputBucket,
  ThroughputConversation,
  ThroughputInsights,
  ThroughputLanding,
  ThroughputSubject,
  ThroughputTotal,
} from './insights/throughputInsights.js';
export type { RemedyCauseTotal, RemedyInsights, RemedyKindHealth } from './insights/remedyInsights.js';
export type { LessonInsights, LessonRow } from './insights/lessonInsights.js';
export type { ReviewAreaTotal, ReviewLabelInsights } from './insights/reviewLabelInsights.js';
export type { PrReviewState, PrReviewStatus } from './review/prReviewState.js';
export type { PoolRollupRow, PoolTrends } from './pool/aggregate.js';
export type { RunClearOut } from './runs/endRun.js';
export type {
  AllowanceApportionment,
  AllowanceGoal,
  AllowanceInsights,
  AllowanceLane,
  AllowanceProjection,
  AllowanceReading,
} from './insights/allowanceInsights.js';
export type { SpendGoal, SpendInsights, SpendPhase, SpendPhaseTotal, SpendRun } from './insights/spendInsights.js';
export type {
  McpChannelUsage,
  McpInsights,
  McpNamingTotal,
  McpPhaseUsage,
  McpQuietTool,
  McpRefusal,
  McpSilentRun,
  McpToolUsage,
} from './insights/mcpInsights.js';
export type { InsightsWindow, InsightsWindowView } from './insights/insightsWindow.js';
export type {
  SpendTrend,
  SpendTrendComparison,
  SpendTrendPhaseShift,
  SpendTrendBucket,
} from './insights/spendTrend.js';
export type { ChecksSpend, TaskTypeSpend } from './insights/taskTypeSpend.js';
export type { PlanDiff } from './plans/planDiff.js';
export type { CaveatAnswerInput } from './plans/planCaveats.js';
export type { AcceptanceCriterion } from './plans/parts.js';
export type { SupplyState } from './supply/runway.js';
export type { PlanningPolicy } from './plans/planning.js';
