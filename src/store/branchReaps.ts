import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export class BranchReapStore {
  constructor(private readonly ctx: StoreContext) {}

  recordBranchReap(prNumber: number, branch: string): void {
    this.ctx.db
      .prepare(`INSERT OR REPLACE INTO branch_reaps (pr_number, branch, at) VALUES (?, ?, ?)`)
      .run(prNumber, branch, this.ctx.now());
  }

  reapedPrs(): ReadonlySet<number> {
    const rows = this.ctx.db.prepare(`SELECT pr_number FROM branch_reaps`).all() as { pr_number: number }[];
    return new Set(rows.map((r) => r.pr_number));
  }
}
