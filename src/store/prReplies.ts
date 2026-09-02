import type { StoreContext } from './context.js';

/**
 * The `pr_replies_sent` table: one row per review-thread reply **this harness
 * actually sent**, keyed by the provider's own id for the comment it created.
 *
 * Attribution used to be an inference — a reply whose author equalled
 * `config.userId` was the fleet's — and on a single-operator deployment that
 * identity *is* the operator. Their own follow-up on their own review thread came
 * back reading as the harness's answer: the cockpit drew a "fleet" badge on a
 * message a person wrote, the thread flipped to `answered`, `PrComment.handled`
 * folded to true, and rule `pr-review-comment` never saw the one signal it must
 * never drop. Nothing went red, because nothing was wrong as far as any type
 * could tell. This table replaces that inference with a record.
 *
 * **Identity is never sufficient.** A reply is the fleet's when a row here names
 * it, and a thread is `answered` when its *last* reply is one of those. Both
 * providers read the same rows, through the same derivation in `src/prThreads.ts`
 * — the point being that they cannot come to disagree about a thread.
 * → `docs/spec/07-pull-requests.md#review-threads`
 *
 * **Three cases fail toward "unanswered", deliberately.** A thread wrongly left
 * open costs one dispatch, which is visible and cheap; a thread wrongly marked
 * answered loses the reviewer's comment entirely, which is silent and permanent.
 * So:
 *
 * 1. **The provider handed back no usable comment ref.** No row is written, the
 *    thread keeps reading as work, and `ActionExecutor` records the miss through
 *    `errors.record` — the failure is loud rather than a silent slide back to
 *    identity. It re-dispatches until a send does return a ref, which is the
 *    correct pressure: a provider that can never name what it created cannot
 *    support attribution at all, and the operator should be told so.
 * 2. **A reply sent before this table existed.** No row, so the thread reads open
 *    once more and the fleet answers it again. There is deliberately **no
 *    backfill**: the only evidence on such a thread is the author, and telling the
 *    operator's reply from the harness's by author is exactly the bug — a backfill
 *    would write the wrong answer into a table whose whole value is being right.
 *    The cost is bounded and one-off: the next reply *is* recorded and the thread
 *    settles.
 * 3. **A row naming a comment the current reading does not carry** (the reviewer
 *    deleted the reply, the thread was recreated). It simply matches nothing.
 *    Rows are never pruned on that basis — a read the provider served from a
 *    stale cache would otherwise throw away the record permanently.
 *
 * The table is new, so it needs no `ColumnMigrations` entry — but a table being
 * new *once* does not keep it exempt, and a column added to it later will.
 */
export class PrReplyStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Record that the harness sent `commentRef` as a reply into `threadId`.
   *
   * Idempotent on `(pr_number, comment_ref)` and never re-stamped: a provider id
   * names one comment for good, so a second write is a retry rather than a second
   * reply, and the time on the row is when the fleet answered.
   */
  recordPrReplySent(prNumber: number, threadId: string, commentRef: string): void {
    this.ctx.db
      .prepare(`INSERT OR IGNORE INTO pr_replies_sent (pr_number, thread_id, comment_ref, sent_at) VALUES (?,?,?,?)`)
      .run(prNumber, threadId, commentRef, this.ctx.now());
  }

  /**
   * Every comment ref the harness recorded sending on one pull request.
   *
   * Per pull request rather than whole-table because that is how a provider reads
   * it — one lookup per hydrated PR, against the replies that PR carries — and a
   * global set would have refs from other pull requests in it, which for a
   * provider whose comment ids are only unique per thread is a false match
   * waiting to happen.
   */
  prReplyRefs(prNumber: number): ReadonlySet<string> {
    const rows = this.ctx.db.prepare(`SELECT comment_ref FROM pr_replies_sent WHERE pr_number=?`).all(prNumber) as {
      comment_ref: string;
    }[];
    return new Set(rows.map((r) => r.comment_ref));
  }
}
