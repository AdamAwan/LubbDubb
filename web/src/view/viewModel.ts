import type {
  AppState,
  Agent,
  SetupPayload,
  TaskSummary,
  AgentFlag,
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

/**
 * Everything the console draws, derived once per render and handed over as plain data.
 * A pure function of the snapshot, not a set of hooks, so drawing code cannot reach the
 * network. No field is a function or a promise — anything the console can *do* lives on
 * `CockpitActions` instead.
 */
export interface CockpitView {
  /** The raw snapshot. The console reads config/world/refUrls straight off it. */
  state: AppState;
  /** Wall clock for relative-time rendering, ticking once a second. */
  now: number;
  /** Websocket liveness — not harness state, so it is not on the snapshot. */
  connected: boolean;
  /** True when serving the bundled fixtures rather than a real harness. */
  demo: boolean;
  /**
   * What the harness says about its own configuration, or null when it could not say.
   * Fetched rather than polled (see `useCockpit`), so it lives on the view, not `state`.
   */
  setup: SetupPayload | null;

  /** Work the previous run orphaned. Non-empty ⇒ the harness is holding every pulse. */
  crashed: OrphanedWork[];
  /** Agents with a live process behind them. */
  live: Agent[];
  /** Desktop sessions running at somebody's keyboard. Not in {@link live}: consumes no fleet capacity. See {@link DeskRun}. */
  deskRuns: DeskRun[];
  /**
   * Actions the executor is working on that are not agents yet. Not in {@link live}: an
   * entry here is on its way to becoming an agent, so counting it too would double the
   * fleet card's dispatch count. Straight off the snapshot — the server already folded it.
   */
  readying: ReadyingAction[];
  /**
   * The "Up next" queue, minus the rows the fleet is already out on. `state.upcoming`
   * is the last pulse's projection, and for the length of one interval a just-dispatched
   * candidate is claimed by both an agent row and a queue row; joined here so both
   * surfaces that draw the queue agree on its size.
   */
  upNext: QueueItem[];
  /** Terminal agents, newest first as the server ordered them. */
  past: Agent[];
  /** Inbox items still awaiting an answer. */
  openEscalations: Escalation[];
  /** Human tasks nobody has settled — work waiting on the operator themselves. */
  openHumanTaskCount: number;
  /** Overlaps still in flight, the only ones an operator can still act on. */
  liveOverlapCount: number;

  /** Every blocking item, merged and ordered — the queue rail's whole contents. */
  needsYou: NeedRow[];
  /** The goal whose page is open, as `issue:<n>`, or null for the overview. */
  selectedGoal: string | null;
  /** That goal's page, or null when none is selected or the ref is not in the world. */
  goalPage: GoalPageView | null;
  /** The pull request whose page is open, by number — outranks the selected goal, which outranks the tab. */
  selectedPr: number | null;
  /** That pull request's page, or null when none is open or the world does not carry it. */
  prPage: PrPageView | null;
  /** Which full-surface panel is in front, or null. */
  consolePanel: ConsolePanel;
  /** Where the nav is. A selected goal outranks it, so this is not what is drawn. */
  tab: ConsoleTab;
  /** The backlog features whose children are folded away. A set, since membership is the only question asked. */
  collapsedFeatures: ReadonlySet<number>;
  /** The goal page's sections the operator has held open, by name. A set for the same reason. */
  goalOpen: ReadonlySet<string>;
  /** And the ones held shut. Both carried, since where a section starts is a reading of the goal's progress, not the default. */
  goalShut: ReadonlySet<string>;
  /** Which section of the config page is in front, and the group it is showing. */
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
  /** Where the Features tab is — open card, ordering, PR filter — so the board is a component that is told where it is. */
  featureCard: number | null;
  featureSort: FeatureSort;
  featurePrs: FeaturePrFilter;
  /** The agent whose drawer is open, if any. */
  selectedAgent: Agent | null;
  /** Streamed output for the open drawer only; undefined for everyone else. */
  selectedOutput: string | undefined;

  /** Heartbeat countdown, in seconds, to the next pulse. */
  nextPulseIn: number;
  /** Fraction of the interval elapsed, 0–100, for the heartbeat bar. */
  pulseProgress: number;
  /** True when recovery decisions are outstanding, so no pulse will run at all. */
  pulseHeld: boolean;

  /** The act an inbox item asks you to authorize, keyed by escalation id. */
  proposalFor: ReadonlyMap<string, Proposal>;
  /** Agents by id — the join behind an escalation's staleness reading. */
  agentById: ReadonlyMap<string, Agent>;
  /**
   * The open question an agent is waiting on an answer to, keyed by agent id, so the
   * console can draw the ask on the agent, not only in an inbox. One escalation, not a
   * list, since the harness parks an agent at most once at a time. Derived from the same
   * `status === 'open'` filter as `openEscalations`, so the two surfaces stay in sync.
   */
  escalationByAgent: ReadonlyMap<string, Escalation>;
  /**
   * Agents parked because the account's usage limit is spent. It is the wire's
   * `parkedOnLimit` verbatim, never derived — a cockpit that inferred it from the
   * waiting reason would offer the resume button off a sentence.
   */
  limitParked: ReadonlySet<string>;
  /** agentId → when the harness will record that agent done itself, for agents parked on an unannounced stop. */
  stallExpiryByAgent: ReadonlyMap<string, string>;
  /** Artifacts agents flagged mid-run, grouped for the card and drawer. */
  flagsByAgent: ReadonlyMap<string, AgentFlag[]>;
  /** Last non-empty output line per agent, for compact fleet-card previews. */
  tailByAgent: ReadonlyMap<string, string>;

  /** The task an agent is working, or null if the row has outlived it. */
  taskFor(agent: Agent): TaskSummary | null;
  /**
   * branch → the live agent working it. Derived here, not at the call site, because the
   * join is two hops (agent → task → branch). Live only: a finished agent's branch is
   * history, and drawn as "staffed" it would make a PR look occupied forever.
   */
  agentOnBranch: ReadonlyMap<string, Agent>;
  /**
   * goal ref → the live agent working it. A second map rather than a lookup through
   * {@link CockpitView.agentOnBranch}, since a goal's agent is found through its origin,
   * not its branch — resolved via {@link goalOfOrigin}, live only.
   */
  agentOnGoal: ReadonlyMap<string, Agent>;

  /** Which plan's modal is open, or null when none is. */
  viewingPlan: string | null;
  /** The goal whose retrospective is open, as an `issue:<n>` ref. */
  viewingRetro: string | null;
  /** The egg whose shell is coming off, by pet id. */
  hatching: string | null;
  /** The goal whose shared scratchpad is open, as an `issue:<n>` ref. */
  viewingScratchpad: string | null;
  /** The pull request whose review pack is open over the goal page, by number. */
  viewingReviewPack: number | null;
  /** Which idea of that pack is unfolded — an id, `all`, or null. */
  reviewIdea: string | null;
  /** The obstacle whose sightings are unfolded, by id, or null for none. */
  viewingObstacle: string | null;
  /** Whether the obstacle board's terminal tail is opened. */
  obstacleEnded: boolean;
  /** Which reading the Insights page is showing. */
  insightsView: InsightsView;
  /** The stretch of time every reading on that page is measured over. */
  insightsWindow: InsightsWindow;
  /** Which project the pool reading is narrowed to, or null for every one. */
  poolProject: string | null;
}

const LIVE_STATUSES = ['starting', 'running', 'waiting'];

/**
 * A validation check the operator's own Claude Code is running right now, drawn in the
 * fleet list beside dispatched agents. Synthesised from the claim on the check, not read
 * off an agent row — nobody dispatched it, so there is no task, branch, worktree or
 * spend. `claimedBy` on the wire is already a live claim, projected through
 * `claimIsLive` — the single definition of "claimed" shared by the rule, the desktop
 * tools, the sheet's chip and this entry.
 */
export interface DeskRun {
  /** The check's stable id — the row's key, and what the claim is keyed on. */
  checkId: string;
  /** The human-typeable handle, `A`, `B`, `C`… */
  letter: string;
  title: string;
  /** The goal it validates, as `issue:<n>`. */
  originRef: string;
  /** Who holds it, hostname and all: `desktop (studio)`. */
  label: string;
  /** When the claim was taken — the only elapsed time this entry has. */
  claimedAt: string;
}

/** Every live claim. The check names its own goal, so there is nothing to join. */
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
  /** Config fixes written from the rail this session — see `AppliedFix`. */
  appliedFixes?: readonly AppliedFix[];
  selected: string | null;
  liveOutput: ReadonlyMap<string, string>;
  tails: ReadonlyMap<string, string>;
  /** When the last pulse landed — the anchor the countdown is measured from. */
  lastPulseAt: number;
  /**
   * The open goal's whole run history, fetched when its page opened, or null when
   * nothing is open. Merged with the snapshot's agents (never instead of it), since a
   * dispatch made since the fetch is only in the snapshot.
   */
  goalAgents?: GoalAgentsPayload | null;
  /** Which plan's modal is open, or null when none is. */
  viewingPlan: string | null;
  /** The goal whose retrospective is open, as an `issue:<n>` ref. */
  viewingRetro: string | null;
  /** The egg whose shell is coming off, by pet id. */
  hatching: string | null;
  /** The goal whose shared scratchpad is open, as an `issue:<n>` ref. */
  viewingScratchpad: string | null;
  /** The pull request whose review pack is open, and which idea is unfolded. Optional: nothing open is what a bare URL means. */
  viewingReviewPack?: number | null;
  reviewIdea?: string | null;
  viewingObstacle?: string | null;
  obstacleEnded?: boolean;
  /** Which reading the Insights page is showing. */
  insightsView: InsightsView;
  /** The stretch of time every reading on that page is measured over. */
  insightsWindow: InsightsWindow;
  /** Which project the pool reading is narrowed to. Optional: default is what a bare URL means. */
  poolProject?: string | null;
  /** The goal whose page is open, as `issue:<n>`. */
  selectedGoal: string | null;
  /** The pull request whose page is open, by number — it outranks the goal. Optional: default is what a bare URL means. */
  selectedPr?: number | null;
  /** Which full-surface panel is in front. */
  consolePanel: ConsolePanel;
  /** Where the nav is. */
  tab: ConsoleTab;
  /** The backlog features whose children are folded away, by issue number. Optional: "nothing folded" is the real default. */
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

/**
 * The queue with the staffed rows taken out. → {@link CockpitView.upNext}
 * Staffed means a live agent or readying action names the origin now; ended agents
 * don't count, or a re-queued finished origin would be hidden forever.
 */
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

  // Measured from the last pulse we *saw* (cycle:end), not a server field, so a cockpit opened mid-interval doesn't claim precision it lacks.
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

    // Snapshot first, then the open goal's fetched history — a drawer for an older row must still open.
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

    // Both lists, so the drawer of an old run reads its title from the task the history brought with it.
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
    viewingRetro: input.viewingRetro,
    hatching: input.hatching,
    viewingScratchpad: input.viewingScratchpad,
    viewingReviewPack: input.viewingReviewPack ?? null,
    reviewIdea: input.reviewIdea ?? null,
    viewingObstacle: input.viewingObstacle ?? null,
    // Shut, which is the page as it stands: the tail states its own size, so nothing is hidden by being folded.
    obstacleEnded: input.obstacleEnded ?? false,
  };
}
