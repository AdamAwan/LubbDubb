import { nanoid } from 'nanoid';
import type { Decision } from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

export const DECISION_COLUMNS: ColumnMigrations = {
  decisions: {
    rule: 'TEXT',
    // Split out of `rule` rather than replacing it: an old row keeps the
    // *outcome* in `rule` with this NULL, and nothing rewrites history, so the
    // two shapes coexist for good.
    admission: 'TEXT',
  },
};

/** The `decisions` table: the audit row for every act the harness took. */
export class DecisionStore {
  constructor(private readonly ctx: StoreContext) {}

  recordDecision(input: Omit<Decision, 'id' | 'createdAt' | 'rule' | 'admission'>): Decision {
    // Both ids ride on the action (its transport from the dispatcher); lift them
    // into their own columns here so the row answers "what proposed this" and
    // "what became of it" separately — one column answering both is what lost
    // `issue-pickup` behind `cooldown-escalate`.
    const decision: Decision = {
      id: `dec_${nanoid(10)}`,
      createdAt: this.ctx.now(),
      rule: input.action.rule ?? null,
      admission: input.action.admission ?? null,
      ...input,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO decisions (id, cycle_id, action, outcome, detail, rule, admission, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        decision.id,
        decision.cycleId,
        JSON.stringify(decision.action),
        decision.outcome,
        decision.detail,
        decision.rule,
        decision.admission,
        decision.createdAt,
      );
    return decision;
  }

  listDecisions(limit = 200): Decision[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM decisions ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as DecisionRow[];
    return rows.map(rowToDecision);
  }
}

interface DecisionRow {
  id: string;
  cycle_id: string;
  action: string;
  outcome: string;
  detail: string;
  rule: string | null;
  admission: string | null;
  created_at: string;
}

function rowToDecision(r: DecisionRow): Decision {
  return {
    id: r.id,
    cycleId: r.cycle_id,
    action: JSON.parse(r.action) as Decision['action'],
    outcome: r.outcome as Decision['outcome'],
    detail: r.detail,
    rule: r.rule,
    // `?? null` rather than a bare read: a database created before the column
    // existed has just had it added by `ensureColumns`, so every historical row
    // reads NULL here — but a row read through a path that predates the
    // migration would be `undefined`, and the two must not differ downstream.
    admission: r.admission ?? null,
    createdAt: r.created_at,
  };
}
