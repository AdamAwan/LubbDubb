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
 * **Nothing outside the cockpit reads this table.** No dispatcher rule consults
 * it, no prompt renders it and no launch argument carries it; a promoted lesson
 * is a lesson an operator has vouched for, and that is all it is until #355's
 * later phases give it a reader. The three writes below are all operator-driven,
 * exactly as every finding transition is.
 */
export class LessonStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Write a lesson down. It lands `proposed`, which is the whole gate: the
   * proposal is visible to the operator and to nothing else.
   *
   * There is no dedupe against an existing row, unlike `recordFinding`. A
   * finding is deduped because an agent re-reports the same claim on every turn
   * of a run it does not remember; a lesson is written once, by a person, from a
   * surface that is showing them the list they are adding to.
   */
  proposeLesson(input: LessonInput): Lesson {
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
