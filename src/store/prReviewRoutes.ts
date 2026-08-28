import type { PrReviewRoute, PrReviewRouteInput } from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

/**
 * `skipped` arrived after the table did, so it needs its `ALTER TABLE` — declared
 * here rather than centrally, so "did this column get an entry?" is answerable
 * without leaving the file that reads it.
 *
 * **Nullable, and it needs no backfill**, which is the distinction
 * [14](docs/spec/14-persistence.md#when-a-null-means-something) turns on: null here
 * is not a third state waiting to be resolved, it is exactly what every row written
 * before this existed meant — that pull request was routed to a mode and reviewed.
 * Declared nullable in `SCHEMA` too, so the column has one shape on a fresh
 * database and on a migrated one rather than two that read the same until something
 * writes null.
 */
export const PR_REVIEW_ROUTE_COLUMNS: ColumnMigrations = {
  pr_review_routes: {
    skipped: 'INTEGER',
  },
};

/**
 * The `pr_review_routes` table: how the harness decided to read each pull
 * request, one row per pull request.
 *
 * **Not a column on `pr_reviews`**, and the separation is the point. The merge
 * gate is satisfied by a `pr_reviews` row existing, so a row written early to
 * carry a route — before anything had read the diff — would report the pull
 * request as reviewed by the step that only decided how to review it. Two
 * tables, two questions: this one says *how*, that one says *what was found*.
 *
 * Upserted for `PrReviewStore`'s reason: the row is the answer to "how is this
 * one being read", and two answers to that is the state the primary key exists
 * to make impossible.
 *
 * The table is new, so it needs no `ColumnMigrations` entry — but a table being
 * new *once* does not keep it exempt, and a column added to it later will.
 */
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

  /** Every route, newest first — one read per pulse, as `listPrReviews` is. */
  listPrReviewRoutes(): PrReviewRoute[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM pr_review_routes ORDER BY decided_at DESC`).all() as Row[];
    return rows.map((row) => ({
      prNumber: row.pr_number,
      mode: row.mode,
      // Null is every row from before the column, and those pull requests were
      // reviewed — so the absence reads as the answer it was, not as unknown.
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
