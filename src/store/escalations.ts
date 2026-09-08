import { nanoid } from 'nanoid';
import type { Escalation, EscalationContext, EscalationSpan, Proposal } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

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
    const rows = this.ctx.db
      .prepare(`SELECT * FROM escalations ORDER BY created_at DESC, rowid DESC`)
      .all() as EscalationRow[];
    return rows.map(rowToEscalation);
  }

  listOpenEscalations(): Escalation[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM escalations WHERE status='open' ORDER BY created_at DESC`)
      .all() as EscalationRow[];
    return rows.map(rowToEscalation);
  }

  listEscalationSpans(): EscalationSpan[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT created_at, answered_at, status,
                json_extract(context, '$.originRef') AS origin_ref,
                json_extract(context, '$.prNumber')  AS pr_number
           FROM escalations`,
      )
      .all() as SpanRow[];
    return rows.map((r) => ({
      createdAt: r.created_at,
      answeredAt: r.answered_at,
      originRef: typeof r.origin_ref === 'string' ? r.origin_ref : null,
      prNumber: typeof r.pr_number === 'number' ? r.pr_number : null,
      open: r.status === 'open',
    }));
  }

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

  withdrawProposal(id: string, note: string): Proposal | null {
    const res = this.ctx.db
      .prepare(`UPDATE proposals SET status='withdrawn', note=?, decided_at=? WHERE id=? AND status='pending'`)
      .run(note, this.ctx.now(), id);
    if (res.changes === 0) return null;
    return this.getProposal(id);
  }

  getProposal(id: string): Proposal | null {
    const row = this.ctx.db.prepare(`SELECT * FROM proposals WHERE id=?`).get(id) as ProposalRow | undefined;
    return row ? rowToProposal(row) : null;
  }

  listProposals(): Proposal[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM proposals ORDER BY created_at DESC, rowid DESC`)
      .all() as ProposalRow[];
    return rows.map(rowToProposal);
  }
}

interface SpanRow {
  created_at: string;
  answered_at: string | null;
  status: string;
  origin_ref: unknown;
  pr_number: unknown;
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
