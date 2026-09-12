import type { PrThreadReopen } from '../pr/prThreads.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export class PrThreadReopenStore {
  constructor(private readonly ctx: StoreContext) {}

  setPrThreadReopened(prNumber: number, threadId: string, reopened: boolean): void {
    if (!reopened) {
      this.ctx.db.prepare(`DELETE FROM pr_thread_reopens WHERE pr_number=? AND thread_id=?`).run(prNumber, threadId);
      return;
    }
    this.ctx.db
      .prepare(`INSERT OR IGNORE INTO pr_thread_reopens (pr_number, thread_id, reopened_at) VALUES (?,?,?)`)
      .run(prNumber, threadId, this.ctx.now());
  }

  prThreadReopens(): PrThreadReopen[] {
    const rows = this.ctx.db
      .prepare(`SELECT pr_number, thread_id, reopened_at FROM pr_thread_reopens ORDER BY reopened_at`)
      .all() as { pr_number: number; thread_id: string; reopened_at: string }[];
    return rows.map((r) => ({ prNumber: r.pr_number, threadId: r.thread_id, reopenedAt: r.reopened_at }));
  }
}
