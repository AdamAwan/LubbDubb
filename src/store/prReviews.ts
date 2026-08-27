import type { PrReview, PrReviewInput } from '../types.js';
import type { StoreContext } from './context.js';

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
           reviewed_at = excluded.reviewed_at`,
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
    return { ...input, reviewedAt };
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
