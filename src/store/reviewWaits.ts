import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export class ReviewWaitStore {
  constructor(private readonly ctx: StoreContext) {}

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

  reviewWaits(): ReadonlyMap<number, string> {
    const rows = this.ctx.db.prepare(`SELECT pr_number, since FROM pr_review_waits`).all() as {
      pr_number: number;
      since: string;
    }[];
    return new Map(rows.map((r) => [r.pr_number, r.since]));
  }
}
