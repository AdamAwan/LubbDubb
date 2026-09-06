import type { PrReview, PrReviewInput } from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export const PR_REVIEW_COLUMNS: ColumnMigrations = {
  pr_reviews: {
    published_thread: 'TEXT',
  },
};

export class PrReviewStore {
  constructor(private readonly ctx: StoreContext) {}

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

  recordPrReviewPublished(prNumber: number, threadId: string): void {
    this.ctx.db.prepare(`UPDATE pr_reviews SET published_thread=? WHERE pr_number=?`).run(threadId, prNumber);
  }

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
    verdict: row.verdict === 'findings' ? 'findings' : 'clear',
    summary: row.summary,
    findings: parseFindings(row.findings),
    agentId: row.agent_id,
    reviewedAt: row.reviewed_at,
    publishedThread: row.published_thread ?? null,
  };
}

function parseFindings(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}
