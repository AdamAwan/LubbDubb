import type { ReviewAttention, ReviewMark, ReviewPack, ReviewPackRecord, ReviewRange } from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

/**
 * The shape version every pack this build writes carries, and the one every
 * reader on this build knows. A document stating another number was written by
 * a different build — a fleet ahead of or behind this one — and a reader that
 * does not know it refuses rather than drawing what it recognises
 * (`docs/spec/31-review-packs.md#the-document-carries-its-schema-version`).
 * Bumped when the shape changes in a way a renderer must know about, never for
 * an added optional field.
 */
export const REVIEW_PACK_SCHEMA = 1;

/**
 * Both tables are new, so neither has a column to migrate — and a table being new
 * *once* does not keep it exempt. Declared empty so the first column added to
 * either is noticed here rather than read back as `undefined` on every database
 * from before it.
 */
export const REVIEW_PACK_COLUMNS: ColumnMigrations = {
  review_packs: {},
  review_marks: {},
};

/**
 * The `review_packs` and `review_marks` tables: a change restated for a person,
 * and what that person did to it. → `docs/spec/31-review-packs.md#where-it-lives`
 *
 * The pack is **one document**, stored as written and read as written. It is
 * written whole by the author and read whole by every renderer, and nothing
 * queries inside it — three normalised tables would buy nothing and cost a join on
 * every read. The store neither renders it nor interprets it.
 *
 * The marks are a separate table because they **outlive the document** they were
 * made against: a pack is immutable output for one head sha, and the moment it is
 * also a record of what somebody did to it, regenerating against a new head throws
 * their marks away.
 */
export class ReviewPackStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Write a pack. Upserted on `(pr_number, head_sha)`: asking again on the same
   * head replaces the pack rather than duplicating it, and a pack for a newer
   * head is a new row beside the old one — the older row is kept, and the newest
   * written is what {@link getCurrentReviewPack} answers.
   *
   * The pull request and head are read off the document, never taken as
   * arguments: the row's columns are a copy of what the document says, and two
   * sources for one fact is how they come to disagree.
   *
   * A document stating a schema this build does not write is refused rather than
   * stored: a pack the store accepted and every reader then refuses is a run's
   * work lost with nothing red at the moment it could have been caught.
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
   * Every pack ever written for the pull request, newest first. Ties on
   * `written_at` break on `rowid` — a nanoid is not in play here, but two packs
   * written inside one millisecond by a test would otherwise come back in an
   * order nothing chose.
   */
  listReviewPacks(prNumber: number): ReviewPackRecord[] {
    const rows = this.ctx.db
      .prepare(`SELECT document, written_at FROM review_packs WHERE pr_number=? ORDER BY written_at DESC, rowid DESC`)
      .all(prNumber) as PackRow[];
    return rows.map((r) => ({ pack: JSON.parse(r.document) as ReviewPack, writtenAt: r.written_at }));
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

  /** Every mark on the pull request, whichever head each was made against. */
  listReviewMarks(prNumber: number): ReviewMark[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM review_marks WHERE pr_number=? ORDER BY path ASC, start_line ASC, end_line ASC`)
      .all(prNumber) as MarkRow[];
    return rows.map(rowToMark);
  }

  /**
   * One row per hunk, upserted on the hunk. The two things a reviewer can do are
   * two columns on one row rather than two rows, so that reading an idea does not
   * disturb an override on it and vice versa: each write names only the column it
   * is about, and the other keeps what it had.
   */
  private upsertMarks(
    prNumber: number,
    headSha: string,
    hunks: ReviewRange[],
    patch: { read: number } | { attention: ReviewAttention | null },
  ): ReviewMark[] {
    const markedAt = this.ctx.now();
    const isRead = 'read' in patch;
    const write = this.ctx.db.prepare(
      `INSERT INTO review_marks (pr_number, path, start_line, end_line, head_sha, attention, read, marked_at)
       VALUES (@prNumber, @path, @start, @end, @headSha, @attention, @read, @markedAt)
       ON CONFLICT(pr_number, path, start_line, end_line) DO UPDATE SET
         head_sha = excluded.head_sha,
         marked_at = excluded.marked_at,
         ${isRead ? 'read = excluded.read' : 'attention = excluded.attention'}`,
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
          attention: isRead ? null : patch.attention,
          read: isRead ? patch.read : 0,
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
interface MarkRow {
  pr_number: number;
  path: string;
  start_line: number;
  end_line: number;
  head_sha: string;
  attention: string | null;
  read: number;
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
    // Narrowed on read rather than trusted: the column is text, and a label a
    // later build knew must not arrive as one this one will switch on.
    attention: REVIEW_ATTENTIONS.find((a) => a === r.attention) ?? null,
    read: r.read === 1,
    markedAt: r.marked_at,
  };
}
