import type {
  AppState,
  Agent,
  SetupPayload,
  TaskSummary,
  AgentFlag,
  EjectionView,
  OrphanedWork,
  Escalation,
  Proposal,
  QueueItem,
  ReadyingAction,
  TicketOrder,
  TicketStateFilter,
  TicketTrackingFilter,
  TicketWatchFilter,
  InsightsWindow,
  GoalAgentsPayload,
} from '../types.js';
import { buildNeedsYou } from './needsYou.js';
import type { AppliedFix, NeedRow } from './needsYou.js';
import { buildGoalPage, goalOfOrigin } from './goalPage.js';
import type { GoalPageView } from './goalPage.js';
import { buildPrPage } from './prPage.js';
import type { PrPageView } from './prPage.js';
import type { ConfigTab, ConsolePanel, ConsoleTab, InsightsView } from '../cockpit/actions.js';
import type { FeaturePrFilter, FeatureSort } from '../cockpit/place.js';

// → docs/spec/17-cockpit.md

export interface CockpitView {
  state: AppState;
  now: number;
  connected: boolean;
  demo: boolean;
  setup: SetupPayload | null;

  crashed: OrphanedWork[];
  live: Agent[];
  deskRuns: DeskRun[];
  ejected: EjectionView[];
  readying: ReadyingAction[];
  upNext: QueueItem[];
  past: Agent[];
  openEscalations: Escalation[];
  openHumanTaskCount: number;
  liveOverlapCount: number;

  needsYou: NeedRow[];
  selectedGoal: string | null;
  goalPage: GoalPageView | null;
  selectedPr: number | null;
  prPage: PrPageView | null;
  consolePanel: ConsolePanel;
  tab: ConsoleTab;
  collapsedFeatures: ReadonlySet<number>;
  goalOpen: ReadonlySet<string>;
  goalShut: ReadonlySet<string>;
  configTab: ConfigTab;
  configGroup: string | null;
  ticketWatch: TicketWatchFilter;
  ticketTracking: TicketTrackingFilter;
  ticketState: TicketStateFilter;
  ticketFeature: number | 'none' | null;
  ticketGroup: 'feature' | 'flat';
  ticketOrder: TicketOrder;
  ticketView: 'table' | 'card';
  ticketColumns: string[];
  featureCard: number | null;
  featureSort: FeatureSort;
  featurePrs: FeaturePrFilter;
  selectedAgent: Agent | null;
  selectedOutput: string | undefined;

  nextPulseIn: number;
  pulseProgress: number;
  pulseHeld: boolean;

  proposalFor: ReadonlyMap<string, Proposal>;
  agentById: ReadonlyMap<string, Agent>;
  escalationByAgent: ReadonlyMap<string, Escalation>;
  limitParked: ReadonlySet<string>;
  stallExpiryByAgent: ReadonlyMap<string, string>;
  flagsByAgent: ReadonlyMap<string, AgentFlag[]>;
  tailByAgent: ReadonlyMap<string, string>;

  taskFor(agent: Agent): TaskSummary | null;
  agentOnBranch: ReadonlyMap<string, Agent>;
  agentOnGoal: ReadonlyMap<string, Agent>;

  viewingPlan: string | null;
  regroupingPlan: boolean;
  viewingRetro: string | null;
  hatching: string | null;
  viewingScratchpad: string | null;
  viewingReviewPack: number | null;
  reviewIdea: string | null;
  viewingObstacle: string | null;
  obstacleEnded: boolean;
  insightsView: InsightsView;
  insightsWindow: InsightsWindow;
  poolProject: string | null;
}

const LIVE_STATUSES = ['starting', 'running', 'waiting'];

export interface DeskRun {
  checkId: string;
  letter: string;
  title: string;
  originRef: string;
  label: string;
  claimedAt: string;
}

function buildDeskRuns(state: AppState): DeskRun[] {
  return (state.validationChecks ?? []).flatMap((check) => {
    if (check.claimedBy === null || check.claimedAt === null) return [];
    return [
      {
        checkId: check.id,
        letter: check.letter,
        title: check.title,
        originRef: check.originRef,
        label: check.claimedBy,
        claimedAt: check.claimedAt,
      },
    ];
  });
}

interface ViewInputs {
  state: AppState;
  now: number;
  connected: boolean;
  demo: boolean;
  setup: SetupPayload | null;
  appliedFixes?: readonly AppliedFix[];
  selected: string | null;
  liveOutput: ReadonlyMap<string, string>;
  tails: ReadonlyMap<string, string>;
  lastPulseAt: number;
  goalAgents?: GoalAgentsPayload | null;
  viewingPlan: string | null;
  regroupingPlan?: boolean;
  viewingRetro: string | null;
  hatching: string | null;
  viewingScratchpad: string | null;
  viewingReviewPack?: number | null;
  reviewIdea?: string | null;
  viewingObstacle?: string | null;
  obstacleEnded?: boolean;
  insightsView: InsightsView;
  insightsWindow: InsightsWindow;
  poolProject?: string | null;
  selectedGoal: string | null;
  selectedPr?: number | null;
  consolePanel: ConsolePanel;
  tab: ConsoleTab;
  collapsed?: readonly number[];
  goalOpen?: readonly string[];
  goalShut?: readonly string[];
  configTab?: ConfigTab;
  configGroup?: string | null;
  ticketWatch?: TicketWatchFilter;
  ticketTracking?: TicketTrackingFilter;
  ticketState?: TicketStateFilter;
  ticketFeature?: number | 'none' | null;
  ticketGroup?: 'feature' | 'flat';
  ticketOrder?: TicketOrder;
  ticketView?: 'table' | 'card';
  ticketColumns?: string[];
  featureCard?: number | null;
  featureSort?: FeatureSort;
  featurePrs?: FeaturePrFilter;
}

function groupByAgent<T extends { agentId: string }>(rows: readonly T[] | undefined): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows ?? []) {
    const list = out.get(row.agentId) ?? [];
    list.push(row);
    out.set(row.agentId, list);
  }
  return out;
}

function buildUpNext(state: AppState, live: readonly Agent[]): QueueItem[] {
  const items = state.upcoming?.items ?? [];
  if (items.length === 0) return [];
  const staffed = new Set<string>();
  for (const agent of live) {
    const origin = state.tasks.find((t) => t.id === agent.taskId)?.originRef;
    if (origin) staffed.add(origin);
  }
  for (const action of state.readying ?? []) if (action.originRef) staffed.add(action.originRef);
  return items.filter((item) => !staffed.has(item.origin));
}

export function buildViewModel(input: ViewInputs): CockpitView {
  const { state, now, selected } = input;

  const crashed = state.recovery ?? [];
  const live = state.agents.filter((a) => LIVE_STATUSES.includes(a.status));
  const past = state.agents.filter((a) => !LIVE_STATUSES.includes(a.status));
  const agentById = new Map(state.agents.map((a) => [a.id, a]));
  const openEscalations = state.escalations.filter((e) => e.status === 'open');

  const interval = state.config.heartbeatIntervalMs;
  const sincePulse = now - input.lastPulseAt;

  const needsYou = buildNeedsYou(state, input.setup, input.appliedFixes ?? [], new Date(now).toISOString());
  const goalPage = input.selectedGoal
    ? buildGoalPage(state, input.selectedGoal, needsYou, input.goalAgents ?? null)
    : null;
  const selectedPr = input.selectedPr ?? null;
  const prPage = selectedPr === null ? null : buildPrPage(state, selectedPr);

  return {
    state,
    now,
    connected: input.connected,
    demo: input.demo,
    setup: input.setup,

    crashed,
    live,
    deskRuns: buildDeskRuns(state),
    ejected: (state.ejections ?? []).filter((e) => e.settledAt === null),
    readying: state.readying,
    upNext: buildUpNext(state, live),
    past,
    openEscalations,
    openHumanTaskCount: (state.humanTasks ?? []).filter((t) => t.status === 'open').length,
    liveOverlapCount: (state.overlaps ?? []).filter((o) => o.live).length,

    needsYou,
    selectedGoal: input.selectedGoal,
    goalPage,
    selectedPr,
    prPage,
    consolePanel: input.consolePanel,
    tab: input.tab,
    insightsView: input.insightsView,
    insightsWindow: input.insightsWindow,
    poolProject: input.poolProject ?? null,
    collapsedFeatures: new Set(input.collapsed ?? []),
    goalOpen: new Set(input.goalOpen ?? []),
    goalShut: new Set(input.goalShut ?? []),
    configTab: input.configTab ?? 'values',
    configGroup: input.configGroup ?? null,
    ticketWatch: input.ticketWatch ?? 'any',
    ticketTracking: input.ticketTracking ?? 'live',
    ticketState: input.ticketState ?? 'any',
    ticketFeature: input.ticketFeature ?? null,
    ticketGroup: input.ticketGroup ?? 'feature',
    ticketOrder: input.ticketOrder ?? 'added',
    ticketView: input.ticketView ?? 'table',
    ticketColumns: input.ticketColumns ?? [],
    featureCard: input.featureCard ?? null,
    featureSort: input.featureSort ?? 'wants-you',
    featurePrs: input.featurePrs ?? 'open',

    selectedAgent:
      state.agents.find((a) => a.id === selected) ??
      (input.goalAgents?.agents ?? []).find((a) => a.id === selected) ??
      null,
    selectedOutput: selected ? input.liveOutput.get(selected) : undefined,

    nextPulseIn: Math.max(0, Math.ceil((interval - (sincePulse % interval)) / 1000)),
    pulseProgress: Math.min(100, ((sincePulse % interval) / interval) * 100),
    pulseHeld: crashed.length > 0,

    proposalFor: new Map((state.proposals ?? []).map((p) => [p.escalationId ?? '', p])),
    agentById,
    escalationByAgent: new Map(
      openEscalations.flatMap((e) => (e.agentId ? ([[e.agentId, e]] as [string, Escalation][]) : [])),
    ),
    limitParked: new Set(state.parkedOnLimit),
    stallExpiryByAgent: new Map(state.stallParks.map((p) => [p.agentId, p.expiresAt])),
    flagsByAgent: groupByAgent(state.flags),
    tailByAgent: input.tails,

    taskFor: (agent) =>
      state.tasks.find((t) => t.id === agent.taskId) ??
      (input.goalAgents?.tasks ?? []).find((t) => t.id === agent.taskId) ??
      null,
    agentOnBranch: new Map(
      state.agents.flatMap((agent) => {
        if (agent.endedAt !== null) return [];
        const branch = state.tasks.find((t) => t.id === agent.taskId)?.branch ?? null;
        return branch === null ? [] : ([[branch, agent]] as [string, Agent][]);
      }),
    ),
    agentOnGoal: new Map(
      state.agents.flatMap((agent) => {
        if (agent.endedAt !== null) return [];
        const origin = state.tasks.find((t) => t.id === agent.taskId)?.originRef ?? null;
        const goal = goalOfOrigin(state, origin);
        return goal === null ? [] : ([[goal, agent]] as [string, Agent][]);
      }),
    ),
    viewingPlan: input.viewingPlan,
    regroupingPlan: input.regroupingPlan === true,
    viewingRetro: input.viewingRetro,
    hatching: input.hatching,
    viewingScratchpad: input.viewingScratchpad,
    viewingReviewPack: input.viewingReviewPack ?? null,
    reviewIdea: input.reviewIdea ?? null,
    viewingObstacle: input.viewingObstacle ?? null,
    obstacleEnded: input.obstacleEnded ?? false,
  };
}
