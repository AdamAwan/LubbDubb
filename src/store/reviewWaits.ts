import type { StoreContext } from './context.js';

/**
 * The `pr_review_waits` table: for each pull request currently waiting on a
 * reviewer, the instant it started waiting.
 *
 * **Stored rather than derived, because the question is about a span and every
 * other reading here is about an instant.** No provider payload carries
 * "reviewable since": GitHub's `updated_at` moves for a label change, Azure does
 * not report one on the list at all, and a pull request's creation date is not
 * the answer either — one that spent two days red was not waiting on anybody for
 * those two days. The moment a pull request *became* reviewable is only ever
 * observable as it happens, so observing it is what this records.
 *
 * **A watermark, not a log.** One row, upserted only when absent, deleted the
 * moment the pull request stops waiting — approved, gone red, a comment landed,
 * merged. So the table holds exactly what is outstanding now, and a pull request
 * that goes back and forth starts its clock again each time, which is the honest
 * reading: work happened in between, and the reviewer's wait began after it.
 *
 * Keyed on the pull request number for `branch_reaps`' reason inverted — the
 * branch is reusable, and here there is nothing to keep after the wait ends
 * anyway.
 *
 * The table is new, so it needs no `ColumnMigrations` entry — but a table being
 * new *once* does not keep it exempt, and a column added to it later will.
 */
export class ReviewWaitStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Fold the current set of waiting pull requests onto the table: start a clock
   * for any that is newly waiting, and clear every row not in the set.
   *
   * Idempotent, and the whole write — `INSERT OR IGNORE` is what makes it a
   * watermark rather than a running reset. A plain upsert here would set `since`
   * to now on every pulse, which reads as "waiting five minutes" forever and is
   * exactly the silent wrong answer this table exists to give correctly.
   */
  foldReviewWaits(waiting: readonly number[]): void {
    const at = this.ctx.now();
    const keep = new Set(waiting);
    const insert = this.ctx.db.prepare(`INSERT OR IGNORE INTO pr_review_waits (pr_number, since) VALUES (?, ?)`);
    const existing = this.ctx.db.prepare(`SELECT pr_number FROM pr_review_waits`).all() as { pr_number: number }[];
    const drop = this.ctx.db.prepare(`DELETE FROM pr_review_waits WHERE pr_number = ?`);
    const apply = this.ctx.db.transaction(() => {
      for (const number of keep) insert.run(number, at);
      for (const row of existing) if (!keep.has(row.pr_number)) drop.run(row.pr_number);
    });
    apply();
  }

  /** PR number → the instant it started waiting on a reviewer. */
  reviewWaits(): ReadonlyMap<number, string> {
    const rows = this.ctx.db.prepare(`SELECT pr_number, since FROM pr_review_waits`).all() as {
      pr_number: number;
      since: string;
    }[];
    return new Map(rows.map((r) => [r.pr_number, r.since]));
  }
}
