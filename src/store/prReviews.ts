import type { PrReview, PrReviewInput } from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

/**
 * `published_thread` arrived after the table did, so it needs its `ALTER TABLE` —
 * declared here rather than centrally, so "did this column get an entry?" is
 * answerable without leaving the file that reads it.
 *
 * **Nullable, and it needs no backfill.** Null is not a third state waiting to be
 * resolved: it is exactly what every row written before this existed meant —
 * nothing recorded a publication of this review — and the only other evidence is
 * a thread's author, which is the inference `pr_replies_sent` exists to replace.
 * → `docs/spec/14-persistence.md#when-a-null-means-something`
 */
export const PR_REVIEW_COLUMNS: ColumnMigrations = {
  pr_reviews: {
    published_thread: 'TEXT',
  },
};

/**
 * The `pr_reviews` table: the fleet's own review of a pull request, one row per
 * pull request.
 *
 * **Keyed on the pull request, not on the commit** — the decision the whole
 * feature turns on, argued where the predicate lives
 * (`src/review/prReview.ts`, `needsFleetReview`): the review runs once, so a key
 * that moved with the diff would be invalidated by the first fix pushed after it
 * and nothing would ever write the row again. `head_sha` is recorded because what
 * the reviewer read is worth saying, and it gates nothing.
 *
 * Written by the `review_report` tool and by nothing else. In particular it is
 * never inferred from a comment on the provider: a review the harness *published*
 * and a review it *took* are different facts, and reading one off the other would
 * make a reviewer's own words satisfy the gate meant to hold the fleet to
 * account.
 *
 * The table is new, so it needs no `ColumnMigrations` entry — but a table being
 * new *once* does not keep it exempt, and a column added to it later will.
 */
export class PrReviewStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Record the verdict. An upsert, so a review re-run after an operator cleared
   * the row (or after a crash left the origin free) replaces rather than
   * duplicates — the row is the answer to "has this pull request been reviewed",
   * and two answers to that is the state the primary key exists to make
   * impossible.
   */
  recordPrReview(input: PrReviewInput): PrReview {
    const reviewedAt = this.ctx.now();
    this.ctx.db
      .prepare(
        `INSERT INTO pr_reviews (pr_number, head_sha, verdict, summary, findings, agent_id, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(pr_number) DO UPDATE SET
           head_sha = excluded.head_sha,
           verdict = excluded.verdict,
           summary = excluded.summary,
           findings = excluded.findings,
           agent_id = excluded.agent_id,
           reviewed_at = excluded.reviewed_at,
           -- Cleared, because this is a *new* reading: the thread the last one was
           -- published into answers findings this row no longer carries, and a
           -- resolution on it would report the new ones as dealt with.
           published_thread = NULL`,
      )
      .run(
        input.prNumber,
        input.headSha,
        input.verdict,
        input.summary,
        JSON.stringify(input.findings),
        input.agentId,
        reviewedAt,
      );
    return { ...input, reviewedAt, publishedThread: null };
  }

  /**
   * Write down which thread the findings went out in — called from the one place a
   * reply is sent, once the provider has named what it created.
   *
   * An `UPDATE`, never an upsert: the row means "the fleet read this pull request
   * and here is what it found", and a publication is not that. A publish with no
   * review row is a reviewer that commented before it reported, which the prompt
   * orders the other way round; it records nothing and the next `review_report`
   * writes the row without a thread, which reads as unpublished — the safe
   * direction, since the alternative is a `findings` mark claiming somebody dealt
   * with findings nothing has recorded.
   */
  recordPrReviewPublished(prNumber: number, threadId: string): void {
    this.ctx.db.prepare(`UPDATE pr_reviews SET published_thread=? WHERE pr_number=?`).run(threadId, prNumber);
  }

  /**
   * Every recorded review, newest first — one read per pulse rather than one per
   * pull request, for the reason every other per-world lookup here is a list: the
   * dispatcher and the lens both need the whole set, and a query per pull request
   * would put the row count of a busy repository in front of every cycle.
   */
  listPrReviews(): PrReview[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM pr_reviews ORDER BY reviewed_at DESC`).all() as Row[];
    return rows.map(hydrate);
  }
}

interface Row {
  pr_number: number;
  head_sha: string | null;
  verdict: string;
  summary: string;
  findings: string;
  agent_id: string | null;
  reviewed_at: string;
  published_thread: string | null;
}

function hydrate(row: Row): PrReview {
  return {
    prNumber: row.pr_number,
    headSha: row.head_sha,
    // Narrowed on read rather than trusted: the column is text, and a row written
    // by a build that knew a third verdict must not arrive as one this one will
    // switch on.
    verdict: row.verdict === 'findings' ? 'findings' : 'clear',
    summary: row.summary,
    findings: parseFindings(row.findings),
    agentId: row.agent_id,
    reviewedAt: row.reviewed_at,
    // `?? null` rather than trusted: a row read on a database the column was only
    // just added to has it as null, and one from a build that never wrote it has
    // it undefined through the same `SELECT *`.
    publishedThread: row.published_thread ?? null,
  };
}

/** Findings ride as JSON; a row that cannot be parsed reads as none rather than throwing a read. */
function parseFindings(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}
