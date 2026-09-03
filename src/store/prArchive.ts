import type { PullRequest } from '../types.js';
import type { StoreContext } from './context.js';

/**
 * The `pr_archive` table: the last reading of every pull request that has left
 * the open set, kept for good.
 *
 * `WorldSnapshot.closedPullRequests` is a **window** — it carries a pull request
 * for `closedPrWindowMs` and then forgets it — and the cockpit's goal page drew
 * its closed rows straight off that list. So a goal's pull requests vanished from
 * its page a few hours after they merged, and the page of a goal delivered last
 * month said no pull request ever named it. The record of what a goal shipped is
 * exactly what somebody opens that page for.
 *
 * **A row is a fact about the past, never a reading of the present.** Nothing
 * re-fetches an archived pull request and nothing acts on one: the harness writes
 * the row as the world last reported it and every later read is that same stale
 * row. That is the point — the alternative to stale data here is no data.
 *
 * Written from the world the pulse just recorded ({@link archiveClosedPrs}) and
 * upserted on the number, so the window's daily re-reporting of the same merge
 * refreshes the row rather than appending to it, and a pull request whose last
 * reading arrived while the harness was down keeps the one before it.
 *
 * The table is new, so it needs no `ColumnMigrations` entry — but a table being
 * new *once* does not keep it exempt, and a column added to it later will.
 */
export class PrArchiveStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Record each pull request as the world last reported it.
   *
   * Whole-row replace rather than a merge of fields: the snapshot *is* the fact
   * being kept, and a merge would build a pull request that no reading ever
   * described. `first_seen_at` survives the replace so the archive can say when the
   * harness first saw the close, which the provider's `closedAt` does not answer on
   * a row it never dated.
   */
  archiveClosedPrs(prs: readonly PullRequest[]): void {
    if (prs.length === 0) return;
    const at = this.ctx.now();
    const stmt = this.ctx.db.prepare(
      `INSERT INTO pr_archive (number, closed_at, first_seen_at, updated_at, snapshot)
       VALUES (@number, @closedAt, @at, @at, @snapshot)
       ON CONFLICT(number) DO UPDATE SET
         closed_at = excluded.closed_at,
         updated_at = excluded.updated_at,
         snapshot = excluded.snapshot`,
    );
    const writeAll = this.ctx.db.transaction((rows: readonly PullRequest[]) => {
      for (const pr of rows) {
        stmt.run({ number: pr.number, closedAt: pr.closedAt ?? null, at, snapshot: JSON.stringify(pr) });
      }
    });
    writeAll(prs);
  }

  /**
   * Every archived pull request, newest close first.
   *
   * The whole table, because the surface it feeds is "what did this goal ship" and
   * a goal's pull requests are as old as the goal. Ordered by when the close was
   * observed rather than by number, so a row the provider never dated still sorts
   * with its neighbours.
   */
  listArchivedPrs(): PullRequest[] {
    const rows = this.ctx.db
      .prepare(`SELECT snapshot FROM pr_archive ORDER BY COALESCE(closed_at, first_seen_at) DESC, number DESC`)
      .all() as { snapshot: string }[];
    return rows.map((row) => JSON.parse(row.snapshot) as PullRequest);
  }
}
