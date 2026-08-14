import type { AppState, Agent, Task, AgentFlag, AgentFile, OrphanedWork, Escalation, Proposal } from '../types.js';
import { buildNeedsYou } from './needsYou.js';
import type { NeedRow } from './needsYou.js';
import { buildGoalPage } from './goalPage.js';
import type { GoalPageView } from './goalPage.js';
import type { ConsolePanel, ConsoleTab } from '../cockpit/actions.js';

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
  /** Terminal agents, newest first as the server ordered them. */
  past: Agent[];
  /** Inbox items still awaiting an answer. */
  openEscalations: Escalation[];
  /** Findings nobody has ruled on — a finding never becomes work on its own. */
  openFindingCount: number;
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
  /** Artifacts agents flagged mid-run, grouped for the card and drawer. */
  flagsByAgent: ReadonlyMap<string, AgentFlag[]>;
  /** Every file agents wrote, grouped for the drawer's "files changed" list. */
  filesByAgent: ReadonlyMap<string, AgentFile[]>;
  /** Last non-empty output line per agent, for compact fleet-card previews. */
  tailByAgent: ReadonlyMap<string, string>;

  /** The task an agent is working, or null if the row has outlived it. */
  taskFor(agent: Agent): Task | null;

  /** Which plan's modal is open, or null when none is. */
  viewingPlan: string | null;
  /** The goal whose retrospective is open, as an `issue:<n>` ref. */
  viewingRetro: string | null;
  /** The goal whose shared scratchpad is open, as an `issue:<n>` ref. */
  viewingScratchpad: string | null;
  /** Whether the settings modal is open. */
  settingsOpen: boolean;
  /** Whether the spend breakdown is open. */
  spendOpen: boolean;
  /** Whether the reliability breakdown is open. */
  reliabilityOpen: boolean;
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
  selected: string | null;
  liveOutput: ReadonlyMap<string, string>;
  tails: ReadonlyMap<string, string>;
  /** When the last pulse landed — the anchor the countdown is measured from. */
  lastPulseAt: number;
  /** Which plan's modal is open, or null when none is. */
  viewingPlan: string | null;
  /** The goal whose retrospective is open, as an `issue:<n>` ref. */
  viewingRetro: string | null;
  /** The goal whose shared scratchpad is open, as an `issue:<n>` ref. */
  viewingScratchpad: string | null;
  /** Whether the settings modal is open. */
  settingsOpen: boolean;
  /** Whether the spend breakdown is open. */
  spendOpen: boolean;
  /** Whether the reliability breakdown is open. */
  reliabilityOpen: boolean;
  /** The goal whose page is open, as `issue:<n>`. */
  selectedGoal: string | null;
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

  const needsYou = buildNeedsYou(state);

  return {
    state,
    now,
    connected: input.connected,
    demo: input.demo,

    crashed,
    live,
    deskRuns: buildDeskRuns(state),
    past,
    openEscalations,
    openFindingCount: (state.findings ?? []).filter((f) => f.status === 'open').length,
    openHumanTaskCount: (state.humanTasks ?? []).filter((t) => t.status === 'open').length,
    liveOverlapCount: (state.overlaps ?? []).filter((o) => o.live).length,

    needsYou,
    selectedGoal: input.selectedGoal,
    goalPage: input.selectedGoal ? buildGoalPage(state, input.selectedGoal, needsYou) : null,
    consolePanel: input.consolePanel,
    tab: input.tab,
    collapsedFeatures: new Set(input.collapsed ?? []),

    selectedAgent: state.agents.find((a) => a.id === selected) ?? null,
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
    flagsByAgent: groupByAgent(state.flags),
    filesByAgent: groupByAgent(state.files),
    tailByAgent: input.tails,

    taskFor: (agent) => state.tasks.find((t) => t.id === agent.taskId) ?? null,
    viewingPlan: input.viewingPlan,
    viewingRetro: input.viewingRetro,
    viewingScratchpad: input.viewingScratchpad,
    settingsOpen: input.settingsOpen,
    spendOpen: input.spendOpen,
    reliabilityOpen: input.reliabilityOpen,
  };
}
