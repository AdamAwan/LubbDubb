import type { StoreContext } from './context.js';

// → docs/spec/40-discussions.md#pulling-tracker-comments-in

export class IssueCommentStore {
  constructor(private readonly ctx: StoreContext) {}

  recordIssueCommentSent(issueNumber: number, commentRef: string): void {
    this.ctx
      .prep(`INSERT OR IGNORE INTO issue_comments_sent (issue_number, comment_ref, sent_at) VALUES (?,?,?)`)
      .run(issueNumber, commentRef, this.ctx.now());
  }

  issueCommentRefs(issueNumber: number): ReadonlySet<string> {
    const rows = this.ctx.prep(`SELECT comment_ref FROM issue_comments_sent WHERE issue_number=?`).all(issueNumber) as {
      comment_ref: string;
    }[];
    return new Set(rows.map((r) => r.comment_ref));
  }
}
