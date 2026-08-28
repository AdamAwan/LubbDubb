import type { StoreContext } from './context.js';

/**
 * The `pr_review_externals` table: pull requests a check **outside** the harness
 * reported already reviewed.
 *
 * Its own table rather than a `pr_reviews` row, and that is not tidiness. The
 * merge gate is satisfied by a `pr_reviews` row existing, and that row means *the
 * fleet read this and here is what it found* — a verdict, a summary, findings, the
 * agent behind it. An external gate has none of those: it says a read happened
 * somewhere, and writing it as a fleet review would put a review in the cockpit,
 * in the Decision log and in the next agent's prompt that nothing in this harness
 * ever performed. `PrReviewStore` states the same boundary from the other side:
 * `pr_reviews` is written by the `review_report` tool and by nothing else.
 *
 * **Only the `reviewed` verdict is recorded.** `not-reviewed` and `unknown` are
 * asked again next pulse, because a gate that has not passed yet may pass later
 * and a command that broke may be fixed — a row for either would freeze the
 * absence of an answer into an answer.
 *
 * Keyed on the pull request, as every table in this group is, and for their
 * reason: a branch re-cut by a later dispatch opens a second pull request, and
 * that one is asked about on its own.
 *
 * The table is new, so it needs no `ColumnMigrations` entry — but a table being
 * new *once* does not keep it exempt, and a column added to it later will.
 */
export class PrReviewExternalStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Record that something outside the harness has reviewed this pull request.
   * `INSERT OR IGNORE`: the first `reviewed` is the answer, and re-stamping would
   * only move a timestamp nothing reads a decision from.
   */
  recordPrReviewedElsewhere(prNumber: number, detail: string): void {
    this.ctx.db
      .prepare(`INSERT OR IGNORE INTO pr_review_externals (pr_number, detail, at) VALUES (?, ?, ?)`)
      .run(prNumber, detail, this.ctx.now());
  }

  /**
   * Every pull request an external check has stood down — one read per pulse, as
   * every other per-world lookup here is.
   */
  prsReviewedElsewhere(): ReadonlySet<number> {
    const rows = this.ctx.db.prepare(`SELECT pr_number FROM pr_review_externals`).all() as { pr_number: number }[];
    return new Set(rows.map((r) => r.pr_number));
  }
}
