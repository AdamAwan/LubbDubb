import type { WebSocket } from 'ws';
import type { System } from '../system.js';
import { stripAnsi } from '../agents/streamTranscript.js';
import type { StateSection } from '../wire.js';
import type { AgentFlag, WorldEvent } from '../types.js';

export type ServerEvent =
  | { type: 'cycle:start'; cycleId: string; source: string }
  | { type: 'cycle:end'; cycleId: string; rationale: string; summary: unknown }
  | { type: 'agent:output'; agentId: string; delta: string }
  | { type: 'agent:tail'; agentId: string; line: string }
  | { type: 'agent:flag'; flag: AgentFlag }
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
  /**
   * "Re-read the snapshot." **`sections` names what actually moved**, and a frame
   * without it means everything — which is what a signal that cannot say should
   * send, since answering "all of it" is never wrong, only expensive.
   *
   * The cockpit refetches on every one of these, and one pulse is four of them
   * while `agents.on('files')` fires once *per file an agent writes*. Rebuilding
   * the goal enrichment for a file write was ~75 ms of a ~125 ms build, per
   * signal, per open cockpit — for a section that written file cannot change. The
   * browser asks for the named sections and merges the patch over the snapshot it
   * holds. → `docs/spec/16-http-api.md#sections`
   */
  | { type: 'dirty'; sections?: StateSection[] };

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
      this.broadcast({ type: 'dirty', sections: ['activity'] });
    });

    harness.on('cycle:start', (e: { cycleId: string; source: string }) =>
      this.broadcast({ type: 'cycle:start', ...e }),
    );
    harness.on('cycle:end', (r: { cycleId: string; rationale: string; summary: unknown }) => {
      this.broadcast({ type: 'cycle:end', cycleId: r.cycleId, rationale: r.rationale, summary: r.summary });
      // Unscoped, and it must stay that way: a pulse dispatches, files, concludes,
      // plans and reaps, so there is no section it cannot have moved.
      this.broadcast({ type: 'dirty' });
    });
    harness.on('world:events', ({ events }: { events: WorldEvent[] }) => {
      this.broadcast({ type: 'world:events', events });
      // Also unscoped: a world event is what expires a delivery hold, re-opens a
      // goal for pickup and moves a pull request, and the feed itself is `activity`.
      this.broadcast({ type: 'dirty' });
    });

    agents.on('output', (e) => this.handleOutput(e.agentId, e.delta));
    // Flags are low-volume and shown fleet-wide (a chip on the card), so unlike
    // output they're broadcast to every socket, not just an agent's subscribers.
    agents.on('flag', (e) => {
      this.broadcast({ type: 'agent:flag', flag: e.flag });
      this.broadcast({ type: 'dirty', sections: ['fleet'] });
    });
    // The agent said what it is working on. No dedicated frame: the note lives on
    // the agent row, so the /api/state refetch a `dirty` triggers *is* the whole
    // delivery — unlike `agent:tail`, which exists only as a broadcast and has to
    // carry its own payload. Same treatment as `usage` for the same reason.
    agents.on('progress', () => this.broadcast({ type: 'dirty', sections: ['fleet'] }));
    // An agent said whether its issue is finished. Same treatment and the same
    // reason: the verdict is shipped per-issue inside /api/state, so the refetch
    // a `dirty` triggers is the whole delivery.
    agents.on('conclusion', () => this.broadcast({ type: 'dirty', sections: ['goals'] }));
    // A planner found its goal already met, which parks the issue. Same treatment
    // and the same reason: the delivery verdict is shipped per-issue inside
    // /api/state, so the refetch a `dirty` triggers is the whole delivery.
    agents.on('goalMet', () => this.broadcast({ type: 'dirty', sections: ['goals'] }));
    // A pad note and a finished retrospective are both shipped inside /api/state
    // (the retro as its per-issue reading; the pad through the retro that quotes
    // it), so a coarse dirty is the whole delivery for each.
    agents.on('scratch', () => this.broadcast({ type: 'dirty', sections: ['goals'] }));
    // A pack landing is the moment a reviewer who asked for one stops waiting;
    // the goal page carries the pull request's row, so that is the section.
    system.reviewPacks.on('written', () => this.broadcast({ type: 'dirty', sections: ['goals'] }));
    agents.on('retrospective', () => this.broadcast({ type: 'dirty', sections: ['goals'] }));
    // An agent wrote down what it learned, or agreed with something already
    // written. Coarse for the pad's reason: every fact the Knowledge page draws
    // rides inside /api/state, so the refetch a `dirty` triggers is the whole
    // delivery — and the point of hearing it here at all is that the page shows a
    // proposal the moment it is filed rather than on the next pulse.
    agents.on('fact', () => this.broadcast({ type: 'dirty', sections: ['knowledge'] }));
    // The file-events hook recorded a written file. The drawer's "files changed"
    // list is its own route now, so the only thing on the snapshot this can move is
    // `overlaps` — hence `fleet`, and hence the point of scoping at all: this fires
    // once *per file an agent writes*, and it used to rebuild all 48 keys each time.
    // (Report-like writes also arrive as an agent:flag above.)
    agents.on('files', () => this.broadcast({ type: 'dirty', sections: ['fleet'] }));
    // Usage lands on the agent row at turn end; a coarse dirty repaints the
    // fleet cards' cost/tokens without a dedicated frame type.
    agents.on('usage', () => this.broadcast({ type: 'dirty', sections: ['fleet'] }));
    // A parked agent was seen working anyway, so its open alert is probably stale.
    // Same treatment again: `resumedAt` is on the agent row the refetch brings, and
    // the cockpit derives the staleness itself rather than being told twice.
    agents.on('resumed', () => this.broadcast({ type: 'dirty', sections: ['fleet'] }));
    // **Unscoped, deliberately.** A lifecycle transition changes `countLiveAgents`,
    // which is the headroom in `pickupCtx` — so it moves the pickup verdict on
    // every goal and the runway band with it, not just the row that changed. The
    // high-frequency signals above are the ones scoping is for, and none of them
    // touch headroom; these are one per agent per run.
    agents.on('status', (e) => {
      this.broadcast({ type: 'agent:status', ...e });
      this.broadcast({ type: 'dirty' });
    });
    // A park is still a live agent, so headroom is unchanged and this is the row.
    agents.on('waiting', (e) => {
      this.broadcast({ type: 'agent:waiting', ...e });
      this.broadcast({ type: 'dirty', sections: ['fleet'] });
    });
    // Unscoped for `status`' reason, and more so: a slot has just come free.
    agents.on('done', (e) => {
      this.broadcast({ type: 'agent:done', ...e });
      this.broadcast({ type: 'dirty' });
      this.tails.delete(e.agentId); // agent finished; drop its rolling tail buffer
    });

    escalations.on('created', (escalation) => {
      this.broadcast({ type: 'escalation:created', escalation });
      this.broadcast({ type: 'dirty', sections: ['inbox'] });
    });
    escalations.on('answered', ({ escalation, routing }: { escalation: unknown; routing: string }) => {
      this.broadcast({ type: 'escalation:answered', escalation, routing });
      this.broadcast({ type: 'dirty', sections: ['inbox'] });
    });
    escalations.on('dismissed', (escalation) => {
      this.broadcast({ type: 'escalation:dismissed', escalation });
      this.broadcast({ type: 'dirty', sections: ['inbox'] });
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
        this.broadcast({ type: 'dirty', sections: ['harness'] });
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
