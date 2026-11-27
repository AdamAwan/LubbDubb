import type { OrphanedWork } from '../agents/crashRecovery.js';
import type { AskRow } from '../asks/askRow.js';
import type { DispatchRule } from '../dispatcher/rules.js';
import type { FileOverlap } from '../fileOverlap.js';
import type { RunTally } from '../insights/reliabilityInsights.js';
import type { PlanningPolicy } from '../plans/planning.js';
import type { ControlState } from '../runtimeControl.js';
import type { BuildReading } from '../selfUpdate/upgradePlan.js';
import type { Stack } from '../stacks/stack.js';
import type { RunwayReading } from '../supply/runway.js';
import type {
  AccountRateLimits,
  Agent,
  AgentProgress,
  AgentFlag,
  BugFiling,
  Decision,
  Ejection,
  EnvironmentGate,
  EnvironmentGateRelease,
  EnvironmentHealthReading,
  ErrorLogEntry,
  FleetStall,
  Escalation,
  FeatureSequence,
  GoalArrival,
  GoalEnvironmentReach,
  GoalGroupReach,
  GoalLandingReach,
  GoalWatch,
  HumanTask,
  Job,
  JobAttachment,
  JobSchedule,
  ListenerView,
  NoSheet,
  PlanAtom,
  PlanCaveatAnswer,
  Proposal,
  ReadyingAction,
  StackLanding,
  StallPark,
  StateQuery,
  TaskSummary,
  ValidationPlanRecord,
  WatchOutcome,
  WatchPlanRecord,
  WatchSourceDeclaration,
  WorldEvent,
} from '../types.js';
import type { LocalRunTargetView, LocalRunView } from './localRuns.js';
import type { PetState } from './pets.js';
import type {
  DescriptionFeedback,
  PlanPartView,
  PlanView,
  UndescribedPart,
  UpcomingPlan,
  ValidationCheckView,
  ValidationResourceView,
} from './plans.js';
import type { RemoteSheetView, TenantCommandView } from './remoteValidation.js';
import type { GoalWatchView, WatchAskView } from './watch.js';
import type { CockpitWorld, Issue, PullRequest } from './world.js';

export interface CockpitDecision extends Decision {
  subjectRef: string | null;
}

interface StackLandingView {
  ref: string;
  offer: boolean;
  blockedBy: string | null;
  blockedPr: number | null;
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
  /** The sources its `watch` answers from, `observe` alone read as one; empty where it declares no watch. */
  watchSources: WatchSourceDeclaration[];
  /** The environment declares a `validate` block, so a goal's work arriving here can be run remotely. */
  validates: boolean;
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
  /** What the tracker is called on a button that writes to it — `null` where it is neither. */
  trackerName: 'GitHub' | 'ADO' | null;
  canClosePr: boolean;
  canPlaceWorkItem: boolean;
  featureBoard: boolean;
  featureSummaries: boolean;
  /** `discussionsDir` is set, so the goal page draws its Discussion tab. → docs/spec/40-discussions.md#in-the-cockpit */
  discussions: boolean;
  botPrs: boolean;
  /** Some environment declares an `errors` block, so the Errors tab has something to read. */
  appErrors: boolean;
  areaPaths: string[];
  stateRules: { pickup: string[]; inProgress: string | null; inReview: string | null; returnsTo: string | null } | null;
}

interface CockpitUsage {
  windows: { fiveHourCostUsd: number; sevenDayCostUsd: number };
  rateLimits: AccountRateLimits | null;
  unattributedCostUsd: number;
}

export type StateSection =
  'harness' | 'control' | 'goals' | 'plans' | 'fleet' | 'queue' | 'inbox' | 'activity' | 'asks' | 'listener';

export interface CockpitState {
  config: CockpitConfig;
  control: ControlState;
  worldObservedAt: string | null;
  world: CockpitWorld;
  recovery: OrphanedWork[];
  build: BuildReading;
  /** → docs/spec/04-harness-cycle.md#when-the-fleet-stops-dispatching */
  fleetStall: FleetStall | null;
  retainedRuns: Issue[];
  archivedPullRequests: PullRequest[];
  plans: PlanView[];
  pets: PetState | null;
  localRun: LocalRunView | null;
  localRunTargets: LocalRunTargetView[];
  /**
   * Every environment that declares a tenant command, whether or not one is running — the top bar's
   * chip is drawn from this. Empty where none does, and then the chip is absent.
   * → docs/spec/36-remote-validation.md#what-the-gate-shows-while-it-runs
   */
  tenantCommands: TenantCommandView[];
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
  /** Checked descriptions on open pull requests that found something. */
  descriptionFeedback: DescriptionFeedback[];
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
  /**
   * One record per goal whose post-deploy watch the assessor was asked for: its `note`, its
   * `emptyReason`, and whether the operator has accepted it. → docs/spec/29-post-deploy-watch.md#the-operator-accepts-the-set
   */
  watchPlans: WatchPlanRecord[];
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
  /** The readings only a person can take, still asked for. → docs/spec/29-post-deploy-watch.md#a-source-only-the-operator-can-run */
  watchAsks: WatchAskView[];
  /** Each goal's watch rolled up to one answer. → docs/spec/29-post-deploy-watch.md#the-outcome */
  goalWatchOutcomes: WatchOutcome[];
  featureSequences: FeatureSequence[];
  environmentArrivals: GoalArrival[];
  remoteSheets: RemoteSheetView[];
  stackLandings: StackLandingView[];
  tasks: readonly TaskSummary[];
  jobs: Job[];
  schedules: JobSchedule[];
  agents: Agent[];
  agentProgress: AgentProgress[];
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
  /**
   * Every ask on the deployment, in the rail's order, derived on the server so the cockpit and
   * Claude Code read one queue. Its own section, read off whatever else the reply built.
   * → docs/spec/17-cockpit.md#one-list-for-the-cockpit-and-for-claude-code
   */
  asks: AskRow[];
  /** How many small asks the harness answered itself that the operator has not checked yet. → docs/spec/43-handled-for-you.md */
  handledOpen: number;
  /** Whether a Claude chat is running `/lubbdubb:listen`, and what it was sent. → docs/spec/44-needs-you.md */
  listener: ListenerView;
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
  /** Why a validating environment holds no sheet for this goal; null where it has one or cannot run one. */
  noSheet: NoSheet | null;
}
