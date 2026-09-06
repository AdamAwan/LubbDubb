import type { WebSocket } from 'ws';
import type { System } from '../system.js';
import { stripAnsi } from '../agents/streamTranscript.js';
import type { StateSection } from '../wire.js';
import type { AgentFlag, WorldEvent } from '../types.js';

// → docs/spec/16-http-api.md

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
  | { type: 'config:changed' }
  | { type: 'world:events'; events: unknown[] }
  | { type: 'error:logged'; error: unknown }
  | { type: 'dirty'; sections?: StateSection[] };

const LOCAL_RUN_COALESCE_MS = 400;

export class Hub {
  private readonly sockets = new Set<WebSocket>();
  private readonly subscriptions = new Map<WebSocket, Set<string>>();
  private readonly tails = new Map<string, { partial: string; last: string }>();

  private localRunPending: NodeJS.Timeout | null = null;

  constructor(system: System) {
    const { harness, agents, escalations, errors, localRun, localRunWatch } = system;

    errors.on('logged', (error) => {
      this.broadcast({ type: 'error:logged', error });
      this.broadcast({ type: 'dirty', sections: ['activity'] });
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
    agents.on('flag', (e) => {
      this.broadcast({ type: 'agent:flag', flag: e.flag });
      this.broadcast({ type: 'dirty', sections: ['fleet'] });
    });
    agents.on('progress', () => this.broadcast({ type: 'dirty', sections: ['fleet'] }));
    system.readying.on('changed', () => this.broadcast({ type: 'dirty', sections: ['fleet'] }));
    agents.on('conclusion', () => this.broadcast({ type: 'dirty', sections: ['goals'] }));
    agents.on('goalMet', () => this.broadcast({ type: 'dirty', sections: ['goals'] }));
    agents.on('scratch', () => this.broadcast({ type: 'dirty', sections: ['goals'] }));
    system.reviewPacks.on('written', () => this.broadcast({ type: 'dirty', sections: ['goals'] }));
    system.reviewPackChecker.on('checked', () => this.broadcast({ type: 'dirty', sections: ['goals'] }));
    agents.on('retrospective', () => this.broadcast({ type: 'dirty', sections: ['goals'] }));
    agents.on('files', () => this.broadcast({ type: 'dirty', sections: ['fleet'] }));
    agents.on('usage', () => this.broadcast({ type: 'dirty', sections: ['fleet'] }));
    agents.on('resumed', () => this.broadcast({ type: 'dirty', sections: ['fleet'] }));
    agents.on('status', (e) => {
      this.broadcast({ type: 'agent:status', ...e });
      this.broadcast({ type: 'dirty' });
    });
    agents.on('waiting', (e) => {
      this.broadcast({ type: 'agent:waiting', ...e });
      this.broadcast({ type: 'dirty', sections: ['fleet'] });
    });
    agents.on('done', (e) => {
      this.broadcast({ type: 'agent:done', ...e });
      this.broadcast({ type: 'dirty' });
      this.tails.delete(e.agentId);
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

    const refetchLocalRun = (): void => {
      if (this.localRunPending !== null) return;
      this.localRunPending = setTimeout(() => {
        this.localRunPending = null;
        this.broadcast({ type: 'dirty', sections: ['harness'] });
      }, LOCAL_RUN_COALESCE_MS);
    };
    localRun.on('changed', refetchLocalRun);
    localRunWatch.on('changed', refetchLocalRun);
    system.localValidations.on('changed', () => this.broadcast({ type: 'dirty', sections: ['goals'] }));
  }

  add(socket: WebSocket): void {
    this.sockets.add(socket);
    this.subscriptions.set(socket, new Set());
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.subscriptions.delete(socket);
    });
  }

  handleClientMessage(socket: WebSocket, raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
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

  private handleOutput(agentId: string, delta: string): void {
    const payload = JSON.stringify({ type: 'agent:output', agentId, delta } satisfies ServerEvent);
    for (const socket of this.sockets) {
      if (socket.readyState !== socket.OPEN) continue;
      if (this.subscriptions.get(socket)?.has(agentId)) socket.send(payload);
    }
    const line = this.updateTail(agentId, delta);
    if (line) this.broadcast({ type: 'agent:tail', agentId, line });
  }

  private updateTail(agentId: string, delta: string): string {
    const state = this.tails.get(agentId) ?? { partial: '', last: '' };
    const segments = stripAnsi(state.partial + delta).split(/\r?\n/);
    const partial = segments.pop() ?? '';
    for (const seg of segments) {
      const trimmed = seg.trim();
      if (trimmed) state.last = trimmed;
    }
    const partialTrimmed = partial.trim();
    if (partialTrimmed) state.last = partialTrimmed;
    state.partial = partial.slice(-256);
    this.tails.set(agentId, state);
    return state.last.slice(0, 200);
  }
}
