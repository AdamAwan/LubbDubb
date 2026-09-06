import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export class PrReviewExternalStore {
  constructor(private readonly ctx: StoreContext) {}

  recordPrReviewedElsewhere(prNumber: number, detail: string): void {
    this.ctx.db
      .prepare(`INSERT OR IGNORE INTO pr_review_externals (pr_number, detail, at) VALUES (?, ?, ?)`)
      .run(prNumber, detail, this.ctx.now());
  }

  prsReviewedElsewhere(): ReadonlySet<number> {
    const rows = this.ctx.db.prepare(`SELECT pr_number FROM pr_review_externals`).all() as { pr_number: number }[];
    return new Set(rows.map((r) => r.pr_number));
  }
}
