import type {
  ReviewAttention,
  ReviewMark,
  ReviewPack,
  ReviewPackRecord,
  ReviewPackShare,
  ReviewRange,
} from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export const REVIEW_PACK_SCHEMA = 1;

export const REVIEW_PACK_COLUMNS: ColumnMigrations = {
  review_packs: {},
  review_marks: { seen: 'INTEGER NOT NULL DEFAULT 0' },
  review_pack_shares: { withdrawn_at: 'TEXT' },
};

export interface ReviewPackHead {
  prNumber: number;
  headSha: string;
  writtenAt: string;
}

export class ReviewPackStore {
  constructor(private readonly ctx: StoreContext) {}

  recordReviewPack(pack: ReviewPack): ReviewPackRecord {
    if (pack.schema !== REVIEW_PACK_SCHEMA) {
      throw new Error(`review pack schema ${pack.schema} is not the ${REVIEW_PACK_SCHEMA} this build writes`);
    }
    const writtenAt = this.ctx.now();
    this.ctx.db
      .prepare(
        `INSERT INTO review_packs (pr_number, head_sha, document, written_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(pr_number, head_sha) DO UPDATE SET
           document = excluded.document,
           written_at = excluded.written_at`,
      )
      .run(pack.prNumber, pack.headSha, JSON.stringify(pack), writtenAt);
    return { pack, writtenAt };
  }

  getCurrentReviewPack(prNumber: number): ReviewPackRecord | null {
    return this.listReviewPacks(prNumber)[0] ?? null;
  }

  listReviewPacks(prNumber: number): ReviewPackRecord[] {
    const rows = this.ctx.db
      .prepare(`SELECT document, written_at FROM review_packs WHERE pr_number=? ORDER BY written_at DESC, rowid DESC`)
      .all(prNumber) as PackRow[];
    return rows.map((r) => ({ pack: JSON.parse(r.document) as ReviewPack, writtenAt: r.written_at }));
  }

  listReviewPackHeads(): ReviewPackHead[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT pr_number, head_sha, written_at FROM review_packs
         ORDER BY pr_number ASC, written_at DESC, rowid DESC`,
      )
      .all() as HeadRow[];
    const heads = new Map<number, ReviewPackHead>();
    for (const row of rows) {
      if (heads.has(row.pr_number)) continue;
      heads.set(row.pr_number, { prNumber: row.pr_number, headSha: row.head_sha, writtenAt: row.written_at });
    }
    return [...heads.values()];
  }

  listCurrentReviewPacks(): ReviewPackRecord[] {
    const numbers = this.ctx.db.prepare(`SELECT DISTINCT pr_number FROM review_packs`).all() as { pr_number: number }[];
    return numbers
      .map((r) => this.getCurrentReviewPack(r.pr_number))
      .filter((record): record is ReviewPackRecord => record !== null);
  }

  getReviewPackAt(prNumber: number, headSha: string): ReviewPackRecord | null {
    const row = this.ctx.db
      .prepare(`SELECT document, written_at FROM review_packs WHERE pr_number=? AND head_sha=?`)
      .get(prNumber, headSha) as PackRow | undefined;
    return row ? { pack: JSON.parse(row.document) as ReviewPack, writtenAt: row.written_at } : null;
  }

  recordReviewPackShare(input: { prNumber: number; headSha: string; refusal?: string | null }): ReviewPackShare {
    const requestedAt = this.ctx.now();
    this.ctx.db
      .prepare(
        `INSERT INTO review_pack_shares (pr_number, head_sha, requested_at, published_at, refusal)
         VALUES (?, ?, ?, NULL, ?)
         ON CONFLICT(pr_number) DO UPDATE SET
           head_sha = excluded.head_sha,
           requested_at = excluded.requested_at,
           published_at = NULL,
           refusal = excluded.refusal`,
      )
      .run(input.prNumber, input.headSha, requestedAt, input.refusal ?? null);
    return this.getReviewPackShare(input.prNumber)!;
  }

  withdrawReviewPackShare(prNumber: number): ReviewPackShare | null {
    const share = this.getReviewPackShare(prNumber);
    if (share === null) return null;
    if (share.publishedAt === null) {
      this.deleteReviewPackShare(prNumber);
      return null;
    }
    this.ctx.db.prepare(`UPDATE review_pack_shares SET withdrawn_at=? WHERE pr_number=?`).run(this.ctx.now(), prNumber);
    return this.getReviewPackShare(prNumber);
  }

  recordReviewPackShared(prNumber: number): void {
    this.ctx.db
      .prepare(`UPDATE review_pack_shares SET published_at=?, refusal=NULL WHERE pr_number=?`)
      .run(this.ctx.now(), prNumber);
  }

  recordReviewPackShareRefusal(prNumber: number, refusal: string): void {
    this.ctx.db
      .prepare(`UPDATE review_pack_shares SET refusal=?, published_at=NULL WHERE pr_number=?`)
      .run(refusal, prNumber);
  }

  getReviewPackShare(prNumber: number): ReviewPackShare | null {
    const row = this.ctx.db.prepare(`SELECT * FROM review_pack_shares WHERE pr_number=?`).get(prNumber) as
      | ShareRow
      | undefined;
    return row ? rowToShare(row) : null;
  }

  listReviewPackShares(): ReviewPackShare[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM review_pack_shares ORDER BY pr_number ASC`).all() as ShareRow[];
    return rows.map(rowToShare);
  }

  deleteReviewPackShare(prNumber: number): void {
    this.ctx.db.prepare(`DELETE FROM review_pack_shares WHERE pr_number=?`).run(prNumber);
  }

  markReviewIdeaRead(input: { prNumber: number; headSha: string; hunks: ReviewRange[]; read: boolean }): ReviewMark[] {
    return this.upsertMarks(input.prNumber, input.headSha, input.hunks, { read: input.read ? 1 : 0 });
  }

  overrideReviewAttention(input: {
    prNumber: number;
    headSha: string;
    hunks: ReviewRange[];
    attention: ReviewAttention | null;
  }): ReviewMark[] {
    return this.upsertMarks(input.prNumber, input.headSha, input.hunks, { attention: input.attention });
  }

  markReviewFindingSeen(input: {
    prNumber: number;
    headSha: string;
    hunks: ReviewRange[];
    seen: boolean;
  }): ReviewMark[] {
    return this.upsertMarks(input.prNumber, input.headSha, input.hunks, { seen: input.seen ? 1 : 0 });
  }

  listAllReviewMarks(): ReviewMark[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM review_marks ORDER BY pr_number ASC, path ASC, start_line ASC, end_line ASC`)
      .all() as MarkRow[];
    return rows.map(rowToMark);
  }

  listReviewMarks(prNumber: number): ReviewMark[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM review_marks WHERE pr_number=? ORDER BY path ASC, start_line ASC, end_line ASC`)
      .all(prNumber) as MarkRow[];
    return rows.map(rowToMark);
  }

  private upsertMarks(
    prNumber: number,
    headSha: string,
    hunks: ReviewRange[],
    patch: { read: number } | { attention: ReviewAttention | null } | { seen: number },
  ): ReviewMark[] {
    const markedAt = this.ctx.now();
    const column = 'read' in patch ? 'read' : 'seen' in patch ? 'seen' : 'attention';
    const write = this.ctx.db.prepare(
      `INSERT INTO review_marks (pr_number, path, start_line, end_line, head_sha, attention, read, seen, marked_at)
       VALUES (@prNumber, @path, @start, @end, @headSha, @attention, @read, @seen, @markedAt)
       ON CONFLICT(pr_number, path, start_line, end_line) DO UPDATE SET
         head_sha = excluded.head_sha,
         marked_at = excluded.marked_at,
         ${column} = excluded.${column}`,
    );
    const read = this.ctx.db.prepare(
      `SELECT * FROM review_marks WHERE pr_number=? AND path=? AND start_line=? AND end_line=?`,
    );
    return this.ctx.db.transaction(() =>
      hunks.map((hunk) => {
        write.run({
          prNumber,
          path: hunk.path,
          start: hunk.start,
          end: hunk.end,
          headSha,
          attention: 'attention' in patch ? patch.attention : null,
          read: 'read' in patch ? patch.read : 0,
          seen: 'seen' in patch ? patch.seen : 0,
          markedAt,
        });
        return rowToMark(read.get(prNumber, hunk.path, hunk.start, hunk.end) as MarkRow);
      }),
    )();
  }
}

interface PackRow {
  document: string;
  written_at: string;
}
interface HeadRow {
  pr_number: number;
  head_sha: string;
  written_at: string;
}
interface ShareRow {
  pr_number: number;
  head_sha: string;
  requested_at: string;
  published_at: string | null;
  withdrawn_at: string | null;
  refusal: string | null;
}
function rowToShare(r: ShareRow): ReviewPackShare {
  return {
    prNumber: r.pr_number,
    headSha: r.head_sha,
    requestedAt: r.requested_at,
    publishedAt: r.published_at,
    withdrawnAt: r.withdrawn_at ?? null,
    refusal: r.refusal,
  };
}
interface MarkRow {
  pr_number: number;
  path: string;
  start_line: number;
  end_line: number;
  head_sha: string;
  attention: string | null;
  read: number;
  seen: number;
  marked_at: string;
}

export const REVIEW_ATTENTIONS: readonly ReviewAttention[] = ['read', 'decide', 'skim', 'split'];

function rowToMark(r: MarkRow): ReviewMark {
  return {
    prNumber: r.pr_number,
    hunk: { path: r.path, start: r.start_line, end: r.end_line },
    headSha: r.head_sha,
    attention: REVIEW_ATTENTIONS.find((a) => a === r.attention) ?? null,
    read: r.read === 1,
    seen: r.seen === 1,
    markedAt: r.marked_at,
  };
}
