import type { StoreContext } from './context.js';

/**
 * The `branch_reaps` table: pull requests whose merged branch has already been
 * cleaned up, locally and on the remote.
 *
 * Stored rather than derived, unlike almost everything else about a pull request,
 * because **the world does not answer the question**. "Has this been reaped" appears
 * in no provider payload, and a merged PR stays in `closedPullRequests` for
 * `closedPrWindowMs` — so without the record the desk would re-issue a delete for an
 * already-gone branch on every pulse for six hours.
 *
 * **Keyed on the pull request, not the branch**, though the branch is recorded too.
 * A branch name is reusable: `issue/12` can land, be re-cut by a later dispatch and
 * land again, and that second landing is a second branch owed its own reap. Keyed on
 * the name, the row from the first would suppress it — silently, and forever, since
 * the table is unbounded in age.
 *
 * One row per reap, written only after both halves succeeded. The table is new, so
 * it needs no `ColumnMigrations` entry — but a table being new *once* does not keep
 * it exempt, and a column added to it later will.
 */
export class BranchReapStore {
  constructor(private readonly ctx: StoreContext) {}

  recordBranchReap(prNumber: number, branch: string): void {
    this.ctx.db
      .prepare(`INSERT OR REPLACE INTO branch_reaps (pr_number, branch, at) VALUES (?, ?, ?)`)
      .run(prNumber, branch, this.ctx.now());
  }

  /**
   * The pull requests already reaped. Unbounded in age on purpose, and cheap for it:
   * one short row per landed pull request. A window that forgot a reap would put the
   * delete back every time the PR re-entered the closed window.
   */
  reapedPrs(): ReadonlySet<number> {
    const rows = this.ctx.db.prepare(`SELECT pr_number FROM branch_reaps`).all() as { pr_number: number }[];
    return new Set(rows.map((r) => r.pr_number));
  }
}
