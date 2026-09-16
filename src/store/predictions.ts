import { nanoid } from 'nanoid';
import type { GoalPrediction, GoalReveal, PredictionSlot } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md#the-prediction-store-is-not-on-store

export const PREDICTION_SLOTS = ['locus', 'cause', 'hard', 'surprise'] as const satisfies readonly PredictionSlot[];

type PredictionSlots = Readonly<Record<PredictionSlot, string | null>>;

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
    if (this.getPrediction(input.originRef) !== null) return null;
    const ts = this.ctx.now();
    const slots = fillSlots(input.slots);
    const prediction: GoalPrediction = {
      id: `pred_${nanoid(10)}`,
      originRef: input.originRef,
      author: input.author,
      slots,
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
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
