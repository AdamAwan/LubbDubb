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

/**
 * The shape version every pack this build writes carries. A document stating another number
 * came from a different build and a reader refuses it rather than drawing what it
 * recognises. Bumped only when a renderer must know about the change, never for an added
 * optional field. → `docs/spec/31-review-packs.md#the-document-carries-its-schema-version`
 */
export const REVIEW_PACK_SCHEMA = 1;

/**
 * `review_marks.seen` and `review_pack_shares.withdrawn_at` were added after their tables
 * shipped, so without these entries every older database reads both back as `undefined`.
 * Neither owes a backfill: 0 and null are what the existing rows already mean.
 * → `docs/spec/14-persistence.md#migrations`
 */
export const REVIEW_PACK_COLUMNS: ColumnMigrations = {
  review_packs: {},
  review_marks: { seen: 'INTEGER NOT NULL DEFAULT 0' },
  review_pack_shares: { withdrawn_at: 'TEXT' },
};

/**
 * The `review_packs` and `review_marks` tables: a change restated for a person, and what
 * that person did to it. The pack is one document, stored and read whole; nothing queries
 * inside it. The marks are a separate table because they **outlive the document** — a pack
 * is immutable output for one head sha, so folding marks in would lose them on regeneration.
 * → `docs/spec/31-review-packs.md#where-it-lives`
 */
/** One pull request's current pack, without its document. → {@link ReviewPackStore.listReviewPackHeads} */
export interface ReviewPackHead {
  prNumber: number;
  headSha: string;
  writtenAt: string;
}

export class ReviewPackStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Write a pack. Upserted on `(pr_number, head_sha)`; a pack for a newer head is a new row
   * beside the old one, and the newest written is what {@link getCurrentReviewPack} answers.
   * The pull request and head are read off the document, never taken as arguments. A
   * document stating a schema this build does not write is refused rather than stored.
   */
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

  /**
   * The pull request's current pack — the newest written, whatever head it was
   * written against. Whether it is stale is the caller's to decide, against the
   * pull request's head, which the store does not know.
   */
  getCurrentReviewPack(prNumber: number): ReviewPackRecord | null {
    return this.listReviewPacks(prNumber)[0] ?? null;
  }

  /**
   * Every pack ever written for the pull request, newest first. Ties on `written_at` break
   * on `rowid`, so two packs written inside one millisecond have a defined order.
   */
  listReviewPacks(prNumber: number): ReviewPackRecord[] {
    const rows = this.ctx.db
      .prepare(`SELECT document, written_at FROM review_packs WHERE pr_number=? ORDER BY written_at DESC, rowid DESC`)
      .all(prNumber) as PackRow[];
    return rows.map((r) => ({ pack: JSON.parse(r.document) as ReviewPack, writtenAt: r.written_at }));
  }

  /**
   * Every pull request's current pack as three columns, newest first. Beside
   * {@link listCurrentReviewPacks} rather than instead of it: that one parses every
   * document, which the state snapshot folding this on every pulse must not pay for.
   * → `docs/spec/31-review-packs.md#on-the-row`
   */
  listReviewPackHeads(): ReviewPackHead[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT pr_number, head_sha, written_at FROM review_packs
         ORDER BY pr_number ASC, written_at DESC, rowid DESC`,
      )
      .all() as HeadRow[];
    const heads = new Map<number, ReviewPackHead>();
    // First row per pull request wins, on the same tie-break `listReviewPacks` takes so the
    // two cannot name different packs as current.
    for (const row of rows) {
      if (heads.has(row.pr_number)) continue;
      heads.set(row.pr_number, { prNumber: row.pr_number, headSha: row.head_sha, writtenAt: row.written_at });
    }
    return [...heads.values()];
  }

  /**
   * Each pull request's current pack — the newest written, one per pull request, and what a
   * mark is laid over: a mark is keyed to a hunk, so it lands on whichever idea owns it now.
   */
  listCurrentReviewPacks(): ReviewPackRecord[] {
    const numbers = this.ctx.db.prepare(`SELECT DISTINCT pr_number FROM review_packs`).all() as { pr_number: number }[];
    return numbers
      .map((r) => this.getCurrentReviewPack(r.pr_number))
      .filter((record): record is ReviewPackRecord => record !== null);
  }

  /**
   * The pack written against one head, or null. What a share publishes: a share
   * is of the pack somebody read, not of whatever the pull request has by the
   * time the pool's clock comes round.
   */
  getReviewPackAt(prNumber: number, headSha: string): ReviewPackRecord | null {
    const row = this.ctx.db
      .prepare(`SELECT document, written_at FROM review_packs WHERE pr_number=? AND head_sha=?`)
      .get(prNumber, headSha) as PackRow | undefined;
    return row ? { pack: JSON.parse(row.document) as ReviewPack, writtenAt: row.written_at } : null;
  }

  /**
   * Somebody asked for this pack to be shared. Upserted on the pull request: a
   * second ask on a newer head replaces the first, and clears the previous
   * publish and refusal — what is in the namespace is one document per pull
   * request, so the row that describes it is one too.
   */
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

  /**
   * Somebody unshared it. The row is **kept and stamped** rather than deleted, because the
   * copy in the namespace is still there and only the pool's own arm may take it out; that
   * arm unpublishes and then deletes the row. A share that never landed is deleted here.
   * → `docs/spec/28-cross-fleet-pool.md#the-publish-is-never-inside-a-route-handler`
   */
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

  /** The transport took it. Stamped after the publish, never before: the row says what is in the pool. */
  recordReviewPackShared(prNumber: number): void {
    this.ctx.db
      .prepare(`UPDATE review_pack_shares SET published_at=?, refusal=NULL WHERE pr_number=?`)
      .run(this.ctx.now(), prNumber);
  }

  /**
   * The backstop refused it, and it is not in the pool. Recorded rather than
   * thrown away, because a refusal a reviewer never sees is a share they believe
   * happened. The publish stamp is cleared with it: a pack refused on a re-share
   * is one the pool no longer carries.
   */
  recordReviewPackShareRefusal(prNumber: number, refusal: string): void {
    this.ctx.db
      .prepare(`UPDATE review_pack_shares SET refusal=?, published_at=NULL WHERE pr_number=?`)
      .run(refusal, prNumber);
  }

  /** What this pull request's share is, or null where nobody has asked for one. */
  getReviewPackShare(prNumber: number): ReviewPackShare | null {
    const row = this.ctx.db.prepare(`SELECT * FROM review_pack_shares WHERE pr_number=?`).get(prNumber) as
      | ShareRow
      | undefined;
    return row ? rowToShare(row) : null;
  }

  /** Every share, for the arm that publishes the asked-for ones and prunes the dead. */
  listReviewPackShares(): ReviewPackShare[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM review_pack_shares ORDER BY pr_number ASC`).all() as ShareRow[];
    return rows.map(rowToShare);
  }

  /**
   * Forget a share. Called when the pack has been pruned from the namespace —
   * **the `review_packs` row is untouched**: it is the fleet's own record, and the
   * cost of keeping it is the fleet's.
   */
  deleteReviewPackShare(prNumber: number): void {
    this.ctx.db.prepare(`DELETE FROM review_pack_shares WHERE pr_number=?`).run(prNumber);
  }

  /**
   * Mark an idea read, or unread — recorded against every hunk the idea owns,
   * one row each, so the next pack draws it on whichever idea owns the same
   * hunks. A standing attention override on any of those hunks is kept.
   */
  markReviewIdeaRead(input: { prNumber: number; headSha: string; hunks: ReviewRange[]; read: boolean }): ReviewMark[] {
    return this.upsertMarks(input.prNumber, input.headSha, input.hunks, { read: input.read ? 1 : 0 });
  }

  /**
   * Override the checker's attention label on an idea, or clear the override with
   * null — recorded per hunk for {@link markReviewIdeaRead}'s reason. The
   * override is never shown to the checker on a later pack; it is surfaced to the
   * operator, whose pattern-reading it is for.
   */
  overrideReviewAttention(input: {
    prNumber: number;
    headSha: string;
    hunks: ReviewRange[];
    attention: ReviewAttention | null;
  }): ReviewMark[] {
    return this.upsertMarks(input.prNumber, input.headSha, input.hunks, { attention: input.attention });
  }

  /**
   * The reader took the finding on this idea's false claim — the one column about the
   * checker's output rather than the author's, and what makes prominence measurable.
   * → `docs/spec/31-review-packs.md#whether-prominence-works`
   */
  markReviewFindingSeen(input: {
    prNumber: number;
    headSha: string;
    hunks: ReviewRange[];
    seen: boolean;
  }): ReviewMark[] {
    return this.upsertMarks(input.prNumber, input.headSha, input.hunks, { seen: input.seen ? 1 : 0 });
  }

  /**
   * Every mark on every pull request — what the calibration reading folds, in one read
   * rather than one per pull request.
   */
  listAllReviewMarks(): ReviewMark[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM review_marks ORDER BY pr_number ASC, path ASC, start_line ASC, end_line ASC`)
      .all() as MarkRow[];
    return rows.map(rowToMark);
  }

  /** Every mark on the pull request, whichever head each was made against. */
  listReviewMarks(prNumber: number): ReviewMark[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM review_marks WHERE pr_number=? ORDER BY path ASC, start_line ASC, end_line ASC`)
      .all(prNumber) as MarkRow[];
    return rows.map(rowToMark);
  }

  /**
   * One row per hunk, upserted on the hunk. Each write names only the column it is about, so
   * reading an idea does not disturb an override on it or a finding taken on it.
   */
  private upsertMarks(
    prNumber: number,
    headSha: string,
    hunks: ReviewRange[],
    patch: { read: number } | { attention: ReviewAttention | null } | { seen: number },
  ): ReviewMark[] {
    const markedAt = this.ctx.now();
    // Which column this write is about; the other two keep what they had.
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

/**
 * The four labels, in one place: the store narrows a stored override against it
 * and the mark route refuses a body naming anything else against the same list.
 */
export const REVIEW_ATTENTIONS: readonly ReviewAttention[] = ['read', 'decide', 'skim', 'split'];

function rowToMark(r: MarkRow): ReviewMark {
  return {
    prNumber: r.pr_number,
    hunk: { path: r.path, start: r.start_line, end: r.end_line },
    headSha: r.head_sha,
    // Narrowed on read: the column is text, and a later build's label must not arrive as one
    // this build will switch on.
    attention: REVIEW_ATTENTIONS.find((a) => a === r.attention) ?? null,
    read: r.read === 1,
    seen: r.seen === 1,
    markedAt: r.marked_at,
  };
}
