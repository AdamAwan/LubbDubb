import type { PrReviewRoute, PrReviewRouteInput } from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export const PR_REVIEW_ROUTE_COLUMNS: ColumnMigrations = {
  pr_review_routes: {
    skipped: 'INTEGER',
  },
};

export class PrReviewRouteStore {
  constructor(private readonly ctx: StoreContext) {}

  recordPrReviewRoute(input: PrReviewRouteInput): PrReviewRoute {
    const decidedAt = this.ctx.now();
    this.ctx.db
      .prepare(
        `INSERT INTO pr_review_routes (pr_number, mode, skipped, reason, agent_id, decided_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(pr_number) DO UPDATE SET
           mode = excluded.mode,
           skipped = excluded.skipped,
           reason = excluded.reason,
           agent_id = excluded.agent_id,
           decided_at = excluded.decided_at`,
      )
      .run(input.prNumber, input.mode, input.skipped ? 1 : 0, input.reason, input.agentId, decidedAt);
    return { ...input, decidedAt };
  }

  listPrReviewRoutes(): PrReviewRoute[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM pr_review_routes ORDER BY decided_at DESC`).all() as Row[];
    return rows.map((row) => ({
      prNumber: row.pr_number,
      mode: row.mode,
      skipped: row.skipped === 1,
      reason: row.reason,
      agentId: row.agent_id,
      decidedAt: row.decided_at,
    }));
  }
}

interface Row {
  pr_number: number;
  mode: string;
  skipped: number | null;
  reason: string;
  agent_id: string | null;
  decided_at: string;
}
