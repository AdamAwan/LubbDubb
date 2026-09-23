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
import type { PrAttention } from './pr/prAttention.js';
import type { PoolStatus } from './pool/poolDesk.js';
import type { PoolRollup } from './pool/aggregate.js';
import type { PrHealth } from './pr/prHealth.js';
import type { PrPackStanding } from './reviewPacks/standing.js';
import type { PrReviewState } from './review/prReviewState.js';
import type { ControlState } from './runtimeControl.js';
import type { RunningConfigGroup } from './server/runningConfig.js';
import type { ConfigChange } from './config/configApply.js';
import type { ReliabilityInsights, RunTally } from './insights/reliabilityInsights.js';
import type { ThroughputInsights } from './insights/throughputInsights.js';
import type { ReviewCalibration } from './reviewPacks/calibration.js';
import type { RemedyInsights } from './insights/remedyInsights.js';
import type { ReviewLabelInsights } from './insights/reviewLabelInsights.js';
import type { AllowanceInsights } from './insights/allowanceInsights.js';
import type { SpendInsights } from './insights/spendInsights.js';
import type { McpInsights } from './insights/mcpInsights.js';
import type { ApiErrorInsights } from './insights/apiErrorInsights.js';
import type { OperatorInsights } from './insights/operatorInsights.js';
import type { SurfaceReachInsights } from './insights/surfaceReachInsights.js';
import type { SpendTrend } from './insights/spendTrend.js';
import type { PredictionAggregate } from './insights/predictionAggregate.js';
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
  EnvironmentGate,
  EnvironmentGateRelease,
  EnvironmentHealthReading,
  ErrorLogEntry,
  Escalation,
  GoalArrival,
  GoalAppraisalVerdict,
  GoalCriteriaDrift,
  GoalPause,
  GoalPriority,
  GoalEnvironmentReach,
  GoalGroupReach,
  GoalLandingReach,
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
  PlanAtom,
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
  RemoteReading,
  RemoteRun,
  RemoteSheet,
  RemoteSheetRow,
  ReviewPackRecord,
  ReviewPackShare,
  ScratchEntry,
  ShortfallAuthor,
  ShortfallCause,
  StateQuery,
  TenantPreparation,
  TenantStanding,
  StackLanding,
  GoalWatch,
  GoalWatchKind,
  WatchReading,
  WatchWindow,
  PoolFleetReading,
  StallPark,
  TaskSummary,
  ValidationCheck,
  ValidationPlanRecord,
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

/**
 * A part waiting on somebody to say what its pull request does.
 *
 * It carries the pull request's number rather than leaving the cockpit to find it on
 * the part: `plan_parts.pr_number` is a reading of the world filled in by a later
 * cycle, and the ask is raised off the record `open_pr` wrote at the open.
 * → docs/spec/07-pull-requests.md#the-rail-asks-for-it-and-nothing-waits-on-the-answer
 */
export interface UndescribedPart {
  originRef: string;
  prNumber: number;
  openedAt: string;
}

export interface PlanPartView extends PlanPart {
  depth: number;
  acceptanceCriteria: AcceptanceCriterion[];
  outsideScope: string[];
}

/**
 * A plan, plus whether its body is in the payload at all. While the reveal gate is on, a plan
 * `awaiting_approval` that has no reveal stamp ships with every narrative field null, no evidence,
 * no parts and no atoms — the ordering the record rests on is a server fact, not a blur the page
 * draws over a body that is already on the wire. `revealed` false is the cockpit's cue to draw the
 * gate rather than an empty plan; with the gate off it is true on every plan and nothing branches.
 * → docs/spec/16-http-api.md
 */
export interface PlanView extends Plan {
  revealed: boolean;
  revealedAt: string | null;
}

export interface ValidationResourceView extends ValidationResource {
  path: string;
  present: boolean;
}

/**
 * A check, plus where its capture can actually be looked at. The row carries the capture's **name**;
 * a surface needs a URL, and minting one is the server's job — a cockpit that assembled the path
 * itself would be a second opinion about where the goal's validation directory is.
 * → docs/spec/36-remote-validation.md#handing-a-screen-back-to-look-at
 */
export interface ValidationCheckView extends ValidationCheck {
  captureUrl: string | null;
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

/**
 * One environment as the cockpit is told about it: its name, what arriving there opens, and
 * whether it is watched. The *declaration*, not a goal's reading of it — `GoalEnvironmentReach`
 * is the reading — because the goal page's obligation tabs are the deployment's shape and must
 * not change between two goals on it.
 * → docs/spec/17-cockpit.md#the-panes
 */
export interface CockpitEnvironment {
  name: string;
  /** `arrival.opens`, empty where arriving here opens nothing. */
  opens: EnvironmentGate[];
  /** The environment declares a `watch` block, so an arrival here opens a watch window. */
  watched: boolean;
}

interface CockpitConfig {
  /** Every environment, in promotion order — the order the obligations come due in. */
  environments: CockpitEnvironment[];
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
  featureSummaries: boolean;
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
  plans: PlanView[];
  pets: PetState | null;
  localRun: LocalRunView | null;
  localRunTargets: LocalRunTargetView[];
  planParts: PlanPartView[];
  /**
   * Parts whose pull request is open and which nobody has described.
   *
   * It is the server's list rather than the cockpit's subtraction because the
   * described set is not on the wire at all — the goal page reads it per goal, and
   * the rail is drawn over every goal at once.
   * → docs/spec/07-pull-requests.md#the-rail-asks-for-it-and-nothing-waits-on-the-answer
   */
  undescribedParts: UndescribedPart[];
  planAtoms: PlanAtom[];
  planCaveatAnswers: PlanCaveatAnswer[];
  validationChecks: ValidationCheckView[];
  /**
   * One record per goal, both halves of it: the plan document's `hint` and the validation planner's
   * `note` and `emptyReason`. It is on the wire because **an empty check set has no check to hang
   * its account on** — the row is where the *how* of a check lives, and a goal that was considered
   * and given no checks draws no row at all, so without this the only surface an operator meets says
   * nothing was planned. → docs/spec/20-validation.md#saying-nothing-was-worth-running
   */
  validationPlans: ValidationPlanRecord[];
  validationResources: ValidationResourceView[];
  goalWatches: GoalWatch[];
  stateQueries: StateQuery[];
  planning: PlanningPolicy;
  stacks: Stack[];
  environmentReach: GoalReachView[];
  environmentHealth: EnvironmentHealthReading[];
  /**
   * The bands the configured environments are read in — one entry per declared `group`, naming
   * its members in the order they are configured. Shipped as the list rather than a field on
   * every row because membership is configuration, not a reading: a group an operator declared
   * and nothing has landed in yet still has to draw, and two surfaces deriving the band from
   * rows they happen to hold is two places for it to disagree.
   * → docs/spec/24-environments.md#groups
   */
  environmentGroups: EnvironmentGroupView[];
  goalWatchWindows: GoalWatchView[];
  featureSequences: FeatureSequence[];
  environmentArrivals: GoalArrival[];
  /**
   * Goals whose criteria changed after work had started. Its own list, never a
   * `WorldEvent` — `deliveryHold` expires a standing delivery verdict on any world
   * event matching the goal's issue ref, so drift written as one would un-park the
   * goal it just reported on. The cockpit merges these at the feed's door, exactly
   * as it merges `environmentArrivals`. Absent when `goalCriteria.enabled` is off:
   * that flag is read here and in `src/system.ts`, and nowhere downstream.
   */
  criteriaDrift?: GoalCriteriaDrift[];
  remoteSheets: RemoteSheetView[];
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

/** One declared group of environments, drawn as the one place it stands for. */
interface EnvironmentGroupView {
  name: string;
  environments: string[];
}

export interface GoalReachView {
  goalRef: string;
  environments: GoalEnvironmentReachView[];
  /** The declared groups, rolled up over the rows above. Empty where none is declared. */
  groups: GoalGroupReach[];
  /** Every landing this goal owns, with what each environment said about it. The rows the
   *  counts on `environments` are the AND over — shipped so the cockpit can say which
   *  landing is holding the goal short rather than only how many are. */
  landings: GoalLandingReach[];
  gateHold: string | null;
  released: EnvironmentGateRelease | null;
}

/**
 * One environment's row on the Environments card. The sheet's line is folded on the **server**, off
 * the same rows the sheet card above it draws — a cockpit that worked it out for itself would be a
 * second opinion drawn beside the reading it describes.
 */
export interface GoalEnvironmentReachView extends GoalEnvironmentReach {
  /** `check plan · 4 checks · 1 blocked`, or null where this goal has no check plan against this environment. */
  sheet: string | null;
}

/**
 * One goal's sheet against one environment, with every row's reading folded in on the server. The
 * cockpit renders what the server read; it never re-decides an outcome.
 */
export interface RemoteSheetView extends RemoteSheet {
  rows: RemoteSheetRowView[];
  /** The latest run against this environment, live or ended. Null before anything was ever pressed. */
  run: RemoteRunView | null;
  /** Which tenant this sheet is put to, how old it is, and why there is none. */
  tenant: RemoteTenantView;
}

export type RemoteRunView = RemoteRun;

/**
 * What the gate draws about a tenant. It carries the name a surface may draw — a literal `tenant`,
 * or the *variable's* own name where the shape is `tenantEnv` — and never a `tenantEnv`'s value,
 * which goes into the spawn env and nowhere else.
 */
export interface RemoteTenantView extends TenantStanding {
  /** Whether the environment declares an `ensureTenant` or a `reseed` for the gate's own control. */
  reseedable: boolean;
  /**
   * Whether pressing that control runs a `reseed` — a command that destroys the tenant's data. An
   * environment declaring only `ensureTenant` provisions and destroys nothing, so the gate must not
   * warn about a wipe that will not happen.
   */
  destructive: boolean;
  /**
   * The preparation running right now, or the last one that ran. Null before anything was ever
   * pressed. `finishedAt` null is **still running** — which is what an operator who pressed a command
   * that takes tens of minutes has otherwise no way to learn.
   */
  preparation: TenantPreparation | null;
}

export interface RemoteSheetRowView extends RemoteSheetRow {
  /** The latest reading on this row, or null where none was taken — a blocked row, or a manual one. */
  reading: RemoteReadingView | null;
}

/**
 * A reading, with the way to the agent that produced it. The chain is `runId` → `RemoteRun.taskId` →
 * `tasks.agentId`, walked on the server: the cockpit is handed the agent's own id because that is
 * what opens a transcript, and a surface that had to walk two stores to draw a link would be a second
 * copy of the join. Both are null on a reading no run took — the press's own deterministic rows — and
 * on one whose run never got an agent.
 * → docs/spec/36-remote-validation.md#the-reading-an-agent-produced
 */
export interface RemoteReadingView extends RemoteReading {
  /** The task the run was dispatched as. */
  taskId: string | null;
  /** The agent that ran it, which is the transcript's own key — `GET /api/agents/:id/transcript`. */
  agentId: string | null;
  /**
   * Where this row's own capture can be looked at, keyed on the run and the row. The row carries the
   * capture's **name**; minting a URL is the server's job, `ValidationCheckView.captureUrl`'s reason.
   * Null where the row handed back no screen — and on a reading no run took, which can hand none back.
   * → docs/spec/36-remote-validation.md#where-a-sheet-kept-capture-is-looked-at
   */
  captureUrl: string | null;
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
  priority: GoalPriority | null;
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
    | 'priority'
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

export interface PredictionAggregatePayload {
  aggregate: PredictionAggregate;
}

export interface ApiErrorsPayload {
  insights: ApiErrorInsights;
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
  reviewLabels: ReviewLabelInsights;
}

export interface ThroughputPayload {
  insights: ThroughputInsights;
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
  GoalCriteriaDrift,
  GoalCriteriaVersion,
  CriteriaStanding,
  GoalEnvironmentReach,
  GoalGroupReach,
  GoalLandingReach,
  GoalPrediction,
  GoalReachStatus,
  GoalReveal,
  HumanTask,
  IssueRelative,
  IssueSpend,
  Job,
  JobAttachment,
  JobAttachmentInput,
  JobSchedule,
  DescriptionFinding,
  DescriptionFindingKind,
  DescriptionQuestion,
  PrDescriptionDraft,
  PrDescriptionVersion,
  PredictionMark,
  PredictionOutcomeMarks,
  PredictionPlanMarks,
  PredictionSlot,
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
  PlanAtom,
  PlanAtomRejection,
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
  ReadyingStepTiming,
  Retrospective,
  ReviewAnchor,
  ReviewAttention,
  ReviewClaim,
  ReviewFinding,
  ReviewIdea,
  ReviewMark,
  ReviewNote,
  RemoteReading,
  RemoteRun,
  RemoteRowKind,
  RemoteRowOutcome,
  RemoteSheet,
  RemoteSheetRow,
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
  StateQuery,
  TaskSummary,
  TenantPreparation,
  TenantStanding,
  CheckDecline,
  ProposedCheck,
  ValidationCheck,
  ValidationCheckActor,
  ValidationCheckResultBy,
  ValidationCheckState,
  ValidationPlanRecord,
  ValidationResource,
  ValidationResourceKind,
  ValidationStep,
  ValidationStepKind,
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
export type { OperatorInsights, OperatorRow, OperatorRowKind } from './insights/operatorInsights.js';
export type { SurfaceReachInsights, SurfaceRow, SurfaceVerdict } from './insights/surfaceReachInsights.js';
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
export type { ConfigChange } from './config/configApply.js';
export type {
  CiHealth,
  CiSubject,
  ReliabilityInsights,
  RunOutcome,
  RunOutcomeTotal,
  RunPhaseHealth,
  RunRepeat,
  RunTally,
} from './insights/reliabilityInsights.js';
export type {
  ThroughputBucket,
  ThroughputConversation,
  ThroughputInsights,
  ThroughputLanding,
  ThroughputMeasure,
  ThroughputSubject,
  ThroughputTotal,
} from './insights/throughputInsights.js';
export type {
  ReviewCalibration,
  ReviewOverridePair,
  ReviewOverrideReading,
  ReviewPlumbingPack,
  ReviewPlumbingReading,
  ReviewProminenceReading,
} from './reviewPacks/calibration.js';
export type { RemedyCauseTotal, RemedyInsights, RemedyKindHealth, RemedyRow } from './insights/remedyInsights.js';
export type { ReviewAreaTotal, ReviewLabelInsights } from './insights/reviewLabelInsights.js';
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
} from './insights/allowanceInsights.js';
export type { SpendGoal, SpendInsights, SpendPhase, SpendPhaseTotal, SpendRun } from './insights/spendInsights.js';
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
} from './insights/mcpInsights.js';
export type { InsightsWindow, InsightsWindowView } from './insights/insightsWindow.js';
export type {
  SpendTrend,
  SpendTrendComparison,
  SpendTrendPeriod,
  SpendTrendPhaseShift,
  SpendTrendBucket,
} from './insights/spendTrend.js';
// → docs/spec/16-http-api.md

export type { PredictionAggregate } from './insights/predictionAggregate.js';

export type { ChecksSpend, TaskTypeSpend } from './insights/taskTypeSpend.js';
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
  ticketApproval: boolean;
}

/**
 * The one runtime this contract carries, and the only value the cockpit imports
 * from the harness: the review-pack derivations. They are pure functions of the
 * pack document — the numbering, the false-claim list, the facts line, the code
 * block, the highlighter — read by the HTML companion server-side and by the
 * cockpit's page, which is why they may not be two copies.
 * `src/reviewPacks/derive.ts` is a leaf: it imports `src/types.ts` for types and
 * nothing else, so nothing server-only rides in with it. `test/wireRuntime.test.ts`
 * holds that. → docs/spec/31-review-packs.md#one-copy-of-the-derivations
 */
export {
  anchorWeight,
  codeBlockLines,
  codeLanguage,
  falseClaims,
  highlightCode,
  ideaAtom,
  ideaFlags,
  numberIdeas,
  packFacts,
  plainSummary,
  shortSha,
  splitBody,
  testScenarios,
} from './reviewPacks/derive.js';
export type { FalseClaim, NumberedIdea } from './reviewPacks/derive.js';
