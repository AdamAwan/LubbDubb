import type { HandledAction, HandledKind, HandledState } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md, docs/spec/43-handled-for-you.md

interface HandledRow {
  id: number;
  kind: HandledKind;
  issue_number: number;
  before_value: string | null;
  after_value: string;
  reason: string;
  state: HandledState;
  created_at: string;
}

function fromRow(r: HandledRow): HandledAction {
  return {
    id: r.id,
    kind: r.kind,
    issueNumber: r.issue_number,
    before: r.before_value,
    after: r.after_value,
    reason: r.reason,
    state: r.state,
    createdAt: r.created_at,
  };
}

export class HandledStore {
  constructor(private readonly ctx: StoreContext) {}

  record(input: {
    kind: HandledKind;
    issueNumber: number;
    before: string | null;
    after: string;
    reason: string;
  }): HandledAction {
    const row = this.ctx
      .prep(
        `INSERT INTO handled_actions (kind, issue_number, before_value, after_value, reason, state, created_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?) RETURNING *`,
      )
      .get(input.kind, input.issueNumber, input.before, input.after, input.reason, this.ctx.now()) as HandledRow;
    return fromRow(row);
  }

  get(id: number): HandledAction | null {
    const row = this.ctx.prep(`SELECT * FROM handled_actions WHERE id = ?`).get(id) as HandledRow | undefined;
    return row ? fromRow(row) : null;
  }

  since(iso: string): HandledAction[] {
    const rows = this.ctx
      .prep(`SELECT * FROM handled_actions WHERE created_at >= ? ORDER BY created_at DESC, id DESC`)
      .all(iso) as HandledRow[];
    return rows.map(fromRow);
  }

  countOpenSince(iso: string): number {
    const row = this.ctx
      .prep(`SELECT COUNT(*) AS n FROM handled_actions WHERE state = 'open' AND created_at >= ?`)
      .get(iso) as { n: number };
    return row.n;
  }

  setState(id: number, state: HandledState): void {
    this.ctx.prep(`UPDATE handled_actions SET state = ? WHERE id = ?`).run(state, id);
  }

  /** Marks the open ones among `ids` checked, in one statement. */
  check(ids: readonly number[]): void {
    this.ctx
      .prep(
        `UPDATE handled_actions SET state = 'checked' WHERE state = 'open' AND id IN (SELECT value FROM json_each(?))`,
      )
      .run(JSON.stringify(ids));
  }
}
