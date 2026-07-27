import { EventEmitter } from 'node:events';
import type { Store } from '../store/store.js';
import type { AgentManager } from '../agents/agentManager.js';
import type { Escalation, EscalationContext, EscalationType } from '../types.js';

interface CreateEscalationInput {
  type: EscalationType;
  prompt: string;
  context?: EscalationContext;
  agentId?: string | null;
  taskId?: string | null;
}

interface AnswerResult {
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

  /**
   * Settle an escalation the harness resolved *out of band* — not by typing an
   * answer into the agent's session. The permission backstop (issue #130) is the
   * one caller: the agent is blocked inside a `--permission-prompt-tool` call, so
   * the "answer" is the tool's return value, and routing text into the session
   * (what {@link answer} does) would corrupt a session that isn't at a prompt.
   * Marks the item answered and emits so the cockpit refreshes, nothing more.
   */
  settleResolved(id: string, response: string): Escalation {
    const esc = this.store.getEscalation(id);
    if (!esc) throw new Error(`Escalation ${id} not found`);
    if (esc.status !== 'open') throw new Error(`Escalation ${id} is already ${esc.status}`);
    const updated = this.store.answerEscalation(id, response);
    this.emit('answered', { escalation: updated, routing: 'resolved_out_of_band' });
    return updated;
  }

  /**
   * Clear an item the operator has decided needs nothing from them — the thing was
   * handled outside the harness, or the agent carried on regardless (see
   * `Agent.resumedAt`). Nothing is typed into the agent: an answer that exists only
   * to empty the inbox is a message the agent then has to make sense of, which is
   * the workaround this replaces.
   *
   * It does release the agent's park latch, and that is load-bearing rather than
   * tidy: while the latch is held `AgentManager.handleWaiting` early-returns, so an
   * agent whose alert was dismissed would be unable to raise another one ever. The
   * reason is recorded on the item itself (`context.dismissal`, no schema change)
   * and in the audit log, so a cleared alert leaves a trace like any other outcome.
   */
  dismiss(id: string, note?: string): Escalation {
    const esc = this.store.getEscalation(id);
    if (!esc) throw new Error(`Escalation ${id} not found`);
    if (esc.status !== 'open') throw new Error(`Escalation ${id} is already ${esc.status}`);
    const reason = note?.trim() || 'Dismissed by the operator without an answer.';
    const at = new Date().toISOString();
    const updated = this.store.dismissEscalation(id, { ...esc.context, dismissal: { reason, at, by: 'operator' } });
    if (esc.agentId) this.agents.releasePark(esc.agentId);
    this.store.recordDecision({
      cycleId: `human:${id}`,
      action: { type: 'no_op', reason: 'dismiss escalation' },
      outcome: 'executed',
      detail: `You dismissed escalation ${id} without answering: ${reason}`,
    });
    this.emit('dismissed', updated);
    return updated;
  }

  /**
   * Cascade-dismiss every open escalation tied to an agent that has reached a
   * terminal-dead state (server restart / kill / crash). Such an agent can never
   * receive the answer, so leaving these `open` just clutters "Needs you" with
   * un-actionable items — answering one would route nowhere. We flip them to the
   * existing `dismissed` status, recording *why* in the escalation's own context
   * (`context.dismissal`, so no schema change) and in the audit log, and emit a
   * `dismissed` event so the cockpit refreshes. Returns the escalations dismissed.
   */
  dismissEscalationsForAgent(agentId: string, reason: string): Escalation[] {
    const at = new Date().toISOString();
    const dismissed: Escalation[] = [];
    for (const esc of this.store.listOpenEscalations()) {
      if (esc.agentId !== agentId) continue;
      const context = { ...esc.context, dismissal: { reason, at } };
      const updated = this.store.dismissEscalation(esc.id, context);
      this.store.recordDecision({
        cycleId: 'agent-lifecycle',
        action: { type: 'no_op', reason: 'dismiss orphaned escalation' },
        outcome: 'executed',
        detail: `Auto-dismissed escalation ${esc.id} for dead agent ${agentId}: ${reason}`,
      });
      this.emit('dismissed', updated);
      dismissed.push(updated);
    }
    return dismissed;
  }
}
