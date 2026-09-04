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

/**
 * Everything the console draws, derived once per render and handed over as plain data.
 *
 * This is deliberately a pure function of the snapshot rather than a set of hooks:
 * the drawing code must not be able to reach the network, and the derivations below
 * (which lived inside `App`'s body until the view model split them out) are the part
 * worth testing. No field here is a function or a promise — anything the console
 * can *do* lives on `CockpitActions` instead, so the two halves stay separable.
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
   * What the harness says about its own configuration, or null when it could not
   * say — which is drawn as nothing, exactly as a fully-configured harness is.
   *
   * Fetched rather than polled (see `useCockpit`), so it is on the view rather
   * than off `state`: the snapshot is what the pulse persisted, and a reading that
   * shells out to git has no business riding it.
   */
  setup: SetupPayload | null;

  /** Work the previous run orphaned. Non-empty ⇒ the harness is holding every pulse. */
  crashed: OrphanedWork[];
  /** Agents with a live process behind them. */
  live: Agent[];
  /**
   * Checks a desktop session is running at somebody's keyboard. In flight, and
   * deliberately *not* in {@link live}: these consume no fleet capacity, so
   * nothing that counts a slot may reach them. See {@link DeskRun}.
   */
  deskRuns: DeskRun[];
  /**
   * Actions the executor is working on that are not agents yet. In flight, and
   * *not* in {@link live} for {@link deskRuns}' reason and one more: an entry here
   * is on its way to becoming an agent, so counting it as one would make the fleet
   * card report the same dispatch twice as it landed.
   *
   * Straight off the snapshot rather than folded, because the server has already
   * folded it — the list is a copy of the executor's own record, and there is
   * nothing on the client to join it to.
   */
  readying: ReadyingAction[];
  /**
   * The "Up next" queue, minus the rows the fleet is already out on.
   *
   * `state.upcoming` is the *last pulse's* projection, and the pulse that
   * dispatches a candidate writes it into that list as `dispatching` in the same
   * breath — the dispatcher's own de-duplication is `activeOrigins`, which is
   * derived from tasks that do not exist yet at the moment of the push. So for
   * the length of one interval the queue claims work that is already out, and the
   * Fleet card draws the same issue twice: once as an agent, once as "up next".
   *
   * Joined here rather than on the card because both surfaces that draw the queue
   * — the band and the `upnext` panel — must agree about its size, and because
   * the band's row budget is spent against this length.
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
  /**
   * The pull request whose page is open, by number — **it outranks the selected
   * goal**, which outranks the tab. Reached from a goal and drawn over it, with the
   * crumb naming the goal underneath.
   */
  selectedPr: number | null;
  /** That pull request's page, or null when none is open or the world does not carry it. */
  prPage: PrPageView | null;
  /** Which full-surface panel is in front, or null. */
  consolePanel: ConsolePanel;
  /** Where the nav is. A selected goal outranks it, so this is not what is drawn. */
  tab: ConsoleTab;
  /**
   * The backlog features whose children are folded away. A set rather than the
   * list the place carries, because the backlog asks it once per heading and
   * membership is the only question it asks.
   */
  collapsedFeatures: ReadonlySet<number>;
  /**
   * The goal page's sections the operator has held **open**, by name. A set rather
   * than the list the place carries, because the page asks it once per disclosure
   * and membership is the only question it asks.
   */
  goalOpen: ReadonlySet<string>;
  /**
   * And the ones held **shut**. Both, because neither is the default any more —
   * where a section starts is a reading of the goal's own progress, and these two
   * are the operator's word about one, in whichever direction they went.
   */
  goalShut: ReadonlySet<string>;
  /**
   * What the Tickets tab is narrowed to and ordered by. Carried through the view
   * model rather than read from the place in the panel, so every surface reads one
   * shape and the panel stays a component that is *told* where it is.
   */
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
   * The open question an agent is waiting on an answer to, keyed by agent id —
   * the join that lets the console draw the ask *on the agent* rather than only in
   * an inbox. One escalation rather than a list because the harness parks an agent
   * at most once at a time (`system.ts`'s `waiting` handler returns early while
   * one is open), so a list would promise a plurality that cannot occur.
   *
   * Derived from the same `status === 'open'` filter `openEscalations` is, which
   * is what makes the two surfaces one reading: answering on either settles the
   * row, and the next snapshot clears both with nothing kept in step by hand.
   */
  escalationByAgent: ReadonlyMap<string, Escalation>;
  /**
   * The agents parked because the account's usage limit is spent — a set rather
   * than a list because every surface asks the same question of it, "is *this*
   * agent one", and a list would have each of them answering it its own way.
   *
   * It is the wire's `parkedOnLimit` and nothing derived: the park is a fact the
   * harness holds, and a cockpit that inferred it from the waiting reason would
   * offer the resume button off a sentence.
   */
  limitParked: ReadonlySet<string>;
  /**
   * agentId → when the harness will record that agent done itself, for the agents
   * parked on an unannounced stop. A map rather than a set for the same reason the
   * wire ships pairs: the card draws a countdown, and the answer to "is this one"
   * is the same read as "until when".
   */
  stallExpiryByAgent: ReadonlyMap<string, string>;
  /** Artifacts agents flagged mid-run, grouped for the card and drawer. */
  flagsByAgent: ReadonlyMap<string, AgentFlag[]>;
  /** Last non-empty output line per agent, for compact fleet-card previews. */
  tailByAgent: ReadonlyMap<string, string>;

  /** The task an agent is working, or null if the row has outlived it. */
  taskFor(agent: Agent): TaskSummary | null;
  /**
   * branch → the live agent working it, for the surfaces that draw a *branch* and
   * want to say somebody is on it.
   *
   * Derived here rather than at the call site because the join is two hops — an
   * agent carries a `taskId` and a task carries the branch — and a card doing it
   * itself is a card that will do it slightly differently. Live only: a finished
   * agent's branch is history, and drawn as "an agent is on this" it would be a
   * pull request that looks staffed forever.
   */
  agentOnBranch: ReadonlyMap<string, Agent>;
  /**
   * goal ref → the live agent working it, for the surfaces that draw a *goal*.
   *
   * A second map rather than a lookup through {@link CockpitView.agentOnBranch},
   * because a branch is not how a goal finds its agent: the dispatch names an
   * origin, and the origin is as often a pull request as the goal itself. Resolved
   * through {@link goalOfOrigin} for that reason, and live only, for
   * `agentOnBranch`'s.
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
 * A validation check the operator's own Claude Code is running right now, drawn
 * in the fleet list beside the dispatched agents.
 *
 * **Synthesised from the claim on the check, not read off an agent row.** Nobody
 * dispatched it: there is no task, no branch, no worktree, no transcript and no
 * spend, so a row in `agents` would be a fiction — and one that every counter of
 * live agents would then have to be taught to filter back out, including the
 * next counter somebody adds.
 *
 * **`claimedBy` on the wire is already a live claim.** The server projects it
 * through `claimIsLive` (`withLiveClaim`), which is the single definition of
 * "claimed" — the rule, the desktop tools, the sheet's chip and this entry all
 * read the one answer, so a claim past its expiry leaves the fleet list at the
 * same instant it stops blocking `validate-check`.
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
   * nothing is open (or the fetch has not landed). The snapshot's `agents` list is
   * the fleet's live rows and a bounded tail of ended ones, so this is where a
   * goal's older runs come from — merged with the snapshot's, never instead of it,
   * since a dispatch made since the fetch is only in the snapshot.
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
  /**
   * The pull request whose review pack is open, and which of its ideas is
   * unfolded. Optional for `collapsed`'s reason: nothing open is what a bare URL
   * means.
   */
  viewingReviewPack?: number | null;
  reviewIdea?: string | null;
  /** Optional for `collapsed`'s reason: nothing open is what a bare URL means. */
  viewingObstacle?: string | null;
  obstacleEnded?: boolean;
  /** Which reading the Insights page is showing. */
  insightsView: InsightsView;
  /** The stretch of time every reading on that page is measured over. */
  insightsWindow: InsightsWindow;
  /** Which project the pool reading is narrowed to. Optional for `collapsed`'s reason. */
  poolProject?: string | null;
  /** The goal whose page is open, as `issue:<n>`. */
  selectedGoal: string | null;
  /**
   * The pull request whose page is open, by number — it outranks the goal.
   * Optional for `collapsed`'s reason: nothing open is what a bare URL means.
   */
  selectedPr?: number | null;
  /** Which full-surface panel is in front. */
  consolePanel: ConsolePanel;
  /** Where the nav is. */
  tab: ConsoleTab;
  /**
   * The backlog features whose children are folded away, by issue number.
   * Optional because "nothing folded" is the real default rather than a stand-in
   * for one — it is what the empty place carries and what a bare URL means.
   */
  collapsed?: readonly number[];
  /** The goal page's sections the operator opened. Optional for `collapsed`'s reason. */
  goalOpen?: readonly string[];
  /** And the ones they folded away. Optional for `collapsed`'s reason. */
  goalShut?: readonly string[];
  /** Optional for `collapsed`'s reason: the defaults are what a bare URL means. */
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
  /** Optional for `collapsed`'s reason: the default is what a bare URL means. */
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
 *
 * Staffed is "the fleet is on this origin now": a live agent whose task names it,
 * or a readying action on its way to becoming one. Ended agents are not staffing
 * anything — an origin the fleet finished with and the harness queued again is a
 * genuine queue row, and filtering on history would hide it forever.
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

  // The heartbeat is measured from the last pulse we *saw*, not from a server
  // field: `cycle:end` is what moves it, so a cockpit opened mid-interval counts
  // from its own first sighting rather than claiming a precision it lacks.
  const interval = state.config.heartbeatIntervalMs;
  const sincePulse = now - input.lastPulseAt;

  const needsYou = buildNeedsYou(state, input.setup, input.appliedFixes ?? []);
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

    // The snapshot first, then the open goal's fetched history: a row on that
    // page can be older than the fleet's tail, and a drawer that would not open
    // for it is a dead end on the one surface that offered the click.
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

    // Both lists, for `selectedAgent`'s reason: the drawer of an old run reads its
    // title from the task the history brought with it.
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
    // Shut, which is the page as it stands: the tail states its own size, so
    // nothing is hidden by being folded.
    obstacleEnded: input.obstacleEnded ?? false,
  };
}
