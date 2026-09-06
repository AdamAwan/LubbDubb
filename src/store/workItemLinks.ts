import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export class WorkItemLinkStore {
  constructor(private readonly ctx: StoreContext) {}

  recordWorkItemLink(prNumber: number, workItem: number): void {
    this.ctx.db
      .prepare(`INSERT OR REPLACE INTO pr_work_item_links (pr_number, work_item, at) VALUES (?, ?, ?)`)
      .run(prNumber, workItem, this.ctx.now());
  }

  linkedWorkItemPrs(): ReadonlySet<number> {
    const rows = this.ctx.db.prepare(`SELECT pr_number FROM pr_work_item_links`).all() as { pr_number: number }[];
    return new Set(rows.map((r) => r.pr_number));
  }
}
