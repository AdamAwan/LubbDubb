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
 * A table being new **once** does not keep it exempt, which is what these two
 * entries are: `review_marks.seen` and `review_pack_shares.withdrawn_at` were
 * added after their tables shipped, and `CREATE TABLE IF NOT EXISTS` never alters
 * an existing table — so without them every database from before this build reads
 * both columns back as `undefined`.
 *
 * Neither owes a backfill. `seen` is 0 on every existing row and 0 is what those
 * rows mean: nobody had a finding to take, because there was no control to take it
 * with. `withdrawn_at` null means *not withdrawn*, which is true of every share
 * that predates the withdrawal.
 * → `docs/spec/14-persistence.md#migrations`
 */
export const REVIEW_PACK_COLUMNS: ColumnMigrations = {
  review_packs: {},
  review_marks: { seen: 'INTEGER NOT NULL DEFAULT 0' },
  review_pack_shares: { withdrawn_at: 'TEXT' },
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
   * Each pull request's **current** pack — the newest written, one per pull
   * request. What a mark is laid over, because that is the pack the page draws it
   * on: a mark is keyed to a hunk and the idea that owns that hunk now is the idea
   * the reviewer's label is about now.
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
   * Somebody unshared it. The row is **kept and stamped** rather than deleted,
   * because the copy in the namespace is still there and only the pool's own arm
   * may take it out — a route that did the network write would make the click wait
   * on a push to another continent
   * (`docs/spec/28-cross-fleet-pool.md#the-publish-is-never-inside-a-route-handler`).
   * The arm unpublishes and deletes the row; a withdrawal of a share that never
   * landed has nothing in the namespace and is deleted here.
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
   * The reader took the finding on this idea's false claim — the third column, and
   * the only one that is about the checker's output rather than the author's.
   *
   * It is what makes the four prominence requirements measurable: without it the
   * page can be checked for drawing the gate first and nothing can say whether a
   * pull request merged with a false claim nobody read.
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
   * Every mark on every pull request — what the calibration reading folds. One
   * read rather than one per pull request: the table is one row per hunk somebody
   * touched, and the reading is over all of them.
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
   * One row per hunk, upserted on the hunk. The two things a reviewer can do are
   * two columns on one row rather than two rows, so that reading an idea does not
   * disturb an override on it and vice versa: each write names only the column it
   * is about, and the other keeps what it had.
   */
  private upsertMarks(
    prNumber: number,
    headSha: string,
    hunks: ReviewRange[],
    patch: { read: number } | { attention: ReviewAttention | null } | { seen: number },
  ): ReviewMark[] {
    const markedAt = this.ctx.now();
    // Which column this write is about. The other two keep what they had, which is
    // the whole reason the three live on one row: a reader taking a finding must
    // not clear their own override, and a rewrite must not lose either.
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
    // Narrowed on read rather than trusted: the column is text, and a label a
    // later build knew must not arrive as one this one will switch on.
    attention: REVIEW_ATTENTIONS.find((a) => a === r.attention) ?? null,
    read: r.read === 1,
    seen: r.seen === 1,
    markedAt: r.marked_at,
  };
}
