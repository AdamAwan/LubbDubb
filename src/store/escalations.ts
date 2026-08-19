import { nanoid } from 'nanoid';
import type { Escalation, EscalationContext, Proposal } from '../types.js';
import type { StoreContext } from './context.js';

/**
 * The `escalations` and `proposals` tables: everything the harness puts to a human.
 *
 * One module because a proposal hangs off an escalation (`escalation_id`) — the
 * escalation is the inbox item and the routing mechanism, the proposal is the
 * typed verdict that lets the harness branch on the answer — and the 409 rule that
 * keeps them consistent (an escalation cannot be answered as free text while a
 * pending proposal hangs off it) is a statement about the join.
 */
export class EscalationStore {
  constructor(private readonly ctx: StoreContext) {}

  createEscalation(input: Omit<Escalation, 'id' | 'status' | 'response' | 'createdAt' | 'answeredAt'>): Escalation {
    const esc: Escalation = {
      id: `esc_${nanoid(10)}`,
      status: 'open',
      response: null,
      createdAt: this.ctx.now(),
      answeredAt: null,
      type: input.type,
      prompt: input.prompt,
      context: input.context,
      agentId: input.agentId,
      taskId: input.taskId,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO escalations (id, type, status, prompt, context, agent_id, task_id, response, created_at, answered_at)
         VALUES (@id, @type, @status, @prompt, @context, @agentId, @taskId, @response, @createdAt, @answeredAt)`,
      )
      .run({ ...esc, context: JSON.stringify(esc.context) });
    return esc;
  }

  answerEscalation(id: string, response: string): Escalation {
    const existing = this.getEscalation(id);
    if (!existing) throw new Error(`Escalation ${id} not found`);
    const answeredAt = this.ctx.now();
    this.ctx.db
      .prepare(`UPDATE escalations SET status='answered', response=?, answered_at=? WHERE id=?`)
      .run(response, answeredAt, id);
    return { ...existing, status: 'answered', response, answeredAt };
  }

  /**
   * Flip an escalation to `dismissed`, persisting the caller-built context (which
   * carries the dismissal reason + timestamp). The store stays a dumb data layer:
   * the decision of *what* to dismiss and *why* lives in the EscalationInbox.
   */
  dismissEscalation(id: string, context: Record<string, unknown>): Escalation {
    const existing = this.getEscalation(id);
    if (!existing) throw new Error(`Escalation ${id} not found`);
    this.ctx.db
      .prepare(`UPDATE escalations SET status='dismissed', context=? WHERE id=?`)
      .run(JSON.stringify(context), id);
    return { ...existing, status: 'dismissed', context };
  }

  getEscalation(id: string): Escalation | null {
    const row = this.ctx.db.prepare(`SELECT * FROM escalations WHERE id=?`).get(id) as EscalationRow | undefined;
    return row ? rowToEscalation(row) : null;
  }

  /**
   * The question each of these escalations asked, by id.
   *
   * For the pets panel, which has an `origin_ref` and nothing to call it. A
   * by-id read over the refs the vivarium holds, never a walk: `listEscalations`
   * is unbounded and the pet that needs naming is usually the oldest one.
   * An id with no row is simply absent from the map — a pruned source is not an
   * error here. → `docs/spec/22-pets.md#the-sources`
   */
  escalationLabels(ids: string[]): Map<string, string> {
    if (ids.length === 0) return new Map();
    const holes = ids.map(() => '?').join(',');
    const rows = this.ctx.db.prepare(`SELECT id, prompt FROM escalations WHERE id IN (${holes})`).all(...ids) as {
      id: string;
      prompt: string;
    }[];
    return new Map(rows.map((r) => [r.id, r.prompt]));
  }

  listEscalations(): Escalation[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM escalations ORDER BY created_at DESC`).all() as EscalationRow[];
    return rows.map(rowToEscalation);
  }

  listOpenEscalations(): Escalation[] {
    return this.listEscalations().filter((e) => e.status === 'open');
  }

  // -- Proposals (human decisions) -----------------------------------------

  createProposal(input: Omit<Proposal, 'id' | 'status' | 'note' | 'decidedBy' | 'decidedAt' | 'createdAt'>): Proposal {
    const proposal: Proposal = {
      id: `prop_${nanoid(10)}`,
      status: 'pending',
      note: null,
      decidedBy: null,
      decidedAt: null,
      createdAt: this.ctx.now(),
      kind: input.kind,
      ref: input.ref,
      action: input.action,
      escalationId: input.escalationId,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO proposals (id, kind, ref, status, action, note, decided_by, decided_at, escalation_id, created_at)
         VALUES (@id, @kind, @ref, @status, @action, @note, @decidedBy, @decidedAt, @escalationId, @createdAt)`,
      )
      .run({ ...proposal, action: JSON.stringify(proposal.action) });
    return proposal;
  }

  /**
   * Settle a pending proposal, once. The `status='pending'` predicate makes this a
   * compare-and-set rather than a read-then-write: a second accept changes no rows
   * and gets `null` back, so "accepting twice posts once" is a property of the
   * write, not of whoever remembered to check first.
   */
  decideProposal(
    id: string,
    status: Extract<Proposal['status'], 'accepted' | 'rejected'>,
    note: string | null,
    decidedBy: NonNullable<Proposal['decidedBy']>,
  ): Proposal | null {
    const decidedAt = this.ctx.now();
    const res = this.ctx.db
      .prepare(`UPDATE proposals SET status=?, note=?, decided_by=?, decided_at=? WHERE id=? AND status='pending'`)
      .run(status, note, decidedBy, decidedAt, id);
    if (res.changes === 0) return null;
    const existing = this.getProposal(id);
    return existing;
  }

  getProposal(id: string): Proposal | null {
    const row = this.ctx.db.prepare(`SELECT * FROM proposals WHERE id=?`).get(id) as ProposalRow | undefined;
    return row ? rowToProposal(row) : null;
  }

  /**
   * Every proposal, newest first — deliberately unbounded. The dispatcher's gate
   * reads the *standing* verdict for a ref, so a rejection that aged out of a
   * window would quietly re-propose an act the operator already refused.
   */
  listProposals(): Proposal[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM proposals ORDER BY created_at DESC, rowid DESC`)
      .all() as ProposalRow[];
    return rows.map(rowToProposal);
  }
}

interface EscalationRow {
  id: string;
  type: string;
  status: string;
  prompt: string;
  context: string;
  agent_id: string | null;
  task_id: string | null;
  response: string | null;
  created_at: string;
  answered_at: string | null;
}
interface ProposalRow {
  id: string;
  kind: string;
  ref: string;
  status: string;
  action: string;
  note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  escalation_id: string | null;
  created_at: string;
}

function rowToEscalation(r: EscalationRow): Escalation {
  return {
    id: r.id,
    type: r.type as Escalation['type'],
    status: r.status as Escalation['status'],
    prompt: r.prompt,
    context: JSON.parse(r.context) as EscalationContext,
    agentId: r.agent_id,
    taskId: r.task_id,
    response: r.response,
    createdAt: r.created_at,
    answeredAt: r.answered_at,
  };
}
function rowToProposal(r: ProposalRow): Proposal {
  return {
    id: r.id,
    kind: r.kind as Proposal['kind'],
    ref: r.ref,
    status: r.status as Proposal['status'],
    action: JSON.parse(r.action) as Proposal['action'],
    note: r.note,
    decidedBy: r.decided_by as Proposal['decidedBy'],
    decidedAt: r.decided_at,
    escalationId: r.escalation_id,
    createdAt: r.created_at,
  };
}
