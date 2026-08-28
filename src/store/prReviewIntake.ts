import type { StoreContext } from './context.js';

/**
 * The `pr_review_intake` table: which open pull requests the fleet review has
 * judged to be its own, and which were simply already open when a project
 * switched it on.
 *
 * Stored rather than derived, for `pr_watch_seeds`' reason — **the world does not
 * answer the question**. "Was this pull request already there when the review
 * started asking" is in no provider payload, and the live rows cannot stand in
 * for it: a pull request nothing has reviewed yet and one nothing will ever
 * review are the same absence in `pr_reviews`. Without the stamp the guard would
 * re-derive its answer from a ledger that fills up as it goes and hand the whole
 * backlog through one pulse later.
 *
 * **One row per pull request, written whether or not it is eligible** — the
 * environments arrival stamp exactly: a pass that recorded only the eligible
 * would leave the backlog unstamped and therefore re-judged for ever.
 * → `docs/spec/24-environments.md#announcing-an-arrival`
 *
 * **Keyed on the pull request, not the branch**, exactly as `pr_reviews` and the
 * watch seeds are: `issue/12` can be re-cut by a later dispatch and open a second
 * pull request, and that second one is the harness's to judge on its own.
 *
 * The table is new, so it needs no `ColumnMigrations` entry — but a table being
 * new *once* does not keep it exempt, and a column added to it later will.
 */
export class PrReviewIntakeStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Stamp one pull request. `INSERT OR IGNORE`, not a replace: the verdict is
   * taken once, on the pulse the review first saw the pull request, and a second
   * pass must not re-judge it against a clock that has moved past its opening.
   * That first-write-wins is the whole of why a pull request held back by
   * unhandled threads or a saturated cap is still reviewed when it comes free.
   */
  recordPrReviewIntake(prNumber: number, watchedOpen: boolean): void {
    this.ctx.db
      .prepare(`INSERT OR IGNORE INTO pr_review_intake (pr_number, watched_open, at) VALUES (?, ?, ?)`)
      .run(prNumber, watchedOpen ? 1 : 0, this.ctx.now());
  }

  /**
   * The whole ledger — one read per pulse rather than one per pull request, for
   * the reason every other per-world lookup here is a list: the dispatcher, the
   * lens and the stamping pass each need the entire set.
   *
   * Unbounded in age on purpose, and cheap for it: one short row per pull request
   * the review has ever seen. A window that forgot a stamp would hand a team's
   * backlog to the fleet the pulse it expired.
   */
  prReviewIntake(): ReadonlyMap<number, boolean> {
    const rows = this.ctx.db.prepare(`SELECT pr_number, watched_open FROM pr_review_intake`).all() as Row[];
    return new Map(rows.map((r) => [r.pr_number, r.watched_open === 1]));
  }
}

interface Row {
  pr_number: number;
  watched_open: number;
}
