import type { WebSocket } from 'ws';
import type { System } from '../system.js';
import { stripAnsi } from '../agents/streamTranscript.js';
import type { AgentFlag, Finding, WorldEvent } from '../types.js';

export type ServerEvent =
  | { type: 'cycle:start'; cycleId: string; source: string }
  | { type: 'cycle:end'; cycleId: string; rationale: string; summary: unknown }
  | { type: 'agent:output'; agentId: string; delta: string }
  | { type: 'agent:tail'; agentId: string; line: string }
  | { type: 'agent:flag'; flag: AgentFlag }
  | { type: 'agent:finding'; finding: Finding }
  | { type: 'agent:status'; agentId: string; taskId: string; status: string }
  | { type: 'agent:waiting'; agentId: string; taskId: string; reason: string }
  | { type: 'agent:done'; agentId: string; taskId: string; status: string }
  | { type: 'escalation:created'; escalation: unknown }
  | { type: 'escalation:answered'; escalation: unknown; routing: string }
  | { type: 'escalation:dismissed'; escalation: unknown }
  | { type: 'world:changed' }
  | { type: 'control:changed'; cap: number; paused: boolean }
  // The running config moved — a cockpit save, or an edit to the file the watcher
  // picked up. Coarse on purpose: the payload is what `/api/config` answers, and
  // a form that has to re-read it anyway is better told to than handed half of it.
  | { type: 'config:changed' }
  | { type: 'world:events'; events: unknown[] }
  | { type: 'error:logged'; error: unknown }
  | { type: 'dirty' };

/**
 * How long the local run's own events are gathered up before one refetch is asked
 * for. Long enough that an install log costs one snapshot rather than hundreds,
 * short enough that a phase line reads as it happens.
 */
const LOCAL_RUN_COALESCE_MS = 400;

/**
 * Fans harness/agent/escalation events out to every connected cockpit socket.
 * A coarse `dirty` signal tells clients "re-fetch /api/state"; fine-grained
 * events (agent output, waiting) let the UI react live without polling.
 */
export class Hub {
  private readonly sockets = new Set<WebSocket>();
  // Which agentIds each socket wants full `agent:output` for. Output is high
  // volume, so it's delivered scoped to subscribers instead of broadcast.
  private readonly subscriptions = new Map<WebSocket, Set<string>>();
  // Per-agent rolling tail state: the still-growing partial last line plus the
  // last non-empty trimmed line seen so far, so the compact tail is correct
  // across delta boundaries.
  private readonly tails = new Map<string, { partial: string; last: string }>();

  // The pending coalesced local-run refetch, if one is due. See the wiring below.
  private localRunPending: NodeJS.Timeout | null = null;

  constructor(system: System) {
    const { harness, agents, escalations, errors, localRun } = system;

    // Recorded failures stream to the cockpit's Errors panel live; the `dirty`
    // makes the panel durable-consistent via the /api/state refetch.
    errors.on('logged', (error) => {
      this.broadcast({ type: 'error:logged', error });
      this.broadcast({ type: 'dirty' });
    });

    harness.on('cycle:start', (e: { cycleId: string; source: string }) =>
      this.broadcast({ type: 'cycle:start', ...e }),
    );
    harness.on('cycle:end', (r: { cycleId: string; rationale: string; summary: unknown }) => {
      this.broadcast({ type: 'cycle:end', cycleId: r.cycleId, rationale: r.rationale, summary: r.summary });
      this.broadcast({ type: 'dirty' });
    });
    harness.on('world:events', ({ events }: { events: WorldEvent[] }) => {
      this.broadcast({ type: 'world:events', events });
      this.broadcast({ type: 'dirty' });
    });

    agents.on('output', (e) => this.handleOutput(e.agentId, e.delta));
    // Flags are low-volume and shown fleet-wide (a chip on the card), so unlike
    // output they're broadcast to every socket, not just an agent's subscribers.
    agents.on('flag', (e) => {
      this.broadcast({ type: 'agent:flag', flag: e.flag });
      this.broadcast({ type: 'dirty' });
    });
    // An agent filed something outside its own task. Like flags these are
    // low-volume and fleet-wide, so they go to every socket; the `dirty` is what
    // makes the Findings panel durable-consistent via the /api/state refetch.
    agents.on('finding', (e) => {
      this.broadcast({ type: 'agent:finding', finding: e.finding });
      this.broadcast({ type: 'dirty' });
    });
    // The agent said what it is working on. No dedicated frame: the note lives on
    // the agent row, so the /api/state refetch a `dirty` triggers *is* the whole
    // delivery — unlike `agent:tail`, which exists only as a broadcast and has to
    // carry its own payload. Same treatment as `usage` for the same reason.
    agents.on('progress', () => this.broadcast({ type: 'dirty' }));
    // An agent said whether its issue is finished. Same treatment and the same
    // reason: the verdict is shipped per-issue inside /api/state, so the refetch
    // a `dirty` triggers is the whole delivery.
    agents.on('conclusion', () => this.broadcast({ type: 'dirty' }));
    // A pad note and a finished retrospective are both shipped inside /api/state
    // (the retro as its per-issue reading; the pad through the retro that quotes
    // it), so a coarse dirty is the whole delivery for each.
    agents.on('scratch', () => this.broadcast({ type: 'dirty' }));
    agents.on('retrospective', () => this.broadcast({ type: 'dirty' }));
    // The file-events hook recorded a written file; a coarse dirty repaints the
    // drawer's "files changed" list via the /api/state refetch (report-like ones
    // also arrive as an agent:flag above).
    agents.on('files', () => this.broadcast({ type: 'dirty' }));
    // Usage lands on the agent row at turn end; a coarse dirty repaints the
    // fleet cards' cost/tokens without a dedicated frame type.
    agents.on('usage', () => this.broadcast({ type: 'dirty' }));
    // A parked agent was seen working anyway, so its open alert is probably stale.
    // Same treatment again: `resumedAt` is on the agent row the refetch brings, and
    // the cockpit derives the staleness itself rather than being told twice.
    agents.on('resumed', () => this.broadcast({ type: 'dirty' }));
    agents.on('status', (e) => {
      this.broadcast({ type: 'agent:status', ...e });
      this.broadcast({ type: 'dirty' });
    });
    agents.on('waiting', (e) => {
      this.broadcast({ type: 'agent:waiting', ...e });
      this.broadcast({ type: 'dirty' });
    });
    agents.on('done', (e) => {
      this.broadcast({ type: 'agent:done', ...e });
      this.broadcast({ type: 'dirty' });
      this.tails.delete(e.agentId); // agent finished; drop its rolling tail buffer
    });

    escalations.on('created', (escalation) => {
      this.broadcast({ type: 'escalation:created', escalation });
      this.broadcast({ type: 'dirty' });
    });
    escalations.on('answered', ({ escalation, routing }: { escalation: unknown; routing: string }) => {
      this.broadcast({ type: 'escalation:answered', escalation, routing });
      this.broadcast({ type: 'dirty' });
    });
    escalations.on('dismissed', (escalation) => {
      this.broadcast({ type: 'escalation:dismissed', escalation });
      this.broadcast({ type: 'dirty' });
    });

    // The local run, coarse and **rate-limited**, which is the one thing here that
    // is not like the rest of this constructor.
    //
    // Coarse for the usual reason: everything the panel draws — the status turn from
    // `starting` to `running`, the phase, a failure's last words — is shipped inside
    // /api/state, so the refetch is the whole delivery. Without it none of that
    // moved until the next heartbeat, which on a slow bring-up is the difference
    // between a start that is working and one that has hung.
    //
    // Rate-limited because this event also fires per line of output, and every
    // `dirty` costs every connected cockpit a full snapshot. A bring-up printing an
    // install log would otherwise pay for one of those per line, to move a caption.
    localRun.on('changed', () => {
      if (this.localRunPending !== null) return;
      this.localRunPending = setTimeout(() => {
        this.localRunPending = null;
        this.broadcast({ type: 'dirty' });
      }, LOCAL_RUN_COALESCE_MS);
    });
  }

  add(socket: WebSocket): void {
    this.sockets.add(socket);
    this.subscriptions.set(socket, new Set());
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.subscriptions.delete(socket);
    });
  }

  /** Handle an inbound client frame: (un)subscribe a socket to an agent's output. */
  handleClientMessage(socket: WebSocket, raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // ignore malformed frames
    }
    if (!msg || typeof msg !== 'object') return;
    const { type, agentId } = msg as { type?: unknown; agentId?: unknown };
    if (typeof agentId !== 'string') return;
    const subs = this.subscriptions.get(socket);
    if (!subs) return;
    if (type === 'subscribe') subs.add(agentId);
    else if (type === 'unsubscribe') subs.delete(agentId);
  }

  broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const socket of this.sockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  /**
   * Deliver an agent's output: the full `agent:output` frame goes only to sockets
   * subscribed to that agent, while a compact `agent:tail` (last non-empty line,
   * capped) is broadcast to everyone so the fleet view can show live status.
   */
  private handleOutput(agentId: string, delta: string): void {
    const payload = JSON.stringify({ type: 'agent:output', agentId, delta } satisfies ServerEvent);
    for (const socket of this.sockets) {
      if (socket.readyState !== socket.OPEN) continue;
      if (this.subscriptions.get(socket)?.has(agentId)) socket.send(payload);
    }
    const line = this.updateTail(agentId, delta);
    if (line) this.broadcast({ type: 'agent:tail', agentId, line });
  }

  /** Fold a delta into the agent's rolling tail; return the current tail line (≤200 chars). */
  private updateTail(agentId: string, delta: string): string {
    const state = this.tails.get(agentId) ?? { partial: '', last: '' };
    // Strip ANSI so a coloured transcript label never shows as a literal escape
    // in the plain-text fleet-card preview. (Escapes never contain newlines, so
    // stripping before the split is safe.)
    const segments = stripAnsi(state.partial + delta).split(/\r?\n/);
    const partial = segments.pop() ?? ''; // trailing segment is still an unfinished line
    for (const seg of segments) {
      const trimmed = seg.trim();
      if (trimmed) state.last = trimmed;
    }
    const partialTrimmed = partial.trim();
    if (partialTrimmed) state.last = partialTrimmed;
    state.partial = partial.slice(-256); // cap the partial-line buffer
    this.tails.set(agentId, state);
    return state.last.slice(0, 200);
  }
}
