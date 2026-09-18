import { nanoid } from 'nanoid';
import type { DescriptionMark, DescriptionMarks, DescriptionQuestion, PrDescriptionVersion } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/07-pull-requests.md#the-operator-writes-the-description

/**
 * The four questions, in the order they are asked and the order every reading of
 * them renders. Exported because the routes, the desktop tool and the aggregate all
 * iterate it, and four spellings of one order is how a mark comes to be filed under
 * the wrong question.
 */
export const DESCRIPTION_QUESTIONS = [
  'asked-for',
  'undone',
  'missing',
  'reach',
] as const satisfies readonly DescriptionQuestion[];

const NO_MARKS: DescriptionMarks = { 'asked-for': null, undone: null, missing: null, reach: null };

/**
 * `pr_descriptions`. Append-only: an edit is a new version pointing at the one it
 * supersedes, and the only `UPDATE` here writes a check's marks onto the version
 * that check read.
 */
export class PrDescriptionStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Appends a version. The chain is per part and its `version` is the count so far
   * plus one, taken inside the write so two presses cannot mint the same number —
   * the `UNIQUE (origin_ref, version)` index refuses the second if they do.
   */
  appendDescription(input: { originRef: string; text: string; author: string | null }): PrDescriptionVersion {
    const write = this.ctx.db.transaction((): PrDescriptionVersion => {
      const standing = this.currentDescription(input.originRef);
      const version: PrDescriptionVersion = {
        id: `desc_${nanoid(10)}`,
        originRef: input.originRef,
        version: (standing?.version ?? 0) + 1,
        supersedes: standing?.id ?? null,
        text: input.text,
        author: input.author,
        authoredAt: this.ctx.now(),
        checkedAt: null,
        marks: NO_MARKS,
      };
      this.ctx
        .prep(
          `INSERT INTO pr_descriptions (id, origin_ref, version, supersedes, text, author, authored_at)
           VALUES (@id, @originRef, @version, @supersedes, @text, @author, @authoredAt)`,
        )
        .run({
          id: version.id,
          originRef: version.originRef,
          version: version.version,
          supersedes: version.supersedes,
          text: version.text,
          author: version.author,
          authoredAt: version.authoredAt,
        });
      return version;
    });
    return write();
  }

  /** The newest version, or null for a part nobody has described. */
  currentDescription(originRef: string): PrDescriptionVersion | null {
    const row = this.ctx
      .prep(`SELECT * FROM pr_descriptions WHERE origin_ref=? ORDER BY version DESC LIMIT 1`)
      .get(originRef) as DescriptionRow | undefined;
    return row ? rowToVersion(row) : null;
  }

  /** The whole chain, oldest first. What the part's panel draws behind the current one. */
  listDescriptionVersions(originRef: string): PrDescriptionVersion[] {
    const rows = this.ctx
      .prep(`SELECT * FROM pr_descriptions WHERE origin_ref=? ORDER BY version ASC`)
      .all(originRef) as DescriptionRow[];
    return rows.map(rowToVersion);
  }

  /** Every version that carries a check, newest first. The aggregate's input. */
  listCheckedDescriptions(): PrDescriptionVersion[] {
    const rows = this.ctx
      .prep(`SELECT * FROM pr_descriptions WHERE checked_at IS NOT NULL ORDER BY checked_at DESC, rowid DESC`)
      .all() as DescriptionRow[];
    return rows.map(rowToVersion);
  }

  /**
   * Writes a check's marks onto the version it read, addressed by id rather than by
   * "the current one". The operator can edit while their own Claude Code is still
   * reading, and a report that landed on whatever happened to be newest would mark
   * text the session never saw.
   *
   * Returns null for a version that is not there, which is the honest answer to a
   * report naming an id the store does not hold.
   */
  recordCheck(input: {
    id: string;
    marks: Partial<Readonly<Record<DescriptionQuestion, DescriptionMark | null>>>;
  }): PrDescriptionVersion | null {
    const write = this.ctx.db.transaction((): PrDescriptionVersion | null => {
      const row = this.ctx.prep(`SELECT * FROM pr_descriptions WHERE id=?`).get(input.id) as DescriptionRow | undefined;
      if (row === undefined) return null;
      const held = rowToVersion(row);
      const marks: Record<DescriptionQuestion, DescriptionMark | null> = { ...held.marks };
      for (const question of DESCRIPTION_QUESTIONS) {
        const given = input.marks[question];
        if (given !== undefined) marks[question] = given;
      }
      const checkedAt = this.ctx.now();
      this.ctx
        .prep(
          `UPDATE pr_descriptions
              SET checked_at=@checkedAt, mark_asked_for=@askedFor, mark_undone=@undone,
                  mark_missing=@missing, mark_reach=@reach
            WHERE id=@id`,
        )
        .run({
          id: input.id,
          checkedAt,
          askedFor: marks['asked-for'],
          undone: marks.undone,
          missing: marks.missing,
          reach: marks.reach,
        });
      return { ...held, checkedAt, marks };
    });
    return write();
  }
}

interface DescriptionRow {
  id: string;
  origin_ref: string;
  version: number;
  supersedes: string | null;
  text: string;
  author: string | null;
  authored_at: string;
  checked_at: string | null;
  mark_asked_for: DescriptionMark | null;
  mark_undone: DescriptionMark | null;
  mark_missing: DescriptionMark | null;
  mark_reach: DescriptionMark | null;
}

function rowToVersion(r: DescriptionRow): PrDescriptionVersion {
  return {
    id: r.id,
    originRef: r.origin_ref,
    version: r.version,
    supersedes: r.supersedes,
    text: r.text,
    author: r.author,
    authoredAt: r.authored_at,
    checkedAt: r.checked_at,
    marks: {
      'asked-for': r.mark_asked_for,
      undone: r.mark_undone,
      missing: r.mark_missing,
      reach: r.mark_reach,
    },
  };
}
