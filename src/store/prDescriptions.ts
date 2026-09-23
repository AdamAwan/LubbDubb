import { nanoid } from 'nanoid';
import type { DescriptionFinding, DescriptionQuestion, PrDescriptionHandoff, PrDescriptionVersion } from '../types.js';
import { issueOriginRef } from '../issueOrigins.js';
import { composeDescribedBody } from '../pr/prDescription.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

// → docs/spec/07-pull-requests.md#the-operator-writes-the-description

/**
 * `pushed_at` is when the version reached the pull request it describes. Null means
 * the provider has not been told about it, so every row from before this column
 * existed reads as unpushed — and needs no backfill only because `unpushedDescriptions`
 * joins `pr_description_bodies`, which nothing before this change ever wrote. That
 * join is what keeps an upgrade from rewriting the body of every pull request the
 * deployment has ever opened; it is not an incidental one.
 */
export const PR_DESCRIPTION_COLUMNS: ColumnMigrations = {
  pr_descriptions: {
    pushed_at: 'TEXT',
  },
};

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
        findings: [],
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
    return row ? this.toVersion(row) : null;
  }

  /** The whole chain, oldest first. What the part's panel draws behind the current one. */
  listDescriptionVersions(originRef: string): PrDescriptionVersion[] {
    const rows = this.ctx
      .prep(`SELECT * FROM pr_descriptions WHERE origin_ref=? ORDER BY version ASC`)
      .all(originRef) as DescriptionRow[];
    return rows.map((r) => this.toVersion(r));
  }

  /**
   * The newest version of every part of one goal, keyed by the part's slug. What the
   * plan's parts are badged from: one read for the goal rather than one per part,
   * because the board draws every part and only one of them is in front of the
   * operator. → docs/spec/17-cockpit.md#the-description-a-reviewer-reads
   */
  goalDescriptions(issueNumber: number): Record<string, PrDescriptionVersion> {
    const prefix = `${issueOriginRef('part', issueNumber, '')}`;
    const rows = this.ctx
      .prep(
        `SELECT * FROM pr_descriptions d
          WHERE d.origin_ref LIKE @prefix || '%'
            AND d.version = (SELECT MAX(version) FROM pr_descriptions x WHERE x.origin_ref = d.origin_ref)`,
      )
      .all({ prefix }) as DescriptionRow[];
    const out: Record<string, PrDescriptionVersion> = {};
    for (const row of rows) out[row.origin_ref.slice(prefix.length)] = this.toVersion(row);
    return out;
  }

  /**
   * Every part whose pull request is open and which nobody has written a word about.
   *
   * Anti-joined against `pr_description_bodies` rather than read off the plan, and
   * that is the whole point: the body record is written by `open_pr` itself, so a
   * part is asked about the moment its pull request exists. `plan_parts.pr_number`
   * is a *reading* of the world, filled in by a later cycle observing the branch —
   * asked there, the ask appears whenever the next world read happens to land, and
   * not at all on a part whose branch the observer could not match.
   *
   * Open is not decided here: the store holds no world. The caller drops the parts
   * whose pull request has since merged or closed.
   */
  undescribedOpenParts(): { originRef: string; prNumber: number; openedAt: string }[] {
    const rows = this.ctx
      .prep(
        `SELECT b.origin_ref AS origin_ref, b.pr_number AS pr_number, b.opened_at AS opened_at
           FROM pr_description_bodies b
          WHERE NOT EXISTS (SELECT 1 FROM pr_descriptions d WHERE d.origin_ref = b.origin_ref)
            AND NOT EXISTS (SELECT 1 FROM pr_description_handoffs h WHERE h.origin_ref = b.origin_ref)
          ORDER BY b.opened_at ASC`,
      )
      .all() as { origin_ref: string; pr_number: number; opened_at: string }[];
    return rows.map((r) => ({ originRef: r.origin_ref, prNumber: r.pr_number, openedAt: r.opened_at }));
  }

  /**
   * The part a pull request carries, or null for one this deployment did not open for
   * a part.
   *
   * The same record `undescribedOpenParts` is anti-joined against, read the other way
   * round — and for the same reason. `plan_parts.pr_number` is a *reading* of the
   * world filled in by a later cycle that matched the branch, so a page that resolved
   * its part there would offer the field whenever the next world read happened to
   * land, and never at all for a branch the observer could not match. `open_pr` writes
   * this row at the open.
   *
   * Newest first, because `origin_ref` is the key and nothing stops two parts from
   * having named one pull request over a deployment's life.
   * → docs/spec/07-pull-requests.md#the-pull-requests-own-page-is-where-it-is-written
   */
  partOfPullRequest(prNumber: number): string | null {
    const row = this.ctx
      .prep(`SELECT origin_ref FROM pr_description_bodies WHERE pr_number=? ORDER BY opened_at DESC LIMIT 1`)
      .get(prNumber) as { origin_ref: string } | undefined;
    return row?.origin_ref ?? null;
  }

  /** Every version that carries a check, newest first. The aggregate's input. */
  listCheckedDescriptions(): PrDescriptionVersion[] {
    const rows = this.ctx
      .prep(`SELECT * FROM pr_descriptions WHERE checked_at IS NOT NULL ORDER BY checked_at DESC, rowid DESC`)
      .all() as DescriptionRow[];
    return rows.map((r) => this.toVersion(r));
  }

  /**
   * Writes a check's findings onto the version it read, addressed by id rather than
   * by "the current one". The operator can edit while their own Claude Code is still
   * reading, and a report that landed on whatever happened to be newest would mark
   * text the session never saw.
   *
   * A check that found nothing is a real outcome and writes `checkedAt` with no
   * findings — which has to stay tellable from a version nobody checked.
   *
   * Returns null for a version that is not there, which is the honest answer to a
   * report naming an id the store does not hold.
   */
  recordCheck(input: { id: string; findings: readonly DescriptionFinding[] }): PrDescriptionVersion | null {
    const write = this.ctx.db.transaction((): PrDescriptionVersion | null => {
      const row = this.ctx.prep(`SELECT * FROM pr_descriptions WHERE id=?`).get(input.id) as DescriptionRow | undefined;
      if (row === undefined) return null;
      const checkedAt = this.ctx.now();
      // A re-check replaces the reading rather than appending to it: two sessions
      // over one text are two readings of it, and kept together they read as one
      // session that found twice as much.
      this.ctx.prep(`DELETE FROM pr_description_findings WHERE description_id=?`).run(input.id);
      for (const [i, finding] of input.findings.entries()) {
        this.ctx
          .prep(
            `INSERT INTO pr_description_findings (id, description_id, seq, kind, note, question)
             VALUES (@id, @descriptionId, @seq, @kind, @note, @question)`,
          )
          .run({
            id: `find_${nanoid(10)}`,
            descriptionId: input.id,
            seq: i + 1,
            kind: finding.kind,
            note: finding.note,
            question: finding.question,
          });
      }
      this.ctx.prep(`UPDATE pr_descriptions SET checked_at=@checkedAt WHERE id=@id`).run({ id: input.id, checkedAt });
      return { ...this.toVersion(row), checkedAt, findings: [...input.findings] };
    });
    return write();
  }

  /**
   * What `open_pr` wrote under this part — the evidence block and the reference — so
   * a description written afterwards can be put in front of it. Recorded at the open
   * and never again: the tail is the agent's coordinates and the operator's prose is
   * the only thing that ever changes above it.
   */
  recordPrBody(input: { originRef: string; prNumber: number; tail: string }): void {
    this.ctx
      .prep(
        `INSERT INTO pr_description_bodies (origin_ref, pr_number, tail, opened_at)
         VALUES (@originRef, @prNumber, @tail, @openedAt)
         ON CONFLICT(origin_ref) DO UPDATE SET pr_number=excluded.pr_number, tail=excluded.tail`,
      )
      .run({ ...input, openedAt: this.ctx.now() });
  }

  /**
   * Every part whose newest description has not reached its pull request, with the
   * body that description composes. Only the newest: a rewrite supersedes what was
   * pushed before it, and pushing the chain would write four bodies to say the last
   * one.
   */
  unpushedDescriptions(): { id: string; prNumber: number; body: string }[] {
    const rows = this.ctx
      .prep(
        `SELECT d.id AS id, b.pr_number AS pr_number, d.text AS text, b.tail AS tail
           FROM pr_descriptions d
           JOIN pr_description_bodies b ON b.origin_ref = d.origin_ref
          WHERE d.pushed_at IS NULL
            AND d.version = (SELECT MAX(version) FROM pr_descriptions x WHERE x.origin_ref = d.origin_ref)
          ORDER BY d.authored_at ASC`,
      )
      .all() as { id: string; pr_number: number; text: string; tail: string }[];
    return rows.map((r) => ({
      id: r.id,
      prNumber: r.pr_number,
      body: composeDescribedBody(r.text, r.tail),
    }));
  }

  /**
   * Hands a part's description back to an agent. Idempotent: a second press returns
   * the row the first one wrote rather than asking again.
   * → docs/spec/07-pull-requests.md#handing-it-back-to-the-agent
   */
  handOff(input: { originRef: string; prNumber: number; requestedBy: string | null }): PrDescriptionHandoff {
    this.ctx
      .prep(
        `INSERT INTO pr_description_handoffs (origin_ref, pr_number, requested_by, requested_at)
         VALUES (@originRef, @prNumber, @requestedBy, @requestedAt)
         ON CONFLICT(origin_ref) DO NOTHING`,
      )
      .run({ ...input, requestedAt: this.ctx.now() });
    return this.handoffOf(input.originRef) as PrDescriptionHandoff;
  }

  handoffOf(originRef: string): PrDescriptionHandoff | null {
    const row = this.ctx.prep(`SELECT * FROM pr_description_handoffs WHERE origin_ref=?`).get(originRef) as
      | HandoffRow
      | undefined;
    return row ? toHandoff(row) : null;
  }

  /** Handoffs the agent has not written yet: what rule `pr-describe` dispatches for. */
  pendingHandoffs(): PrDescriptionHandoff[] {
    const rows = this.ctx
      .prep(`SELECT * FROM pr_description_handoffs WHERE text IS NULL ORDER BY requested_at ASC`)
      .all() as HandoffRow[];
    return rows.map(toHandoff);
  }

  /**
   * The agent's text, against the pull request it was dispatched for. Null where no
   * handoff names that pull request, which is the honest answer to a write nobody asked for.
   */
  writeHandoff(input: { prNumber: number; text: string }): PrDescriptionHandoff | null {
    const row = this.ctx.prep(`SELECT * FROM pr_description_handoffs WHERE pr_number=?`).get(input.prNumber) as
      | HandoffRow
      | undefined;
    if (row === undefined) return null;
    this.ctx
      .prep(`UPDATE pr_description_handoffs SET text=@text, written_at=@at, pushed_at=NULL WHERE origin_ref=@originRef`)
      .run({ originRef: row.origin_ref, text: input.text, at: this.ctx.now() });
    return this.handoffOf(row.origin_ref);
  }

  /**
   * Agent-written descriptions not yet on their pull request, composed with the tail
   * `open_pr` recorded. A part the operator has written a version for is left out: a
   * person's description outranks the agent's, and pushing both would race.
   */
  unpushedHandoffs(): { originRef: string; prNumber: number; body: string }[] {
    const rows = this.ctx
      .prep(
        `SELECT h.origin_ref AS origin_ref, b.pr_number AS pr_number, h.text AS text, b.tail AS tail
           FROM pr_description_handoffs h
           JOIN pr_description_bodies b ON b.origin_ref = h.origin_ref
          WHERE h.text IS NOT NULL AND h.pushed_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM pr_descriptions d WHERE d.origin_ref = h.origin_ref)
          ORDER BY h.written_at ASC`,
      )
      .all() as { origin_ref: string; pr_number: number; text: string; tail: string }[];
    return rows.map((r) => ({
      originRef: r.origin_ref,
      prNumber: r.pr_number,
      body: [r.text.trim(), r.tail.trim()].filter((part) => part !== '').join('\n\n'),
    }));
  }

  markHandoffPushed(originRef: string): void {
    this.ctx
      .prep(`UPDATE pr_description_handoffs SET pushed_at=@pushedAt WHERE origin_ref=@originRef`)
      .run({ originRef, pushedAt: this.ctx.now() });
  }

  /** Records that a version reached its pull request. */
  markPushed(id: string): void {
    this.ctx.prep(`UPDATE pr_descriptions SET pushed_at=@pushedAt WHERE id=@id`).run({ id, pushedAt: this.ctx.now() });
  }

  private findingsOf(descriptionId: string): DescriptionFinding[] {
    const rows = this.ctx
      .prep(`SELECT kind, note, question FROM pr_description_findings WHERE description_id=? ORDER BY seq ASC`)
      .all(descriptionId) as { kind: DescriptionFinding['kind']; note: string; question: DescriptionQuestion | null }[];
    return rows.map((r) => ({ kind: r.kind, note: r.note, question: r.question }));
  }

  private toVersion(r: DescriptionRow): PrDescriptionVersion {
    return {
      id: r.id,
      originRef: r.origin_ref,
      version: r.version,
      supersedes: r.supersedes,
      text: r.text,
      author: r.author,
      authoredAt: r.authored_at,
      checkedAt: r.checked_at,
      findings: r.checked_at === null ? [] : this.findingsOf(r.id),
    };
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
}

interface HandoffRow {
  origin_ref: string;
  pr_number: number;
  requested_by: string | null;
  requested_at: string;
  text: string | null;
  written_at: string | null;
  pushed_at: string | null;
}

function toHandoff(r: HandoffRow): PrDescriptionHandoff {
  return {
    originRef: r.origin_ref,
    prNumber: r.pr_number,
    requestedBy: r.requested_by,
    requestedAt: r.requested_at,
    text: r.text,
    writtenAt: r.written_at,
    pushedAt: r.pushed_at,
  };
}
