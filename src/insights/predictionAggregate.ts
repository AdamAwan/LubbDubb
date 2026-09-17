import type { GoalCriteriaDrift, GoalPrediction, GoalReveal, PredictionMark, PredictionSlot } from '../types.js';
import { PREDICTION_SLOTS } from '../store/predictions.js';

// → docs/spec/18-observability.md

/**
 * What the aggregate is allowed to see of a prediction: which slots were filled,
 * and how each was marked at each moment. **Never the text, and never the author.**
 *
 * The narrowing is the containment invariant made structural rather than promised.
 * Slot text is dropped to a boolean here, at the one seam between the record and
 * every reading of it, so nothing downstream — no rate, no route, no payload, and
 * emphatically no model — can name a word of what the operator wrote. The `author`
 * column is dropped for the other invariant: the aggregate is keyed by slot and by
 * goal, and scoring people is out of scope, so the author-grouped filter a later
 * change would reach for has nothing here to group by. That is the no-op it should
 * be today rather than a permission system that protects nothing.
 */
interface PredictionFacts {
  originRef: string;
  filled: Readonly<Record<PredictionSlot, boolean>>;
  planMarks: Readonly<Record<PredictionSlot, PredictionMark | null>>;
  outcomeMarks: Readonly<Record<PredictionSlot, PredictionMark | null>>;
}

/** The one door a `GoalPrediction` comes through on its way to a figure. */
export function predictionFacts(prediction: GoalPrediction): PredictionFacts {
  const filled = {} as Record<PredictionSlot, boolean>;
  for (const slot of PREDICTION_SLOTS) filled[slot] = prediction.slots[slot] !== null;
  return {
    originRef: prediction.originRef,
    filled,
    planMarks: { ...prediction.planMarks },
    outcomeMarks: { ...prediction.outcomeMarks },
  };
}

/**
 * A rate and the n it is over, together, because a percentage alone is the figure
 * this panel exists not to draw. Present only at or above the threshold: below it
 * the field is `null` and the count that would be its denominator stands beside it,
 * which is the shape `SpendTrend.comparison` already uses — the decision is the
 * server's, so the client has no branch that can reconstruct the number.
 */
interface PredictionRate {
  rate: number;
  n: number;
}

/** One moment's marks over one slot. Absent — not zero — where the moment was never answered. */
interface PredictionMomentFigures {
  marked: number;
  matched: number;
  missed: number;
  notApplicable: number;
  /** The n `matchRate` is over: `not-applicable` is neither a match nor a miss. */
  judged: number;
  matchRate: PredictionRate | null;
}

/**
 * One slot's figures, at both moments.
 *
 * A slot appears here only if some prediction filled it, and a moment is `null`
 * where nothing was marked at it. That is what makes a fifth slot added next year
 * read as **absent** on every goal that predates it rather than as a column of
 * zeroes, and an unanswered moment two absent rather than a column of misses.
 */
interface PredictionSlotFigures {
  slot: PredictionSlot;
  filled: number;
  plan: PredictionMomentFigures | null;
  outcome: PredictionMomentFigures | null;
}

/**
 * The three outcomes, and they are three rather than two. A goal with a reveal row
 * and a prediction is **predicted**; a reveal row and no prediction is **declined**;
 * a goal with no reveal row at all was **never offered** — which is what every goal
 * from before the switch reads as, permanently, and what makes turning the key on
 * safe. Folding the third into the second opens the aggregate on a fabricated
 * decline rate in the one week it has to earn any trust.
 */
interface PredictionGoalCounts {
  offered: number;
  predicted: number;
  declined: number;
  notOffered: number;
  planMarked: number;
  outcomeMarked: number;
}

interface PredictionDriftCounts {
  records: number;
  goals: number;
}

export interface PredictionAggregate {
  generatedAt: string;
  /** Below this many goals in a rate's denominator the rate is withheld, not dimmed. */
  threshold: number;
  goals: PredictionGoalCounts;
  coverageRate: PredictionRate | null;
  declineRate: PredictionRate | null;
  slots: PredictionSlotFigures[];
  criteriaDrift: PredictionDriftCounts;
}

interface PredictionAggregateInput {
  facts: readonly PredictionFacts[];
  reveals: readonly GoalReveal[];
  /** Every goal the gate could have been offered on — one entry per goal with a plan. */
  plannedGoals: readonly string[];
  drift: readonly GoalCriteriaDrift[];
  threshold: number;
  now: number;
}

export function buildPredictionAggregate(input: PredictionAggregateInput): PredictionAggregate {
  const { facts, reveals, plannedGoals, drift, threshold, now } = input;
  const rate = (numerator: number, n: number): PredictionRate | null =>
    n >= threshold && n > 0 ? { rate: numerator / n, n } : null;

  const revealed = new Set(reveals.map((reveal) => reveal.originRef));
  const predictedOn = new Set(facts.map((fact) => fact.originRef));
  const offered = revealed.size;
  // A prediction is sealed by the reveal, so every prediction belongs to a revealed
  // goal; the join is on the reveal so that coverage is a fraction of goals the gate
  // was actually put to, never of goals that have one.
  const predicted = [...revealed].filter((ref) => predictedOn.has(ref)).length;
  const notOffered = new Set(plannedGoals.filter((ref) => !revealed.has(ref))).size;

  const goals: PredictionGoalCounts = {
    offered,
    predicted,
    declined: offered - predicted,
    notOffered,
    planMarked: facts.filter((fact) => answered(fact.planMarks)).length,
    outcomeMarked: facts.filter((fact) => answered(fact.outcomeMarks)).length,
  };

  const slots: PredictionSlotFigures[] = [];
  for (const slot of PREDICTION_SLOTS) {
    const filled = facts.filter((fact) => fact.filled[slot]);
    if (filled.length === 0) continue;
    slots.push({
      slot,
      filled: filled.length,
      plan: moment(
        filled.map((fact) => fact.planMarks[slot]),
        rate,
      ),
      outcome: moment(
        filled.map((fact) => fact.outcomeMarks[slot]),
        rate,
      ),
    });
  }

  return {
    generatedAt: new Date(now).toISOString(),
    threshold,
    goals,
    coverageRate: rate(predicted, offered),
    declineRate: rate(offered - predicted, offered),
    slots,
    criteriaDrift: { records: drift.length, goals: new Set(drift.map((record) => record.originRef)).size },
  };
}

function answered(marks: Readonly<Record<PredictionSlot, PredictionMark | null>>): boolean {
  return PREDICTION_SLOTS.some((slot) => marks[slot] !== null);
}

function moment(
  marks: readonly (PredictionMark | null)[],
  rate: (numerator: number, n: number) => PredictionRate | null,
): PredictionMomentFigures | null {
  const given = marks.filter((mark): mark is PredictionMark => mark !== null);
  if (given.length === 0) return null;
  const matched = given.filter((mark) => mark === 'matched').length;
  const missed = given.filter((mark) => mark === 'missed').length;
  const judged = matched + missed;
  return {
    marked: given.length,
    matched,
    missed,
    notApplicable: given.filter((mark) => mark === 'not-applicable').length,
    judged,
    matchRate: rate(matched, judged),
  };
}
