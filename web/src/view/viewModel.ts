import type { AppState, Agent, Task, AgentFlag, AgentFile, CrashedAgent, Escalation, Proposal } from '../types.js';

/**
 * Everything a skin draws, derived once per render and handed over as plain data.
 *
 * This is deliberately a pure function of the snapshot rather than a set of hooks:
 * a skin must not be able to reach the network, and the derivations below (which
 * lived inside `App`'s body until skins existed) are the part worth testing. No
 * field here is a function or a promise — anything a skin can *do* lives on
 * `CockpitActions` instead, so the two halves stay separable.
 */
export interface CockpitView {
  /** The raw snapshot. Skins read config/world/refUrls straight off it. */
  state: AppState;
  /** Wall clock for relative-time rendering, ticking once a second. */
  now: number;
  /** Websocket liveness — not harness state, so it is not on the snapshot. */
  connected: boolean;
  /** True when serving the bundled fixtures rather than a real harness. */
  demo: boolean;

  /** Agents the previous run orphaned. Non-empty ⇒ the harness is holding every pulse. */
  crashed: CrashedAgent[];
  /** Agents with a live process behind them. */
  live: Agent[];
  /** Terminal agents, newest first as the server ordered them. */
  past: Agent[];
  /** Inbox items still awaiting an answer. */
  openEscalations: Escalation[];
  /** Findings nobody has ruled on — a finding never becomes work on its own. */
  openFindingCount: number;
  /** Overlaps still in flight, the only ones an operator can still act on. */
  liveOverlapCount: number;

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
}

const LIVE_STATUSES = ['starting', 'running', 'waiting'];

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
  /** Which plan's modal is open, or null when none is. Optional so callers that predate the modal still compile. */
  viewingPlan?: string | null;
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

  // The heartbeat is measured from the last pulse we *saw*, not from a server
  // field: `cycle:end` is what moves it, so a cockpit opened mid-interval counts
  // from its own first sighting rather than claiming a precision it lacks.
  const interval = state.config.heartbeatIntervalMs;
  const sincePulse = now - input.lastPulseAt;

  return {
    state,
    now,
    connected: input.connected,
    demo: input.demo,

    crashed,
    live,
    past,
    openEscalations: state.escalations.filter((e) => e.status === 'open'),
    openFindingCount: (state.findings ?? []).filter((f) => f.status === 'open').length,
    liveOverlapCount: (state.overlaps ?? []).filter((o) => o.live).length,

    selectedAgent: state.agents.find((a) => a.id === selected) ?? null,
    selectedOutput: selected ? input.liveOutput.get(selected) : undefined,

    nextPulseIn: Math.max(0, Math.ceil((interval - (sincePulse % interval)) / 1000)),
    pulseProgress: Math.min(100, ((sincePulse % interval) / interval) * 100),
    pulseHeld: crashed.length > 0,

    proposalFor: new Map((state.proposals ?? []).map((p) => [p.escalationId ?? '', p])),
    agentById,
    flagsByAgent: groupByAgent(state.flags),
    filesByAgent: groupByAgent(state.files),
    tailByAgent: input.tails,

    taskFor: (agent) => state.tasks.find((t) => t.id === agent.taskId) ?? null,
    viewingPlan: input.viewingPlan ?? null,
  };
}
