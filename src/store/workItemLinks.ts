import type { StoreContext } from './context.js';

/**
 * The `pr_work_item_links` table: pull requests the harness has already linked to
 * the work item it opened them for.
 *
 * Stored rather than derived, for `pr_watch_seeds`' reason and one of its own.
 *
 * **The operator's reason.** Deleting a link is how somebody says the harness got
 * the work item wrong. A desk that re-derived its answer from the world alone would
 * put the link straight back on the next pulse — a correction that silently undoes
 * itself, which is the failure mode `pr_watch_seeds` exists to prevent for the watch
 * tag.
 *
 * **The provider's reason.** `linkedPrNumber` folds a work item's relations down to
 * *one* number, the last pull request to cross-reference it. A plan whose three
 * parts each open one leaves two of them reading as unlinked forever, so the world
 * cannot say "this pull request is linked" even when it is.
 *
 * **Keyed on the pull request, not the work item**, exactly as `pr_watch_seeds` is:
 * one work item legitimately carries several pull requests, and each is owed its
 * own link.
 *
 * One row per link, written only after the link write succeeded — a failed write
 * leaves no row, so the next pulse retries. The table is new, so it needs no
 * `ColumnMigrations` entry; a table being new *once* does not keep it exempt, and a
 * column added to it later will.
 */
export class WorkItemLinkStore {
  constructor(private readonly ctx: StoreContext) {}

  recordWorkItemLink(prNumber: number, workItem: number): void {
    this.ctx.db
      .prepare(`INSERT OR REPLACE INTO pr_work_item_links (pr_number, work_item, at) VALUES (?, ?, ?)`)
      .run(prNumber, workItem, this.ctx.now());
  }

  /**
   * The pull requests already linked. Unbounded in age on purpose, and cheap for it:
   * one short row per pull request the harness has ever opened. A window that forgot
   * a link would re-send one an operator had deliberately removed.
   */
  linkedWorkItemPrs(): ReadonlySet<number> {
    const rows = this.ctx.db.prepare(`SELECT pr_number FROM pr_work_item_links`).all() as { pr_number: number }[];
    return new Set(rows.map((r) => r.pr_number));
  }
}
