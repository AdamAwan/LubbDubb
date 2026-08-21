import { nanoid } from 'nanoid';
import type { Lesson, LessonInput, LessonStatus } from '../types.js';
import type { StoreContext } from './context.js';

/**
 * The `lessons` table: what working one goal taught about working *this
 * repository*, kept where the next goal can reach it (issue #355).
 *
 * Modelled on `FindingStore` deliberately — a lesson is a claim until a
 * human vouches for it, which is the shape a finding already has, and inventing
 * a second gate for the same problem is how two gates come to disagree about
 * what "an operator decided" means.
 *
 * **A promoted lesson has exactly one reader outside the cockpit**, and since
 * issue #27 phase 3 it is the knowledge base: `KnowledgeStore.adoptLessons`
 * mirrors a promoted row in as an injected fleet claim, and
 * `renderKnowledgeBlock` (`src/knowledge/block.ts`) puts *that* into every
 * agent's system-prompt append, capped and dated. Rendering both blocks would
 * have sent every promoted lesson twice, so delivery moved rather than doubling.
 * No dispatcher rule consults this table, no dispatch prompt renders one, and
 * nothing on the launch path may reach either store itself — `src/system.ts`
 * reads and hands the runtimes a finished string. The two *verdicts* below stay operator-driven,
 * exactly as every finding transition is: what phase 2 changed is who may
 * propose, and what phase 3 changed is what promotion is worth — never who may
 * promote.
 */
export class LessonStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Write a lesson down. It lands `proposed`, which is the whole gate: the
   * proposal is visible to the operator and to nothing else.
   *
   * **Deduped against the live rows on the same goal**, in `recordFinding`'s
   * shape and for its reason. Phase 2 gave this table a second writer that is not
   * a person reading the list it is adding to: `retro_submit` upserts its
   * document on `origin_ref`, so a retrospective filed twice — an agent calling
   * the tool again in the same turn, a resubmission after a rejected field —
   * replaces one write-up and would otherwise leave two of every lesson behind
   * it. Two identical claims on one goal are one claim.
   *
   * Scoped to the *live* statuses, so a retired lesson can be written again: that
   * is the re-proposal the spec's "no un-retire" rests on, and it re-dates the
   * claim, which is the point.
   */
  proposeLesson(input: LessonInput): Lesson {
    const existing = this.findLiveClaim(input);
    if (existing) return existing;
    const ts = this.ctx.now();
    const lesson: Lesson = {
      id: `lesn_${nanoid(10)}`,
      text: input.text,
      originRef: input.originRef,
      status: 'proposed',
      createdAt: ts,
      updatedAt: ts,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO lessons (id, text, origin_ref, status, created_at, updated_at)
         VALUES (@id, @text, @originRef, @status, @createdAt, @updatedAt)`,
      )
      .run(lesson);
    return lesson;
  }

  /**
   * The standing row for this exact claim on this exact goal, if there is one.
   *
   * Exact text, not a fuzzy match: a lesson is prose, and two claims that differ
   * by a word are two claims an operator should be shown rather than one the
   * store picked between. `origin_ref` is part of the key because the same
   * sentence learned on two goals is genuinely twice-learned — that is
   * corroboration, and flattening it would hide the strongest signal the store
   * has.
   */
  private findLiveClaim(input: LessonInput): Lesson | null {
    const row = this.ctx.db
      .prepare(
        // `IS` rather than `=` so a null origin matches a null origin: a lesson
        // with no goal behind it is still deduped against its own twin, which
        // `=` would silently never match.
        `SELECT * FROM lessons
         WHERE text=? AND origin_ref IS ? AND status IN ('proposed','promoted')
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(input.text, input.originRef) as LessonRow | undefined;
    return row ? rowToLesson(row) : null;
  }

  getLesson(id: string): Lesson | null {
    const row = this.ctx.db.prepare(`SELECT * FROM lessons WHERE id=?`).get(id) as LessonRow | undefined;
    return row ? rowToLesson(row) : null;
  }

  /**
   * Every lesson, newest first — retired ones included. The prune surface has to
   * draw what it pruned, or "retired" is indistinguishable from "deleted" and
   * the operator has no way to see that the list they are reading is complete.
   */
  listLessons(limit = 200): Lesson[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM lessons ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(limit) as LessonRow[];
    return rows.map(rowToLesson);
  }

  /**
   * The operator vouches for a proposal. Only a proposal can be promoted, so a
   * double-click promotes once and a retired lesson does not come back without
   * being read again.
   */
  promoteLesson(id: string): Lesson | null {
    return this.move(id, 'promoted', `status='proposed'`);
  }

  /**
   * Prune one. From either live status, because the two things being pruned are
   * "we do not need to decide on this" and "this stopped being true" — and the
   * second is the one this whole surface exists for.
   */
  retireLesson(id: string): Lesson | null {
    return this.move(id, 'retired', `status IN ('proposed','promoted')`);
  }

  /**
   * The guard is in the `WHERE`, not in a read-then-check — the discipline
   * `linkFindingTicket` and `decideProposal` already use, so two clicks that
   * race cannot both find a promotable row. Null means there was nothing in a
   * status this transition could leave, which the route turns into a 409.
   */
  private move(id: string, status: LessonStatus, from: string): Lesson | null {
    const updatedAt = this.ctx.now();
    const result = this.ctx.db
      .prepare(`UPDATE lessons SET status=?, updated_at=? WHERE id=? AND ${from}`)
      .run(status, updatedAt, id);
    if (result.changes === 0) return null;
    return this.getLesson(id);
  }
}

interface LessonRow {
  id: string;
  text: string;
  origin_ref: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function rowToLesson(r: LessonRow): Lesson {
  return {
    id: r.id,
    text: r.text,
    originRef: r.origin_ref,
    status: r.status as LessonStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
