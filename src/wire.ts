import type { FilingTarget } from './sink/actionSink.js';
import type { SetupReading } from './setup/reading.js';
import type { SetupResolution } from './setup/resolve.js';
import type { PlanDiff } from './plans/planDiff.js';
import type { AcceptanceCriterion } from './plans/parts.js';
import type { RunwayReading } from './supply/runway.js';
import type { PlanningPolicy } from './plans/planning.js';
import type { PetRules } from './pets/rules.js';
import type { CiPolicyDescription } from './ci/describeCiPolicy.js';
import type { CiVerdict } from './ci/ciPolicy.js';
import type { IssuePickupStatus } from './dispatcher/issuePickup.js';
import type { PlacementAsk } from './intake/placement.js';
import type { DispatchRule } from './dispatcher/rules.js';
import type { QueueItem } from './dispatcher/dispatcher.js';
import type { PromptTemplateDescription } from './dispatcher/promptTemplates.js';
import type { OrphanedWork } from './agents/crashRecovery.js';
import type { BuildReading } from './selfUpdate/upgradePlan.js';
import type { FileOverlap } from './fileOverlap.js';
import type { UnrecordedWork } from './graph/unrecorded.js';
import type { PrAttention } from './prAttention.js';
import type { PoolStatus } from './pool/poolDesk.js';
import type { PoolRollup } from './pool/aggregate.js';
import type { PrHealth } from './prHealth.js';
import type { PrPackStanding } from './reviewPacks/standing.js';
import type { PrReviewState } from './review/prReviewState.js';
import type { ControlState } from './runtimeControl.js';
import type { RunningConfigGroup } from './server/runningConfig.js';
import type { ConfigChange } from './configApply.js';
import type { ReliabilityInsights, RunTally } from './reliabilityInsights.js';
import type { ReviewCalibration } from './reviewPacks/calibration.js';
import type { RemedyInsights } from './remedyInsights.js';
import type { AllowanceInsights } from './allowanceInsights.js';
import type { SpendInsights } from './spendInsights.js';
import type { McpInsights } from './mcpInsights.js';
import type { OperatorInsights } from './operatorInsights.js';
import type { SurfaceReachInsights } from './surfaceReachInsights.js';
import type { SpendTrend } from './spendTrend.js';
import type { Stack } from './stacks/stack.js';
import type { LocalRunOption } from './localRun/ref.js';
import type {
  AccountRateLimits,
  Agent,
  AgentFile,
  AgentFlag,
  AppraisalAuthor,
  BugFiling,
  CiStatus,
  ConclusionAuthor,
  Decision,
  DeliveryAuthor,
  Ejection,
  EnvironmentGateRelease,
  EnvironmentHealthReading,
  ErrorLogEntry,
  Escalation,
  GoalArrival,
  GoalAppraisalVerdict,
  GoalPause,
  GoalEnvironmentReach,
  GoalReachStatus,
  HumanTask,
  IssueConclusionVerdict,
  IssueInstruction,
  IssueRelative,
  IssueRunOutcome,
  IssueState,
  IssueSpend,
  Issue as WorldIssue,
  Job,
  JobAttachment,
  Pet,
  PetActionKind,
  PetFlaw,
  PetProvenance,
  PetRarity,
  PetSpecies,
  PetStage,
  PetWallet,
  JobSchedule,
  AgentStatus,
  LocalRun,
  LocalValidation,
  LocalRunFreshness,
  LocalRunPorts,
  LocalRunTurn,
  ObstacleSighting,
  ObstacleStanding,
  Plan,
  PlanAmendmentAuthor,
  PlanCaveatAnswer,
  PlanPart,
  FeatureSequence,
  FeatureSummary,
  PlanRevision,
  Proposal,
  PrSplitVerdict,
  PrState,
  PullRequest as WorldPullRequest,
  ReadyingAction,
  Retrospective,
  ReviewAttention,
  ReviewMark,
  ReviewPackRecord,
  ReviewPackShare,
  ScratchEntry,
  ShortfallAuthor,
  ShortfallCause,
  StackLanding,
  GoalWatch,
  GoalWatchKind,
  WatchReading,
  WatchWindow,
  PoolFleetReading,
  StallPark,
  TaskSummary,
  ValidationCheck,
  ValidationResource,
  ValidationVerdict,
  WorkNode,
  WorldEvent,
  WorldSnapshot,
} from './types.js';

export interface PullRequest extends WorldPullRequest {
  health?: PrHealth;
  attention?: PrAttention;
  ciVerdict?: CiVerdict;
  pack?: PrPackStanding;
  review?: PrReviewState;
  split?: PrSplitVerdict;
}

export interface OpenPullRequest extends PullRequest {
  health: PrHealth;
  attention: PrAttention;
  ciVerdict: CiVerdict;
}

export interface Issue extends WorldIssue {
  pickup: IssuePickupStatus;
  stale?: {
    lastSeenAt: string;
    tracker: { state: IssueState; workItemState: string | null; changedAt: string } | null;
  };
  conclusion: {
    verdict: IssueConclusionVerdict | 'undeclared';
    by: ConclusionAuthor | 'plan' | null;
    note: string;
    at: string | null;
  };
  shortfall: {
    cause: ShortfallCause | null;
    partSlug: string | null;
    summary: string;
    by: ShortfallAuthor;
    decidedAt: string;
  } | null;
  delivery: {
    summary: string;
    by: DeliveryAuthor;
    decidedAt: string;
  } | null;
  appraisal: {
    verdict: GoalAppraisalVerdict;
    summary: string;
    missing: string[];
    by: AppraisalAuthor;
    decidedAt: string;
    commentRef: string | null;
    proposedProfile: string | null;
    awaitingProfileAnswer: boolean;
    placement: PlacementAsk[];
    parentSettledAt: string | null;
  } | null;
  modelPin: { profile: string | null; ignoredTags: string[] };
  priority: { since: string } | null;
  retrospective: { summary: string; hasDocument: boolean; updatedAt: string } | null;
  scratchpad: { entries: number; updatedAt: string } | null;
  instructions: IssueInstruction[];
  run?: { startedAt: string; completedAt: string | null; outcome: IssueRunOutcome | null; dismissed: boolean };
  validation: ValidationVerdict | null;
  localValidation: LocalValidationView | null;
  spend: IssueSpend | null;
}

export interface CockpitWorld extends WorldSnapshot {
  pullRequests: OpenPullRequest[];
  closedPullRequests?: PullRequest[];
  issues: Issue[];
  parentCandidates: IssueRelative[];
}

export interface LocalRunRefFacts {
  ref: string;
  isDefaultBranch: boolean;
  part: { slug: string; title: string; seq: number; total: number; status: PlanPart['status'] } | null;
  pr: {
    number: number;
    state: PrState;
    ciStatus: CiStatus;
    failing: string[];
    approved: boolean;
    unresolved: number;
  } | null;
  mergedParts: number;
  agentOnIt: boolean;
  lastActivityAt: string | null;
}

export type LocalValidationPhase = 'queued' | 'planning' | 'environment' | 'driving';

interface LocalValidationFile {
  name: string;
  url: string;
}

export interface LocalValidationAgentView {
  id: string;
  status: AgentStatus;
}

export interface LocalValidationView extends LocalValidation {
  phase: LocalValidationPhase | null;
  files: LocalValidationFile[];
  agent: LocalValidationAgentView | null;
  fixAgent: LocalValidationAgentView | null;
}

export interface LocalRunTargetView {
  originRef: string;
  issueNumber: number;
  target: LocalRunRefFacts;
  options: { option: LocalRunOption; facts: LocalRunRefFacts }[];
  runnable: boolean;
}

export interface LocalRunView extends LocalRun {
  live: boolean;
  refFacts: LocalRunRefFacts | null;
  phase: string | null;
  turn: LocalRunTurn | null;
  holdsSession: boolean;
  ports: LocalRunPorts | null;
  freshness: LocalRunFreshness | null;
}

export interface PlanPartView extends PlanPart {
  depth: number;
  acceptanceCriteria: AcceptanceCriterion[];
  outsideScope: string[];
}

export interface ValidationResourceView extends ValidationResource {
  path: string;
  present: boolean;
}

export interface PlanHistory {
  revisions: PlanRevision[];
  diff: PlanDiff | null;
  pending: PendingPlanAmendment | null;
}

export interface PendingPlanAmendment {
  id: string;
  note: string;
  author: PlanAmendmentAuthor;
  createdAt: string;
  diff: PlanDiff | null;
  warnings: string[];
}

export interface UpcomingPlan {
  cycleId: string;
  at: string;
  items: QueueItem[];
}

export interface CockpitDecision extends Decision {
  subjectRef: string | null;
}

interface StackLandingView {
  ref: string;
  offer: boolean;
  blockedBy: string | null;
  landing: StackLanding | null;
  landed: number;
}

interface CockpitConfig {
  ejectionEnabled: boolean;
  heartbeatIntervalMs: number;
  maxConcurrentAgents: number;
  watchLabel: string;
  profiles: { name: string; description: string }[];
  defaultProfile: string | null;
  desktopFolder: string;
  localRunConfigured: boolean;
  localRunStopConfigured: boolean;
  localRunRefreshConfigured: boolean;
  localValidationBrowserConfigured: boolean;
  containerTypes: string[];
  canFileTickets: boolean;
  stateColours: Record<string, string>;
  boardStates: string[];
  canSetWorkItemState: boolean;
  canCloseIssue: boolean;
  canClosePr: boolean;
  canPlaceWorkItem: boolean;
  featureBoard: boolean;
  areaPaths: string[];
  stateRules: { pickup: string[]; inProgress: string | null; inReview: string | null; returnsTo: string | null } | null;
}

interface CockpitUsage {
  windows: { fiveHourCostUsd: number; sevenDayCostUsd: number };
  rateLimits: AccountRateLimits | null;
  unattributedCostUsd: number;
}

export type StateSection = 'harness' | 'control' | 'goals' | 'plans' | 'fleet' | 'queue' | 'inbox' | 'activity';

export interface CockpitState {
  config: CockpitConfig;
  control: ControlState;
  worldObservedAt: string | null;
  world: CockpitWorld;
  recovery: OrphanedWork[];
  build: BuildReading;
  retainedRuns: Issue[];
  archivedPullRequests: PullRequest[];
  plans: Plan[];
  pets: PetState | null;
  localRun: LocalRunView | null;
  localRunTargets: LocalRunTargetView[];
  planParts: PlanPartView[];
  planCaveatAnswers: PlanCaveatAnswer[];
  validationChecks: ValidationCheck[];
  validationResources: ValidationResourceView[];
  goalWatches: GoalWatch[];
  planning: PlanningPolicy;
  stacks: Stack[];
  environmentReach: GoalReachView[];
  environmentHealth: EnvironmentHealthReading[];
  goalWatchWindows: GoalWatchView[];
  featureSequences: FeatureSequence[];
  environmentArrivals: GoalArrival[];
  stackLandings: StackLandingView[];
  tasks: TaskSummary[];
  jobs: Job[];
  schedules: JobSchedule[];
  agents: Agent[];
  endedAgents: number;
  ejections: EjectionView[];
  readying: ReadyingAction[];
  parkedOnLimit: string[];
  stallParks: StallPark[];
  flags: AgentFlag[];
  artifactUrls: Record<string, string>;
  attachments: JobAttachment[];
  attachmentUrls: Record<string, string>;
  overlaps: FileOverlap[];
  bugFilings: BugFiling[];
  humanTasks: HumanTask[];
  escalations: Escalation[];
  proposals: Proposal[];
  decisions: CockpitDecision[];
  upcoming: UpcomingPlan | null;
  runway: RunwayReading;
  worldEvents: WorldEvent[];
  errors: ErrorLogEntry[];
  usage: CockpitUsage;
  runOutcomes: RunTally;
  refUrls: Record<string, string>;
  dispatchRules: Record<string, DispatchRule>;
}

export interface EjectionView extends Ejection {
  expiresAt: string | null;
  neverContacted: boolean;
}

export interface GoalReachView {
  goalRef: string;
  environments: GoalEnvironmentReach[];
  gateHold: string | null;
  released: EnvironmentGateRelease | null;
}

export interface GoalWatchView extends WatchWindow {
  checks: GoalWatchCheckView[];
}

export interface GoalWatchCheckView {
  checkId: string;
  title: string;
  kind: GoalWatchKind;
  tolerate: number;
  expectUnder: number | null;
  expectOver: number | null;
  expectBaseline: boolean;
  unit: string | null;
  baselineValue: number | null;
  reading: WatchReading | null;
}

export interface AgentTranscript {
  agentId: string;
  from: number;
  total: number;
  transcript: string;
}

export interface AgentFilesPayload {
  agentId: string;
  files: AgentFile[];
}

export interface GoalAgentsPayload {
  ref: string;
  agents: Agent[];
  tasks: TaskSummary[];
}

export interface WorkRootsPayload {
  roots: WorkNode[];
  unrecorded: UnrecordedWork[];
  refUrls: Record<string, string>;
}

export interface WorkSubtreePayload {
  nodes: WorkNode[];
  refUrls: Record<string, string>;
}

export type TicketWatchFilter = 'any' | 'watched' | 'unwatched';
export type TicketTrackingFilter = 'any' | 'live' | 'frozen';
export type TicketStateFilter = string;
export type TicketOrder = 'added' | 'changed' | 'cost';

export interface TicketStateFacet {
  state: string;
  count: number;
  live: number;
  pickup: boolean;
}

export interface TicketFeatureFacet {
  number: number;
  title: string;
  slot: number;
  count: number;
}

export interface TicketRow {
  number: number;
  title: string;
  state: IssueState;
  watch: TicketWatchFilter & ('watched' | 'unwatched');
  labels: string[];
  costUsd: number | null;
  outcome: string | null;
  addedAt: string;
  changedAt: string;
  tracking: 'live' | 'frozen';
  workItemState: string | null;
  issueType: string | null;
  parent?: { number: number; title: string } | null;
  featureSlot: number | null;
}

export type FilingTargetProbe =
  | ({
      available: true;
      reason: null;
      watchable: boolean;
    } & FilingTarget)
  | {
      available: false;
      target: null;
      identity: null;
      reason: string;
    };

export interface IssueFiled {
  ok: true;
  number: number;
  url: string;
}

export interface TicketsPayload {
  rows: TicketRow[];
  total: number;
  kept: number;
  totalCostUsd: number;
  nextCursor: string | null;
  anchorAt: string;
  backfilling: boolean;
  live: number;
  states: TicketStateFacet[];
  features: TicketFeatureFacet[];
  orphanCount: number;
  refUrls: Record<string, string>;
}

export type FeatureChildStanding = 'delivered' | 'inFlight' | 'queued' | 'fellShort' | 'settled' | 'unwatched';

export interface FeatureChildRow {
  number: number;
  title: string;
  issueType: string | null;
  standing: FeatureChildStanding;
  outcome: string | null;
  workItemState: string | null;
  costUsd: number | null;
  changedAt: string;
}

export interface FeatureCounts {
  delivered: number;
  inFlight: number;
  queued: number;
  fellShort: number;
  settled: number;
  unwatched: number;
  total: number;
}

export interface FeatureReach {
  environment: string;
  status: GoalReachStatus;
  goals: number;
  total: number;
}

export interface FeatureWorkingRow {
  number: number;
  title: string;
  since: string;
}

export interface FeatureReportRow {
  number: number;
  title: string;
  summary: string;
  by: string;
  at: string;
}

type FeatureBlockKind = 'question' | 'fellShort';

export interface FeatureBlockRow {
  number: number;
  title: string;
  kind: FeatureBlockKind;
  summary: string;
  since: string;
}

export interface FeatureBriefing {
  working: FeatureWorkingRow[];
  workingTotal: number;
  delivered: FeatureReportRow[];
  deliveredTotal: number;
  blocking: FeatureBlockRow[];
  blockingTotal: number;
}

export interface FeatureRollup {
  number: number;
  title: string;
  slot: number;
  workItemState: string | null;
  issueType: string | null;
  counts: FeatureCounts;
  briefing: FeatureBriefing;
  children: FeatureChildRow[];
  costUsd: number | null;
  reach: FeatureReach[];
  summary: FeatureSummary | null;
  sequence: FeatureSequence | null;
  lastLandingAt: string | null;
  landings: FeatureLandingRow[];
  standingKey: string;
  paused: GoalPause | null;
}

export interface FeatureLandingRow {
  goal: number;
  prNumber: number;
  at: string;
}

export interface FeatureBoardPayload {
  features: FeatureRollup[];
  orphans: Omit<
    FeatureRollup,
    | 'number'
    | 'title'
    | 'slot'
    | 'workItemState'
    | 'issueType'
    | 'reach'
    | 'summary'
    | 'sequence'
    | 'standingKey'
    | 'paused'
  > | null;
  unresolved: number;
  environments: string[];
  backfilling: boolean;
  refUrls: Record<string, string>;
}

export interface RetrospectivePayload {
  retrospective: Retrospective | null;
}

export interface ScratchpadPayload {
  padRef: string;
  entries: ScratchEntry[];
}

export interface ReviewPackPayload extends ReviewPackRecord {
  marks: ReviewMark[];
  head: string | null;
  stale: { headSha: string; commitsBehind: number | null } | null;
  checking: boolean;
  sharing: ReviewPackSharing;
}

export interface ReviewPackSharing {
  available: boolean;
  share: ReviewPackShare | null;
}

export interface ReviewPackAbsence {
  error: string;
  writing: boolean;
}

export interface ReviewReadBody {
  read: boolean;
}

export interface ReviewAttentionBody {
  attention: ReviewAttention | null;
}

export interface ReviewSeenBody {
  seen: boolean;
}

export interface ReviewMarksPayload {
  marks: ReviewMark[];
}

export interface ReviewCalibrationPayload {
  calibration: ReviewCalibration;
}

export interface SpendPayload {
  insights: SpendInsights;
}

export interface AllowancePayload {
  allowance: AllowanceInsights;
  refUrls: Record<string, string>;
}

export interface SpendTrendPayload {
  trend: SpendTrend;
}

export interface McpUsagePayload {
  insights: McpInsights;
}

export interface UsagePayload {
  insights: OperatorInsights;
  reach: SurfaceReachInsights;
}

export interface ReliabilityPayload {
  insights: ReliabilityInsights;
  remedies: RemedyInsights;
}

export interface PromptsPayload {
  dir: string | null;
  templates: PromptTemplateDescription[];
}

export type SetupPayload = SetupReading;

export type SetupResolvePayload = SetupResolution;

export type { SetupCheck, SetupFix, SetupVerdict } from './setup/reading.js';
export type { RemoteTarget } from './setup/remote.js';

export interface RunningConfigPayload {
  groups: RunningConfigGroup[];
  file: string;
  projectFile: string | null;
  text: string;
  revision: string;
  pending: readonly ConfigChange[];
  canRestart: boolean;
}

export interface ConfigPreviewPayload {
  ok: true;
  text: string;
  changes: readonly ConfigChange[];
}

export interface ConfigSavePayload {
  ok: true;
  revision: string;
  changes: readonly ConfigChange[];
  pending: readonly ConfigChange[];
}

export interface CiPolicyPayload {
  policy: CiPolicyDescription;
}

export type {
  Agent,
  AgentAskQuestion,
  AgentFile,
  AgentFlag,
  BugFiling,
  Decision,
  Ejection,
  EjectionOutcome,
  EnvironmentGate,
  EnvironmentGateRelease,
  EnvironmentHealthReading,
  EnvironmentHealthState,
  EnvironmentHealthTier,
  ErrorLogEntry,
  Escalation,
  GoalArrival,
  GoalEnvironmentReach,
  GoalReachStatus,
  HumanTask,
  IssueRelative,
  IssueSpend,
  Job,
  JobAttachment,
  JobAttachmentInput,
  JobSchedule,
  Obstacle,
  LocalValidation,
  LocalValidationFinding,
  LocalValidationStatus,
  ObstacleKey,
  ObstacleSighting,
  ObstacleStanding,
  ObstacleState,
  Plan,
  PlanAmendmentAuthor,
  PlanCaveat,
  PlanCaveatAnswer,
  PlanEvidence,
  PlanNarrative,
  PlanPart,
  PlanPartInput,
  PlanRevision,
  PrReviewThread,
  PrThreadMessage,
  PrThreadState,
  Pet,
  PetActionKind,
  PetFlaw,
  PetRarity,
  PetSpecies,
  PetStage,
  PetWallet,
  FeatureSequence,
  FeatureSequenceEdge,
  FeatureSummary,
  Proposal,
  ReadyingAction,
  ReadyingStep,
  Retrospective,
  ReviewAnchor,
  ReviewAttention,
  ReviewClaim,
  ReviewFinding,
  ReviewIdea,
  ReviewMark,
  ReviewNote,
  ReviewPack,
  ReviewPackShare,
  ReviewRange,
  ReviewVerdict,
  ScratchEntry,
  GoalWatch,
  GoalWatchDeclaration,
  GoalWatchInput,
  GoalWatchKind,
  GoalWatchProposal,
  StackLanding,
  StallPark,
  TaskSummary,
  ValidationCheck,
  ValidationCheckState,
  ValidationResource,
  ValidationResourceKind,
  ValidationVerdict,
  ViewerAssignment,
  WatchCheckVerdict,
  WatchReading,
  WatchReadingVerdict,
  WatchWindow,
  WorkNode,
  WorldEvent,
  WorldEventKind,
} from './types.js';
export type { OperatorInsights, OperatorRow, OperatorRowKind } from './operatorInsights.js';
export type { SurfaceReachInsights, SurfaceRow, SurfaceVerdict } from './surfaceReachInsights.js';
export type { PlaceKey, UiUsageEvent, UsageArrival, UsageSubject, UsageVerb } from './usage/events.js';
export type { RecoveryVerdict, OrphanedWork } from './agents/crashRecovery.js';
export type { BuildReading, SnoozeStamps, SnoozeTarget, UpgradeAction } from './selfUpdate/upgradePlan.js';
export type { BuildStanding } from './selfUpdate/buildStanding.js';
export type { CiPolicyDescription, CiRuleDescription, PolicyKindDescription } from './ci/describeCiPolicy.js';
export type { QueueItem } from './dispatcher/dispatcher.js';
export type { DispatchRule } from './dispatcher/rules.js';
export type { PromptTemplateDescription } from './dispatcher/promptTemplates.js';
export type { FileOverlap } from './fileOverlap.js';
export type { UnrecordedWork } from './graph/unrecorded.js';
export type { RunningConfigGroup } from './server/runningConfig.js';
export type { RunningConfigEntry } from './server/runningConfig.js';
export type { ConfigChange } from './configApply.js';
export type {
  CiHealth,
  CiSubject,
  ReliabilityInsights,
  RunOutcome,
  RunOutcomeTotal,
  RunPhaseHealth,
  RunRepeat,
  RunTally,
} from './reliabilityInsights.js';
export type {
  ReviewCalibration,
  ReviewOverridePair,
  ReviewOverrideReading,
  ReviewPlumbingPack,
  ReviewPlumbingReading,
  ReviewProminenceReading,
} from './reviewPacks/calibration.js';
export type { RemedyCauseTotal, RemedyInsights, RemedyKindHealth, RemedyRow } from './remedyInsights.js';
export type { RemedyCause, RemedyGuard, RemedyKind } from './types.js';
export type { McpChannel } from './types.js';
export type { CiCheck } from './types.js';
export type { PrComment } from './types.js';
export type { PoolClockKind, PoolDigestRow, PoolFleetReading, PoolPublication } from './types.js';
export type { PoolStatus } from './pool/poolDesk.js';
export type { PrReviewState, PrReviewStatus } from './review/prReviewState.js';
export type { PrPackStanding } from './reviewPacks/standing.js';
export type { PoolRollup, PoolRollupRow } from './pool/aggregate.js';
export type { RunClearOut } from './floor/endRun.js';
export type {
  AllowanceApportionment,
  AllowanceGoal,
  AllowanceInsights,
  AllowanceLane,
  AllowanceProjection,
  AllowanceReading,
} from './allowanceInsights.js';
export type { SpendGoal, SpendInsights, SpendPhase, SpendPhaseTotal, SpendRun } from './spendInsights.js';
export type { LocalRunFreshness, LocalRunPorts, LocalRunTurn } from './types.js';
export type {
  McpChannelUsage,
  McpInsights,
  McpNaming,
  McpNamingTotal,
  McpPhaseUsage,
  McpQuietTool,
  McpRefusal,
  McpSilentRun,
  McpToolUsage,
} from './mcpInsights.js';
export type { InsightsWindow, InsightsWindowView } from './insightsWindow.js';
export type {
  SpendTrend,
  SpendTrendComparison,
  SpendTrendPeriod,
  SpendTrendPhaseShift,
  SpendTrendBucket,
} from './spendTrend.js';
// → docs/spec/16-http-api.md

export type { ChecksSpend, TaskTypeSpend } from './taskTypeSpend.js';
export type { Stack } from './stacks/stack.js';
export type { PlanDiff } from './plans/planDiff.js';
export type { CaveatAnswerInput } from './plans/planCaveats.js';
export type { AcceptanceCriterion } from './plans/parts.js';
export type { SupplyState } from './supply/runway.js';
export type { PlanningPolicy } from './plans/planning.js';
export type { PetRules } from './pets/rules.js';
export type { ValidationPolicy } from './validation/policy.js';
export type { LocalRunOption } from './localRun/ref.js';

export interface PetView extends Pet {
  rarity: PetRarity;
  display: string;
  stage: PetStage;
  beatsToNextStage: number | null;
  flaw: PetFlaw | null;
  originLabel: string | null;
  provenance: PetProvenance;
}

export interface PetCatalogueEntry {
  species: PetSpecies;
  display: string;
  rarity: PetRarity;
  growth: number;
  juvenileAt: number;
  adultAt: number;
  blend: number;
  share: number;
  kinds: PetActionKind[];
  hours: number[] | null;
}

export interface PetCatalogueSource {
  kind: PetActionKind;
  rolled: PetRarity;
  landed: PetRarity;
  members: PetSpecies[];
}

export interface PetCatalogue {
  rules: PetRules;
  rarities: PetRarity[];
  species: PetCatalogueEntry[];
  sources: PetCatalogueSource[];
}

export interface PetState {
  pets: PetView[];
  wallet: PetWallet;
  slots: number;
  startedAt: string | null;
}

export interface McpChannelPayload {
  running: boolean;
  serverId: string;
  registration: { command: string; args: string[] };
  credentialPath: string;
  skillPath: string;
  tools: { name: string; description: string }[];
}

export interface PoolStatePayload {
  status: PoolStatus | null;
  fleets: PoolFleetReading[];
}

export interface PoolInsightsPayload {
  rollup: PoolRollup;
  projects: string[];
  fleets: PoolFleetReading[];
}

export interface ObstacleBoardRow extends ObstacleStanding {
  sightings: ObstacleSighting[];
}

export interface ObstacleBoardCounts {
  sightings: number;
  goals: number;
  told: number;
  window: ObstacleCallRate;
}

export interface ObstacleCallRate {
  since: string;
  calls: number;
  callers: number;
  agents: number;
}

export interface ObstacleBoardPayload {
  rows: ObstacleBoardRow[];
  counts: ObstacleBoardCounts;
  dormantMs: number;
  canFileTickets: boolean;
}
