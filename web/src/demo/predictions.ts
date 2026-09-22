import type { GoalPrediction, GoalReveal, PredictionAggregate, PredictionMark, PredictionSlot } from '../types.js';

// → docs/spec/17-cockpit.md#demo-mode

const SLOTS: readonly PredictionSlot[] = ['locus', 'cause', 'split', 'avoid'];

/** The fixtures' own clock, so a seeded row reads as minutes old rather than as 1970. */
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

/**
 * A seeded row of the record: which slots were written, and how each was marked at
 * each of the two moments.
 *
 * `w` is written and `.` is skipped; a mark is `m` matched, `x` missed, `n` the plan
 * being silent, and `.` **unmarked**, which is a fourth value the aggregate counts
 * separately and never as a miss. The four characters are the four slots in the
 * order the composer asks them.
 */
type Seed = readonly [issue: number, written: string, plan: string, outcome: string];

/**
 * The record the demo deployment has built up, and it is deliberately larger than
 * the world the snapshot ships.
 *
 * A snapshot carries the plans of work that is live; the prediction record is over
 * everything the gate was ever put to, so fourteen reveals beside three plans is
 * what a deployment some months in actually looks like. The numbers below 300 are
 * Inkwell work that closed before this snapshot's window — the same shop, earlier.
 *
 * The shape of the seed is chosen so the panel is worth reading: `locus`, `cause`
 * and `split` clear the ten-goal threshold and draw a rate, `avoid` does not and
 * draws the count toward it instead, and moment two lags moment one everywhere
 * because it is asked at delivery. Two goals were offered the gate and declined it,
 * which is the third outcome the aggregate exists to keep apart from never offered.
 */
const SEED: readonly Seed[] = [
  [395, 'wwww', 'mmxn', 'mm.n'],
  [390, 'www.', 'mx..', '....'],
  [364, 'wwww', 'mmmx', 'mx..'],
  [382, 'www.', 'xmx.', '..m.'],
  [345, 'wwww', 'mxmm', 'm...'],
  [359, 'wwww', 'mmxx', '....'],
  [352, 'www.', 'nxm.', '....'],
  [296, 'wwww', 'mmmm', 'mmm.'],
  [291, 'www.', 'xnx.', '....'],
  [284, 'wwww', 'mxxn', '....'],
  [279, 'www.', 'mmx.', '....'],
  [268, 'wwww', 'xmmx', '..x.'],
];

/** The two goals that met the gate and chose not to predict. A decline is a row, and never an absence. */
const DECLINED: readonly number[] = [371, 271];

/**
 * What the historic rows say. One line per slot rather than one per goal: no surface
 * draws them — their goals closed before this snapshot's window — and four sentences
 * of invented hindsight per goal would be fixture nobody can read and nobody can
 * check.
 */
const HISTORIC: Readonly<Record<PredictionSlot, string>> = {
  locus: 'Somewhere in the basket, not the catalogue.',
  cause: 'A cheap guard in the wrong layer — the fix belongs one call earlier.',
  split: 'One part for the guard itself, a second for the rows already written under the old shape.',
  avoid: 'Nothing should touch the catalogue, and no existing basket should need migrating.',
};

/** The two goals a visitor can actually open, which is where slot text is read. */
const WRITTEN: Readonly<Record<number, Partial<Record<PredictionSlot, string>>>> = {
  395: {
    locus: 'The refund path — the order and the provider are both updated there, and nothing else is.',
    cause: 'The ledger is written overnight from the orders table, which cannot tell a refund from an unpaid order.',
    split: 'One part to write refunds into the ledger, a second to reconcile the month that is already wrong.',
    avoid: 'The nightly job should not be rewritten, and no historic ledger row should be edited in place.',
  },
  390: {
    locus: 'The four checkout routes — each one builds its own charge request today.',
    cause: 'There is no one place a card is charged, so the routes and the refund path disagree.',
    split: 'One part for the shared charge call, then one route moved per part after it.',
  },
};

const MARKS: Readonly<Record<string, PredictionMark | null>> = {
  m: 'matched',
  x: 'missed',
  n: 'not-applicable',
  '.': null,
};

function slotsOf(issue: number, written: string): Record<PredictionSlot, string | null> {
  const text = {} as Record<PredictionSlot, string | null>;
  SLOTS.forEach((slot, at) => {
    const given = WRITTEN[issue]?.[slot] ?? HISTORIC[slot];
    text[slot] = written[at] === 'w' ? given : null;
  });
  return text;
}

function marksOf(coded: string): Record<PredictionSlot, PredictionMark | null> {
  const marks = {} as Record<PredictionSlot, PredictionMark | null>;
  SLOTS.forEach((slot, at) => {
    marks[slot] = MARKS[coded[at] ?? '.'] ?? null;
  });
  return marks;
}

function answered(marks: Readonly<Record<PredictionSlot, PredictionMark | null>>): boolean {
  return SLOTS.some((slot) => marks[slot] !== null);
}

const EMPTY_MARKS = (): Record<PredictionSlot, PredictionMark | null> => marksOf('....');

/**
 * The demo's prediction record: the reveal stamps, the predictions and both sets of
 * marks, held the way the real store holds them so that every press on the gate and
 * on the marking card commits.
 *
 * It is its own module rather than more of `demoBackend`, because the fold at the
 * bottom is a second implementation of `buildPredictionAggregate` and has to be read
 * against it. It cannot be the first one: `src/insights/` is a server module, and
 * `src/wire.ts` is the only one `web/src/` may name.
 */
export class DemoPredictions {
  private readonly predictions = new Map<string, GoalPrediction>();
  private readonly reveals = new Map<string, GoalReveal>();
  private seq = 0;

  constructor() {
    SEED.forEach(([issue, written, plan, outcome], at) => {
      const originRef = `issue:${issue}`;
      const planMarks = marksOf(plan);
      const outcomeMarks = marksOf(outcome);
      const when = ago(2_000 + at * 400);
      this.reveals.set(originRef, { originRef, revealedAt: when, predicted: true });
      this.predictions.set(originRef, {
        id: `pred-${issue}`,
        originRef,
        author: null,
        slots: slotsOf(issue, written),
        planMarks,
        planMarkedAt: answered(planMarks) ? ago(1_800 + at * 400) : null,
        outcomeMarks,
        outcomeMarkedAt: answered(outcomeMarks) ? ago(600 + at * 120) : null,
        createdAt: when,
        updatedAt: when,
      });
    });
    DECLINED.forEach((issue, at) => {
      const originRef = `issue:${issue}`;
      this.reveals.set(originRef, { originRef, revealedAt: ago(1_500 + at * 700), predicted: false });
    });
  }

  reading(issue: number): { prediction: GoalPrediction | null; reveal: GoalReveal | null } {
    const originRef = `issue:${issue}`;
    return { prediction: this.predictions.get(originRef) ?? null, reveal: this.reveals.get(originRef) ?? null };
  }

  revealed(issue: number): boolean {
    return this.reveals.has(`issue:${issue}`);
  }

  /** The stamp that ends the offer. First press wins, exactly as the row's primary key makes it. */
  stampReveal(issue: number): GoalReveal {
    const originRef = `issue:${issue}`;
    const standing = this.reveals.get(originRef);
    if (standing) return standing;
    const reveal: GoalReveal = {
      originRef,
      revealedAt: ago(0),
      predicted: this.predictions.has(originRef),
    };
    this.reveals.set(originRef, reveal);
    return reveal;
  }

  /**
   * The prediction, written before the stamp. Refused after it for the reason the
   * whole record rests on: what is written once the plan has been read is hindsight,
   * and a store that accepted it would be keeping a column it could not defend.
   */
  record(issue: number, slots: Partial<Record<PredictionSlot, string>>): GoalPrediction {
    const originRef = `issue:${issue}`;
    if (this.reveals.has(originRef)) throw new Error('this plan has been revealed, so a prediction is hindsight now');
    if (this.predictions.has(originRef)) throw new Error('this goal already carries a prediction — it is written once');
    const text = {} as Record<PredictionSlot, string | null>;
    for (const slot of SLOTS) {
      const written = slots[slot]?.trim() ?? '';
      text[slot] = written === '' ? null : written;
    }
    if (SLOTS.every((slot) => text[slot] === null)) {
      throw new Error('every slot is skippable, but not all four');
    }
    const now = ago(0);
    const prediction: GoalPrediction = {
      id: `pred-demo-${++this.seq}`,
      originRef,
      author: null,
      slots: text,
      planMarks: EMPTY_MARKS(),
      planMarkedAt: null,
      outcomeMarks: EMPTY_MARKS(),
      outcomeMarkedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.predictions.set(originRef, prediction);
    return prediction;
  }

  /**
   * One moment's marks, merged. A press names its own slot and leaves the other
   * three as they stand, and a mark of null takes a slot back to unmarked — which is
   * a state an operator can reach on purpose, not a failure to answer.
   */
  mark(
    issue: number,
    marks: Partial<Record<PredictionSlot, PredictionMark | null>>,
    moment: 'plan' | 'outcome',
  ): GoalPrediction {
    const originRef = `issue:${issue}`;
    const standing = this.predictions.get(originRef);
    if (!standing) throw new Error('there is no prediction on this goal to mark');
    if (!this.reveals.has(originRef))
      throw new Error('this goal has not been revealed, so there is nothing to mark against');
    const key = moment === 'plan' ? 'planMarks' : 'outcomeMarks';
    const next = { ...standing[key] } as Record<PredictionSlot, PredictionMark | null>;
    for (const slot of SLOTS) if (slot in marks) next[slot] = marks[slot] ?? null;
    const stamp = answered(next) ? ago(0) : null;
    const updated: GoalPrediction = {
      ...standing,
      ...(moment === 'plan'
        ? { planMarks: next, planMarkedAt: stamp }
        : { outcomeMarks: next, outcomeMarkedAt: stamp }),
      updatedAt: ago(0),
    };
    this.predictions.set(originRef, updated);
    return updated;
  }

  /**
   * The fold, over the record as it stands — so a visitor who predicts on the gate
   * and then opens this panel sees their own goal in the counts.
   *
   * It never reaches the slot text, and the narrowing is the containment invariant
   * made structural rather than promised: a slot is a boolean here.
   * → docs/spec/18-observability.md
   */
  aggregate(plannedGoals: readonly string[], threshold: number, now: number): PredictionAggregate {
    const rate = (numerator: number, n: number) => (n >= threshold && n > 0 ? { rate: numerator / n, n } : null);
    const facts = [...this.predictions.values()];
    const revealed = new Set(this.reveals.keys());
    const offered = revealed.size;
    const predicted = [...revealed].filter((ref) => this.predictions.has(ref)).length;

    const moment = (marks: readonly (PredictionMark | null)[]) => {
      const given = marks.filter((mark): mark is PredictionMark => mark !== null);
      if (given.length === 0) return null;
      const matched = given.filter((mark) => mark === 'matched').length;
      const missed = given.filter((mark) => mark === 'missed').length;
      return {
        marked: given.length,
        matched,
        missed,
        notApplicable: given.filter((mark) => mark === 'not-applicable').length,
        judged: matched + missed,
        matchRate: rate(matched, matched + missed),
      };
    };

    return {
      generatedAt: new Date(now).toISOString(),
      threshold,
      goals: {
        offered,
        predicted,
        declined: offered - predicted,
        notOffered: new Set(plannedGoals.filter((ref) => !revealed.has(ref))).size,
        planMarked: facts.filter((fact) => answered(fact.planMarks)).length,
        outcomeMarked: facts.filter((fact) => answered(fact.outcomeMarks)).length,
      },
      coverageRate: rate(predicted, offered),
      declineRate: rate(offered - predicted, offered),
      slots: SLOTS.flatMap((slot) => {
        const filled = facts.filter((fact) => fact.slots[slot] !== null);
        if (filled.length === 0) return [];
        return [
          {
            slot,
            filled: filled.length,
            plan: moment(filled.map((fact) => fact.planMarks[slot])),
            outcome: moment(filled.map((fact) => fact.outcomeMarks[slot])),
          },
        ];
      }),
      /* The demo holds no goal-level criteria, so nothing has drifted. Zero is the
         honest reading here rather than an absence: the record exists and is empty. */
      criteriaDrift: { records: 0, goals: 0 },
    };
  }
}
