import type { WebSocket } from 'ws';
import type { System } from '../system.js';

export type ServerEvent =
  | { type: 'cycle:start'; cycleId: string; source: string }
  | { type: 'cycle:end'; cycleId: string; rationale: string; summary: unknown }
  | { type: 'agent:output'; agentId: string; delta: string }
  | { type: 'agent:status'; agentId: string; taskId: string; status: string }
  | { type: 'agent:waiting'; agentId: string; taskId: string; reason: string }
  | { type: 'agent:done'; agentId: string; taskId: string; status: string }
  | { type: 'escalation:created'; escalation: unknown }
  | { type: 'escalation:answered'; escalation: unknown; routing: string }
  | { type: 'world:changed' }
  | { type: 'dirty' };

/**
 * Fans harness/agent/escalation events out to every connected cockpit socket.
 * A coarse `dirty` signal tells clients "re-fetch /api/state"; fine-grained
 * events (agent output, waiting) let the UI react live without polling.
 */
export class Hub {
  private readonly sockets = new Set<WebSocket>();

  constructor(system: System) {
    const { harness, agents, escalations } = system;

    harness.on('cycle:start', (e: { cycleId: string; source: string }) =>
      this.broadcast({ type: 'cycle:start', ...e }),
    );
    harness.on('cycle:end', (r: { cycleId: string; rationale: string; summary: unknown }) => {
      this.broadcast({ type: 'cycle:end', cycleId: r.cycleId, rationale: r.rationale, summary: r.summary });
      this.broadcast({ type: 'dirty' });
    });

    agents.on('output', (e) => this.broadcast({ type: 'agent:output', ...e }));
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
    });

    escalations.on('created', (escalation) => {
      this.broadcast({ type: 'escalation:created', escalation });
      this.broadcast({ type: 'dirty' });
    });
    escalations.on('answered', ({ escalation, routing }: { escalation: unknown; routing: string }) => {
      this.broadcast({ type: 'escalation:answered', escalation, routing });
      this.broadcast({ type: 'dirty' });
    });
  }

  add(socket: WebSocket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
  }

  broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const socket of this.sockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }
}
