import type { SentPrReplies } from '../pr/prThreads.js';
import type { PrReplySent } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export class PrReplyStore implements SentPrReplies {
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

  listPrRepliesSentSince(since: string): PrReplySent[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM pr_replies_sent WHERE sent_at > ? ORDER BY sent_at ASC`)
      .all(since) as PrReplyRow[];
    return rows.map((row) => ({
      prNumber: row.pr_number,
      threadId: row.thread_id,
      commentRef: row.comment_ref,
      sentAt: row.sent_at,
    }));
  }
}

interface PrReplyRow {
  pr_number: number;
  thread_id: string;
  comment_ref: string;
  sent_at: string;
}
