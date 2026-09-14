import { EventEmitter } from 'node:events';
import type { Store } from '../store/store.js';
import type { AgentManager } from '../agents/agentManager.js';
import type { AgentStatus, Escalation, EscalationContext, EscalationType } from '../types.js';
import { settledMergeAsks } from '../proposals/settledMerges.js';

// → docs/spec/05-dispatcher.md

const DEAD_AGENT_STATUSES: ReadonlySet<AgentStatus> = new Set<AgentStatus>(['done', 'failed', 'killed', 'interrupted']);

interface CreateEscalationInput {
  type: EscalationType;
  prompt: string;
  context?: EscalationContext;
  agentId?: string | null;
  taskId?: string | null;
}

interface AnswerResult {
  escalation: Escalation;
  routing: 'typed_into_agent' | 'queued_for_dispatch';
}

export class EscalationInbox extends EventEmitter {
  constructor(
    private readonly store: Store,
    private readonly agents: AgentManager,
  ) {
    super();
  }

  create(input: CreateEscalationInput): Escalation {
    const esc = this.store.escalations.createEscalation({
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
    const esc = this.store.escalations.getEscalation(id);
    if (!esc) throw new Error(`Escalation ${id} not found`);
    if (esc.status !== 'open') throw new Error(`Escalation ${id} is already ${esc.status}`);

    const updated = this.store.escalations.answerEscalation(id, response);

    let routing: AnswerResult['routing'] = 'queued_for_dispatch';
    if (esc.agentId && this.agents.isLive(esc.agentId)) {
      const typed = this.agents.respond(esc.agentId, response);
      if (typed) routing = 'typed_into_agent';
    }
    this.emit('answered', { escalation: updated, routing });
    return { escalation: updated, routing };
  }

  settleResolved(id: string, response: string): Escalation {
    const esc = this.store.escalations.getEscalation(id);
    if (!esc) throw new Error(`Escalation ${id} not found`);
    if (esc.status !== 'open') throw new Error(`Escalation ${id} is already ${esc.status}`);
    const updated = this.store.escalations.answerEscalation(id, response);
    this.emit('answered', { escalation: updated, routing: 'resolved_out_of_band' });
    return updated;
  }

  dismiss(id: string, note?: string): Escalation {
    const esc = this.store.escalations.getEscalation(id);
    if (!esc) throw new Error(`Escalation ${id} not found`);
    if (esc.status !== 'open') throw new Error(`Escalation ${id} is already ${esc.status}`);
    const reason = note?.trim() || 'Dismissed by the operator without an answer.';
    const at = new Date().toISOString();
    const updated = this.store.escalations.dismissEscalation(id, {
      ...esc.context,
      dismissal: { reason, at, by: 'operator' },
    });
    if (esc.agentId) this.agents.releasePark(esc.agentId);
    this.store.decisions.recordDecision({
      cycleId: `human:${id}`,
      action: { type: 'no_op', reason: 'dismiss escalation' },
      outcome: 'executed',
      detail: `You dismissed escalation ${id} without answering: ${reason}`,
    });
    this.emit('dismissed', updated);
    return updated;
  }

  dismissEscalationsForAgent(agentId: string, reason: string): Escalation[] {
    const at = new Date().toISOString();
    const dismissed: Escalation[] = [];
    for (const esc of this.store.escalations.listOpenEscalations()) {
      if (esc.agentId !== agentId) continue;
      const context = { ...esc.context, dismissal: { reason, at } };
      const updated = this.store.escalations.dismissEscalation(esc.id, context);
      this.store.decisions.recordDecision({
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

  /**
   * Settle every merge ask whose pull request has already left the open set, and
   * withdraw the proposal under it. Run once per pulse, and idempotent.
   *
   * → docs/spec/07-pull-requests.md#a-merge-ask-outlives-its-pull-request
   *
   * @public reached through `HarnessDeps.escalations`, a structural seam.
   */
  tidySettledMerges(): Escalation[] {
    const settled = settledMergeAsks({
      proposals: this.store.escalations.listProposals(),
      openEscalations: this.store.escalations.listOpenEscalations(),
      settledPrs: this.store.graph.settledPrs(),
    });
    const answered: Escalation[] = [];
    for (const ask of settled) {
      for (const proposalId of ask.proposalIds) {
        if (!this.store.escalations.withdrawProposal(proposalId, ask.verdict)) continue;
        this.store.decisions.recordDecision({
          cycleId: 'pr-lifecycle',
          action: { type: 'no_op', reason: 'withdraw a merge proposal its pull request settled' },
          outcome: 'executed',
          detail: `Withdrew merge proposal ${proposalId}: ${ask.verdict}`,
        });
      }
      for (const id of ask.escalationIds) answered.push(this.settleResolved(id, ask.verdict));
    }
    return answered;
  }

  /**
   * Sweep every open escalation whose agent has already left the fleet, whatever
   * route it left by. Run once per pulse, and idempotent — a clean inbox writes
   * nothing.
   *
   * The terminal-state listeners in `src/system.ts` are the fast path, and this is
   * the backstop, because the fast path is an *enumeration of transitions* that has
   * to stay complete: a death arriving by a route nobody wired there leaves an
   * un-answerable "Needs you" card up for good, and nothing about it looks wrong —
   * the card renders correctly, the agent is simply not there to hear the answer.
   * Only escalations carrying an `agentId` are in scope, which is exactly the two
   * kinds raised *by a process* (a park, and a permission request); a proposal or a
   * stack-landing item carries none and is answerable no matter what the fleet did.
   *
   * An `agentId` naming no agent row is left alone: rows are never deleted, so that
   * would be a fault elsewhere, and dismissing on a read that came back empty is how
   * a store bug turns into a silently emptied inbox.
   *
   * @public reached through `HarnessDeps.escalations`, a structural seam.
   */
  tidyDeadAgents(): Escalation[] {
    const dead = new Map<string, AgentStatus>();
    for (const esc of this.store.escalations.listOpenEscalations()) {
      if (!esc.agentId || dead.has(esc.agentId)) continue;
      const agent = this.store.agents.getAgent(esc.agentId);
      if (agent && DEAD_AGENT_STATUSES.has(agent.status)) dead.set(esc.agentId, agent.status);
    }
    return [...dead].flatMap(([agentId, status]) =>
      this.dismissEscalationsForAgent(agentId, `agent ${status}; nobody is left to answer`),
    );
  }
}
