import { nanoid } from 'nanoid';
import type { GoalPrediction, GoalReveal, PredictionMark, PredictionPlanMarks, PredictionSlot } from '../types.js';
import type { StoreContext } from './context.js';
import type { ColumnMigrations } from './migrate.js';

// → docs/spec/14-persistence.md#the-prediction-store-is-not-on-store

export const PREDICTION_SLOTS = ['locus', 'cause', 'hard', 'surprise'] as const satisfies readonly PredictionSlot[];

/**
 * `goal_predictions` predates moment one, so the marks arrive by `ALTER TABLE` as
 * well as in the schema: a database from before today has the table already, and
 * `CREATE TABLE IF NOT EXISTS` would never touch it. No backfill belongs here — a
 * null mark means not marked, which is the truth for every row that already exists.
 */
export const PREDICTION_COLUMNS: ColumnMigrations = {
  goal_predictions: {
    plan_mark_locus: 'TEXT',
    plan_mark_cause: 'TEXT',
    plan_mark_hard: 'TEXT',
    plan_mark_surprise: 'TEXT',
    plan_marked_at: 'TEXT',
  },
};

type PredictionSlots = Readonly<Record<PredictionSlot, string | null>>;

const UNMARKED: PredictionPlanMarks = { locus: null, cause: null, hard: null, surprise: null };

/** What `recordPlanMarks` answers: the written prediction, or which refusal and over which slot. */
type PlanMarkOutcome =
  | { ok: true; prediction: GoalPrediction }
  | { ok: false; reason: 'no-prediction' | 'not-revealed' }
  | { ok: false; reason: 'slot-skipped'; slot: PredictionSlot };

/**
 * `goal_predictions` and `goal_reveals`.
 *
 * Reached from `src/system.ts` through `Store.openPredictions()` and handed to the
 * prediction routes and nothing else. It is deliberately not a member of `Store`,
 * so nothing that is handed a `Store` — the dispatcher, `buildTools`, the retro
 * dossier, the sink — can name it.
 */
export class PredictionStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Writes the operator's prediction. At most one per goal, and a second call on a
   * goal that already has one is refused rather than merged: the row is the record
   * of what was believed at one moment, and re-opening it is the one thing that
   * would make the whole record worthless.
   */
  recordPrediction(input: {
    originRef: string;
    author: string | null;
    slots: Partial<PredictionSlots>;
  }): GoalPrediction | null {
    const write = this.ctx.db.transaction((): GoalPrediction | null => {
      if (this.getPrediction(input.originRef) !== null) return null;
      // The reveal is the seal, and it is enforced here rather than at the route so
      // that it is an invariant of the record instead of a check somebody remembered
      // to write. A prediction typed after the plan was read is not a prediction.
      if (this.getReveal(input.originRef) !== null) return null;
      const ts = this.ctx.now();
      const slots = fillSlots(input.slots);
      const prediction: GoalPrediction = {
        id: `pred_${nanoid(10)}`,
        originRef: input.originRef,
        author: input.author,
        slots,
        planMarks: UNMARKED,
        planMarkedAt: null,
        createdAt: ts,
        updatedAt: ts,
      };
      this.ctx
        .prep(
          `INSERT INTO goal_predictions (id, origin_ref, author, locus, cause, hard, surprise, created_at, updated_at)
           VALUES (@id, @originRef, @author, @locus, @cause, @hard, @surprise, @createdAt, @updatedAt)`,
        )
        .run({
          id: prediction.id,
          originRef: prediction.originRef,
          author: prediction.author,
          ...slots,
          createdAt: ts,
          updatedAt: ts,
        });
      return prediction;
    });
    return write();
  }

  /**
   * Records moment one's marks — "did I predict the plan?" — for the slots named,
   * leaving the rest as they stand. A slot given null is un-marked again.
   *
   * Re-marking is allowed, and deliberately: unlike the prediction itself, which is
   * sealed by the reveal because a prediction written after the plan is not one, a
   * mark is a judgement about a record that is already fixed. Nothing is
   * contaminated by the operator correcting one.
   *
   * Refused when the goal has no reveal row: marking a prediction against a plan the
   * operator has not been shown is not a mark, and the refusal lives here rather
   * than at the route so that it is an invariant of the record. Refused too for a
   * slot the prediction left empty — a skipped slot has nothing to mark.
   */
  recordPlanMarks(input: {
    originRef: string;
    marks: Partial<Readonly<Record<PredictionSlot, PredictionMark | null>>>;
  }): PlanMarkOutcome {
    const write = this.ctx.db.transaction((): PlanMarkOutcome => {
      const standing = this.getPrediction(input.originRef);
      if (standing === null) return { ok: false, reason: 'no-prediction' };
      if (this.getReveal(input.originRef) === null) return { ok: false, reason: 'not-revealed' };
      const marks: Record<PredictionSlot, PredictionMark | null> = { ...standing.planMarks };
      for (const slot of PREDICTION_SLOTS) {
        const mark = input.marks[slot];
        if (mark === undefined) continue;
        if (mark !== null && standing.slots[slot] === null) return { ok: false, reason: 'slot-skipped', slot };
        marks[slot] = mark;
      }
      const ts = this.ctx.now();
      // `plan_marked_at` says moment one was *answered*, so it is derived from the
      // marks rather than stamped on every call: a call that leaves all four null —
      // an operator un-marking what they had marked — must not leave behind a stamp
      // saying the moment was answered. Otherwise a non-null stamp would not imply a
      // single mark exists, and the aggregate's count of answered goals would be a
      // count of goals somebody once opened.
      const markedAt = PREDICTION_SLOTS.some((slot) => marks[slot] !== null) ? ts : null;
      this.ctx
        .prep(
          `UPDATE goal_predictions
              SET plan_mark_locus=@locus, plan_mark_cause=@cause, plan_mark_hard=@hard,
                  plan_mark_surprise=@surprise, plan_marked_at=@markedAt, updated_at=@updatedAt
            WHERE origin_ref=@originRef`,
        )
        .run({ ...marks, markedAt, updatedAt: ts, originRef: input.originRef });
      return { ok: true, prediction: { ...standing, planMarks: marks, planMarkedAt: markedAt, updatedAt: ts } };
    });
    return write();
  }

  getPrediction(originRef: string): GoalPrediction | null {
    const row = this.ctx.prep(`SELECT * FROM goal_predictions WHERE origin_ref=?`).get(originRef) as
      | PredictionRow
      | undefined;
    return row ? rowToPrediction(row) : null;
  }

  /**
   * Stamps the reveal and answers with it. Idempotent on the goal: the first press
   * is the one that decides whether this goal was predicted on, and a later read of
   * an already-revealed plan cannot rewrite that.
   */
  recordReveal(originRef: string): GoalReveal {
    const standing = this.getReveal(originRef);
    if (standing !== null) return standing;
    const reveal: GoalReveal = {
      originRef,
      revealedAt: this.ctx.now(),
      predicted: this.getPrediction(originRef) !== null,
    };
    this.ctx
      .prep(`INSERT INTO goal_reveals (origin_ref, revealed_at, predicted) VALUES (?, ?, ?)`)
      .run(reveal.originRef, reveal.revealedAt, reveal.predicted ? 1 : 0);
    return reveal;
  }

  /** Null means the gate was never offered on this goal, which is not a decline. */
  getReveal(originRef: string): GoalReveal | null {
    const row = this.ctx.prep(`SELECT * FROM goal_reveals WHERE origin_ref=?`).get(originRef) as RevealRow | undefined;
    return row ? { originRef: row.origin_ref, revealedAt: row.revealed_at, predicted: row.predicted === 1 } : null;
  }
}

function fillSlots(partial: Partial<PredictionSlots>): PredictionSlots {
  const slots = {} as Record<PredictionSlot, string | null>;
  for (const slot of PREDICTION_SLOTS) {
    const value = partial[slot]?.trim() ?? '';
    slots[slot] = value.length === 0 ? null : value;
  }
  return slots;
}

interface PredictionRow {
  id: string;
  origin_ref: string;
  author: string | null;
  locus: string | null;
  cause: string | null;
  hard: string | null;
  surprise: string | null;
  plan_mark_locus: string | null;
  plan_mark_cause: string | null;
  plan_mark_hard: string | null;
  plan_mark_surprise: string | null;
  plan_marked_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RevealRow {
  origin_ref: string;
  revealed_at: string;
  predicted: number;
}

function rowToPrediction(r: PredictionRow): GoalPrediction {
  return {
    id: r.id,
    originRef: r.origin_ref,
    author: r.author,
    slots: { locus: r.locus, cause: r.cause, hard: r.hard, surprise: r.surprise },
    planMarks: {
      locus: readMark(r.plan_mark_locus),
      cause: readMark(r.plan_mark_cause),
      hard: readMark(r.plan_mark_hard),
      surprise: readMark(r.plan_mark_surprise),
    },
    planMarkedAt: r.plan_marked_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const PREDICTION_MARKS = ['matched', 'missed', 'not-applicable'] as const satisfies readonly PredictionMark[];

/** Anything the column does not spell is not marked; it is never folded into a miss. */
function readMark(raw: string | null): PredictionMark | null {
  return PREDICTION_MARKS.find((mark) => mark === raw) ?? null;
}
