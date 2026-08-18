import type { StoreContext } from './context.js';

/**
 * The `pr_watch_seeds` table: pull requests the harness has already tagged with the
 * watch label because it opened them.
 *
 * Stored rather than derived, for `branch_reaps`' reason — **the world does not
 * answer the question**. "Has the harness tagged this once" appears in no provider
 * payload, and the live labels cannot stand in for it: an operator who removes the
 * tag to take a pull request off the fleet leaves a world that looks exactly like
 * one the harness has never got to. Without the row the seeder would put the tag
 * straight back on the next pulse, and the un-watch button would silently undo
 * itself.
 *
 * **Keyed on the pull request, not the branch**, exactly as the reap is: `issue/12`
 * can be re-cut by a later dispatch and open a second pull request, and that second
 * one is owed its own tag.
 *
 * One row per seed, written only after the label write succeeded — a failed write
 * leaves no row, so the next pulse retries. The table is new, so it needs no
 * `ColumnMigrations` entry; a table being new *once* does not keep it exempt, and a
 * column added to it later will.
 */
export class PrWatchSeedStore {
  constructor(private readonly ctx: StoreContext) {}

  recordPrWatchSeed(prNumber: number, branch: string): void {
    this.ctx.db
      .prepare(`INSERT OR REPLACE INTO pr_watch_seeds (pr_number, branch, at) VALUES (?, ?, ?)`)
      .run(prNumber, branch, this.ctx.now());
  }

  /**
   * The pull requests already seeded. Unbounded in age on purpose, and cheap for it:
   * one short row per pull request the harness has ever opened. A window that forgot
   * a seed would re-tag a pull request the operator had taken off the fleet.
   */
  seededPrs(): ReadonlySet<number> {
    const rows = this.ctx.db.prepare(`SELECT pr_number FROM pr_watch_seeds`).all() as { pr_number: number }[];
    return new Set(rows.map((r) => r.pr_number));
  }
}
