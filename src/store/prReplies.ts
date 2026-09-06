import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export class PrReplyStore {
  constructor(private readonly ctx: StoreContext) {}

  recordPrReplySent(prNumber: number, threadId: string, commentRef: string): void {
    this.ctx.db
      .prepare(`INSERT OR IGNORE INTO pr_replies_sent (pr_number, thread_id, comment_ref, sent_at) VALUES (?,?,?,?)`)
      .run(prNumber, threadId, commentRef, this.ctx.now());
  }

  prReplyRefs(prNumber: number): ReadonlySet<string> {
    const rows = this.ctx.db.prepare(`SELECT comment_ref FROM pr_replies_sent WHERE pr_number=?`).all(prNumber) as {
      comment_ref: string;
    }[];
    return new Set(rows.map((r) => r.comment_ref));
  }
}
