import { nanoid } from 'nanoid';
import type {
  GoalPrediction,
  GoalReveal,
  PredictionMark,
  PredictionOutcomeMarks,
  PredictionPlanMarks,
  PredictionSlot,
} from '../types.js';
import type { StoreContext } from './context.js';
import type { ColumnMigrations, TableRebuild } from './migrate.js';

// → docs/spec/14-persistence.md#the-prediction-store-is-not-on-store

export const PREDICTION_SLOTS = ['locus', 'cause', 'split', 'avoid'] as const satisfies readonly PredictionSlot[];

/**
 * `goal_predictions` predates both moments' marks, so they arrive by `ALTER TABLE`
 * as well as in the schema: a database from before today has the table already, and
 * `CREATE TABLE IF NOT EXISTS` would never touch it. No backfill belongs here — a
 * null mark means not marked, which is the truth for every row that already exists,
 * and it says the same of moment two on every row written before delivery asked.
 */
export const PREDICTION_COLUMNS: ColumnMigrations = {
  goal_predictions: {
    plan_mark_locus: 'TEXT',
    plan_mark_cause: 'TEXT',
    plan_mark_split: 'TEXT',
    plan_mark_avoid: 'TEXT',
    plan_marked_at: 'TEXT',
    outcome_mark_locus: 'TEXT',
    outcome_mark_cause: 'TEXT',
    outcome_mark_split: 'TEXT',
    outcome_mark_avoid: 'TEXT',
    outcome_marked_at: 'TEXT',
  },
};

/**
 * The slot vocabulary changed: `hard` and `surprise` were retired for `split` and
 * `avoid`, because a slot phrased as a thing you do *not* expect cannot be marked
 * `matched` without the operator having to guess which way round the word runs.
 * → docs/spec/14-persistence.md#retiring-a-slot
 *
 * A retired slot is a **column**, so `ensureColumns` cannot reach it and the table is
 * rebuilt instead, keyed on `hard` still being there. What carries over is the text
 * of the two slots whose question is unchanged and nothing else: every mark is
 * dropped, on all four slots, so that the stamps stay derived — a row whose only
 * marks were on the two retired slots would otherwise keep a `plan_marked_at` saying
 * a moment was answered with nothing left in it to have answered, and the
 * aggregate's count of answered goals would become a count of goals somebody once
 * opened. The columns copied are the ones the table has carried since it was
 * created, because a database old enough to predate the mark columns has `hard` too
 * and must survive this pass as well.
 *
 * `goal_reveals` is deliberately untouched. A goal whose plan the operator has
 * already read can never take a new prediction — `recordPrediction` refuses once a
 * reveal stands — and clearing the reveals to re-offer the gate would invite a
 * prediction written by somebody who has seen the plan, which is the one thing the
 * whole record cannot survive.
 */
export const PREDICTION_REBUILDS: readonly TableRebuild[] = [
  {
    table: 'goal_predictions',
    keyedOn: 'hard',
    copy: (old) => `
      INSERT INTO goal_predictions (id, origin_ref, author, locus, cause, created_at, updated_at)
      SELECT id, origin_ref, author, locus, cause, created_at, updated_at FROM ${old}`,
  },
];

type PredictionSlots = Readonly<Record<PredictionSlot, string | null>>;

const UNMARKED: PredictionPlanMarks = { locus: null, cause: null, split: null, avoid: null };

/** What a mark call answers: the written prediction, or which refusal and over which slot. */
type MarkOutcome =
  | { ok: true; prediction: GoalPrediction }
  | { ok: false; reason: 'no-prediction' | 'not-revealed' }
  | { ok: false; reason: 'slot-skipped'; slot: PredictionSlot };

type MarkInput = Partial<Readonly<Record<PredictionSlot, PredictionMark | null>>>;

/**
 * The two scoring moments, as the one statement each needs.
 *
 * `plan` is moment one — "did I predict the plan?", a claim about the operator's
 * model of the system, answered at the reveal. `outcome` is moment two — "was the
 * plan right?", a claim about the plan itself, asked at delivery. Two column
 * families over one row rather than one family, because the rows worth reading are
 * the ones where the two disagree: a prediction that missed the plan and a plan that
 * then turned out wrong is the operator having been right, and moment one alone
 * files it as a miss.
 */
const MOMENT_WRITES = {
  plan: `UPDATE goal_predictions
            SET plan_mark_locus=@locus, plan_mark_cause=@cause, plan_mark_split=@split,
                plan_mark_avoid=@avoid, plan_marked_at=@markedAt, updated_at=@updatedAt
          WHERE origin_ref=@originRef`,
  outcome: `UPDATE goal_predictions
               SET outcome_mark_locus=@locus, outcome_mark_cause=@cause, outcome_mark_split=@split,
                   outcome_mark_avoid=@avoid, outcome_marked_at=@markedAt, updated_at=@updatedAt
             WHERE origin_ref=@originRef`,
} as const;

type Moment = keyof typeof MOMENT_WRITES;

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
        outcomeMarks: UNMARKED,
        outcomeMarkedAt: null,
        createdAt: ts,
        updatedAt: ts,
      };
      this.ctx
        .prep(
          `INSERT INTO goal_predictions (id, origin_ref, author, locus, cause, split, avoid, created_at, updated_at)
           VALUES (@id, @originRef, @author, @locus, @cause, @split, @avoid, @createdAt, @updatedAt)`,
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
  recordPlanMarks(input: { originRef: string; marks: MarkInput }): MarkOutcome {
    return this.recordMarks('plan', input);
  }

  /**
   * Records moment two's marks — "was the plan right?" — on the same terms, and with
   * the same refusals for the same reasons.
   *
   * The reveal is required here as well, so that both moments stand over exactly the
   * same population: an unrevealed goal can carry no moment-one mark at all, so a
   * moment-two mark on one would be a row in the second aggregate's columns with
   * nothing in the first's to compare it against — the mirror of the skip this
   * moment is careful not to fold into a miss.
   *
   * Delivery is deliberately **not** required. Delivery is what makes the question
   * worth asking — it is what puts the bench row up — not what makes an answer true;
   * a plan can be plainly wrong before anything ships, a delivery can be cleared and
   * re-made, and re-marking is allowed anyway, so a refusal here would only move the
   * same answer later. Requiring it would also make the prediction store read
   * delivery bookkeeping off `Store`, which it is deliberately contained from.
   */
  recordOutcomeMarks(input: { originRef: string; marks: MarkInput }): MarkOutcome {
    return this.recordMarks('outcome', input);
  }

  /**
   * The goals whose moment one was answered and whose moment two has not been, as
   * origin refs and nothing else.
   *
   * Refs alone is the point rather than an economy: this is what the delivery
   * close-out bench reads, a bench row is persisted as a human task and is served to
   * surfaces that are not the cockpit. The row says which goal owes moment two; the
   * prediction's text is fetched through `GET /api/goals/:number/prediction`, which
   * is its one reader.
   */
  listOutcomeOwed(): string[] {
    const rows = this.ctx
      .prep(`SELECT origin_ref FROM goal_predictions WHERE plan_marked_at IS NOT NULL AND outcome_marked_at IS NULL`)
      .all() as { origin_ref: string }[];
    return rows.map((r) => r.origin_ref);
  }

  /**
   * Every prediction. The aggregate's read, and it narrows what comes back to marks
   * and counts before anything reads it — the rows themselves still carry the text,
   * so this stays as contained as every other method here: it is reached only as
   * `system.predictions`, never off `Store`.
   */
  listPredictions(): GoalPrediction[] {
    const rows = this.ctx.prep(`SELECT * FROM goal_predictions ORDER BY created_at ASC`).all() as PredictionRow[];
    return rows.map(rowToPrediction);
  }

  /** Every reveal. A goal absent from this list was never offered the gate, which is not a decline. */
  listReveals(): GoalReveal[] {
    const rows = this.ctx.prep(`SELECT * FROM goal_reveals ORDER BY revealed_at ASC`).all() as RevealRow[];
    return rows.map((row) => ({
      originRef: row.origin_ref,
      revealedAt: row.revealed_at,
      predicted: row.predicted === 1,
    }));
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

  private recordMarks(moment: Moment, input: { originRef: string; marks: MarkInput }): MarkOutcome {
    const write = this.ctx.db.transaction((): MarkOutcome => {
      const standing = this.getPrediction(input.originRef);
      if (standing === null) return { ok: false, reason: 'no-prediction' };
      if (this.getReveal(input.originRef) === null) return { ok: false, reason: 'not-revealed' };
      const held = moment === 'plan' ? standing.planMarks : standing.outcomeMarks;
      const marks: Record<PredictionSlot, PredictionMark | null> = { ...held };
      for (const slot of PREDICTION_SLOTS) {
        const mark = input.marks[slot];
        if (mark === undefined) continue;
        if (mark !== null && standing.slots[slot] === null) return { ok: false, reason: 'slot-skipped', slot };
        marks[slot] = mark;
      }
      const ts = this.ctx.now();
      // The stamp says the moment was *answered*, so it is derived from the marks
      // rather than written on every call: a call that leaves all four null — an
      // operator un-marking what they had marked — must not leave behind a stamp
      // saying the moment was answered. Otherwise a non-null stamp would not imply a
      // single mark exists, and the aggregate's count of answered goals would be a
      // count of goals somebody once opened. Moment two's stamp is also what the
      // close-out bench reads to know the row is still owed.
      const markedAt = PREDICTION_SLOTS.some((slot) => marks[slot] !== null) ? ts : null;
      this.ctx.prep(MOMENT_WRITES[moment]).run({ ...marks, markedAt, updatedAt: ts, originRef: input.originRef });
      const written: GoalPrediction =
        moment === 'plan'
          ? { ...standing, planMarks: marks, planMarkedAt: markedAt, updatedAt: ts }
          : { ...standing, outcomeMarks: marks, outcomeMarkedAt: markedAt, updatedAt: ts };
      return { ok: true, prediction: written };
    });
    return write();
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
  split: string | null;
  avoid: string | null;
  plan_mark_locus: string | null;
  plan_mark_cause: string | null;
  plan_mark_split: string | null;
  plan_mark_avoid: string | null;
  plan_marked_at: string | null;
  outcome_mark_locus: string | null;
  outcome_mark_cause: string | null;
  outcome_mark_split: string | null;
  outcome_mark_avoid: string | null;
  outcome_marked_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RevealRow {
  origin_ref: string;
  revealed_at: string;
  predicted: number;
}

function rowToPrediction(r: PredictionRow): GoalPrediction {
  const planMarks: PredictionPlanMarks = {
    locus: readMark(r.plan_mark_locus),
    cause: readMark(r.plan_mark_cause),
    split: readMark(r.plan_mark_split),
    avoid: readMark(r.plan_mark_avoid),
  };
  const outcomeMarks: PredictionOutcomeMarks = {
    locus: readMark(r.outcome_mark_locus),
    cause: readMark(r.outcome_mark_cause),
    split: readMark(r.outcome_mark_split),
    avoid: readMark(r.outcome_mark_avoid),
  };
  return {
    id: r.id,
    originRef: r.origin_ref,
    author: r.author,
    slots: { locus: r.locus, cause: r.cause, split: r.split, avoid: r.avoid },
    planMarks,
    planMarkedAt: r.plan_marked_at,
    outcomeMarks,
    outcomeMarkedAt: r.outcome_marked_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const PREDICTION_MARKS = ['matched', 'missed', 'not-applicable'] as const satisfies readonly PredictionMark[];

/** Anything the column does not spell is not marked; it is never folded into a miss. */
function readMark(raw: string | null): PredictionMark | null {
  return PREDICTION_MARKS.find((mark) => mark === raw) ?? null;
}
