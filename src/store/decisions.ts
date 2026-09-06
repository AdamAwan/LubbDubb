import { nanoid } from 'nanoid';
import type { Decision } from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export const DECISION_COLUMNS: ColumnMigrations = {
  decisions: {
    rule: 'TEXT',
    admission: 'TEXT',
  },
};

export class DecisionStore {
  constructor(private readonly ctx: StoreContext) {}

  recordDecision(input: Omit<Decision, 'id' | 'createdAt' | 'rule' | 'admission'>): Decision {
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

  listDecisionsForGoal(goalRef: string, limit = 200): Decision[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT * FROM decisions
         WHERE json_extract(action, '$.originRef') = ?
            OR json_extract(action, '$.originRef') LIKE ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(goalRef, `${goalRef}:%`, limit) as DecisionRow[];
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
    admission: r.admission ?? null,
    createdAt: r.created_at,
  };
}
