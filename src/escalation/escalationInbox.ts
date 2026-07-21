import { EventEmitter } from 'node:events';
import type { Store } from '../store/store.js';
import type { AgentManager } from '../agents/agentManager.js';
import type { Escalation, EscalationContext, EscalationType } from '../types.js';

export interface CreateEscalationInput {
  type: EscalationType;
  prompt: string;
  context?: EscalationContext;
  agentId?: string | null;
  taskId?: string | null;
}

export interface AnswerResult {
  escalation: Escalation;
  /** How the answer was applied. */
  routing: 'typed_into_agent' | 'queued_for_dispatch';
}

/**
 * The human-in-the-loop surface. Anything the harness can't safely decide on its
 * own lands here as a parked item. Responses route two ways:
 *
 *   - tied to a live, parked agent  -> typed straight into that PTY session so
 *     the agent continues;
 *   - otherwise                     -> recorded so the next dispatch cycle sees
 *     the answer and acts on it.
 */
export class EscalationInbox extends EventEmitter {
  constructor(
    private readonly store: Store,
    private readonly agents: AgentManager,
  ) {
    super();
  }

  create(input: CreateEscalationInput): Escalation {
    const esc = this.store.createEscalation({
      type: input.type,
      prompt: input.prompt,
      context: input.context ?? {},
      agentId: input.agentId ?? null,
      taskId: input.taskId ?? null,
    });
    this.emit('created', esc);
    return esc;
  }

  answer(id: string, response: string): AnswerResult {
    const esc = this.store.getEscalation(id);
    if (!esc) throw new Error(`Escalation ${id} not found`);
    if (esc.status !== 'open') throw new Error(`Escalation ${id} is already ${esc.status}`);

    const updated = this.store.answerEscalation(id, response);

    let routing: AnswerResult['routing'] = 'queued_for_dispatch';
    if (esc.agentId && this.agents.isLive(esc.agentId)) {
      const typed = this.agents.respond(esc.agentId, response);
      if (typed) routing = 'typed_into_agent';
    }
    this.emit('answered', { escalation: updated, routing });
    return { escalation: updated, routing };
  }

  listOpen(): Escalation[] {
    return this.store.listOpenEscalations();
  }
}
