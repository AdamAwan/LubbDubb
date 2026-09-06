import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export class PrWatchSeedStore {
  constructor(private readonly ctx: StoreContext) {}

  recordPrWatchSeed(prNumber: number, branch: string): void {
    this.ctx.db
      .prepare(`INSERT OR REPLACE INTO pr_watch_seeds (pr_number, branch, at) VALUES (?, ?, ?)`)
      .run(prNumber, branch, this.ctx.now());
  }

  seededPrs(): ReadonlySet<number> {
    const rows = this.ctx.db.prepare(`SELECT pr_number FROM pr_watch_seeds`).all() as { pr_number: number }[];
    return new Set(rows.map((r) => r.pr_number));
  }
}
