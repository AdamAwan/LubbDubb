import type { PrThreadReopen } from '../prThreads.js';
import type { StoreContext } from './context.js';

/**
 * The `pr_thread_reopens` table: review threads the operator has put back in
 * front of the fleet.
 *
 * A mark of its own rather than a write to the provider, and that is the design.
 * Unresolving a thread on GitHub is a statement to the *reviewer* — it reopens
 * their question in their inbox — where this is a statement to the *fleet*: come
 * back to this. The two are not the same act, and the provider cannot express the
 * second at all for the common case, a thread nobody resolved that the harness
 * merely replied to last.
 *
 * **A row is the whole state**, and it is cleared by the harness's next reply into
 * that thread (`ActionExecutor`), never by a timer. That is what keeps the loop
 * finite: reopen puts the thread back to `open`, the rule dispatches, the agent
 * replies, the mark goes, and the thread reads `answered` again. A mark that
 * outlived the reply would dispatch for the same thread every pulse, forever.
 *
 * The table is new, so it needs no `ColumnMigrations` entry — but a table being
 * new *once* does not keep it exempt, and a column added to it later will.
 * → `docs/spec/07-pull-requests.md#reopening-a-thread`
 */
export class PrThreadReopenStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Put a thread back in front of the fleet, or take the ask back.
   *
   * Idempotent in both directions, and asking twice does **not** re-stamp: the
   * time on the row is when the operator asked, which is what the cockpit draws
   * beside the thread, and a second click on a mark that is already there is not
   * a second ask.
   */
  setPrThreadReopened(prNumber: number, threadId: string, reopened: boolean): void {
    if (!reopened) {
      this.ctx.db.prepare(`DELETE FROM pr_thread_reopens WHERE pr_number=? AND thread_id=?`).run(prNumber, threadId);
      return;
    }
    this.ctx.db
      .prepare(`INSERT OR IGNORE INTO pr_thread_reopens (pr_number, thread_id, reopened_at) VALUES (?,?,?)`)
      .run(prNumber, threadId, this.ctx.now());
  }

  /** Every standing reopen — one read per pulse, as every other per-world lookup here is. */
  prThreadReopens(): PrThreadReopen[] {
    const rows = this.ctx.db
      .prepare(`SELECT pr_number, thread_id, reopened_at FROM pr_thread_reopens ORDER BY reopened_at`)
      .all() as { pr_number: number; thread_id: string; reopened_at: string }[];
    return rows.map((r) => ({ prNumber: r.pr_number, threadId: r.thread_id, reopenedAt: r.reopened_at }));
  }
}
