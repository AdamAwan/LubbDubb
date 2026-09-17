import type { JSX } from 'react';
import type { PredictionAggregate, PredictionSlot } from '../types.js';

// → docs/spec/17-cockpit.md

type SlotFigures = PredictionAggregate['slots'][number];
type MomentFigures = NonNullable<SlotFigures['plan']>;
type Rate = PredictionAggregate['coverageRate'];

/**
 * The four slots, named for the aggregate's register rather than the composer's.
 * The map is a `Record` over the slot union, so a fifth slot is a typecheck here
 * rather than a row that quietly draws nothing.
 */
const SLOT_LABEL: Record<PredictionSlot, string> = {
  locus: 'Where it lives',
  cause: 'The cause, or the approach',
  hard: 'What would be hard',
  surprise: 'What would have surprised you',
};

const SLOT_ORDER: readonly PredictionSlot[] = ['locus', 'cause', 'hard', 'surprise'];

/**
 * The two moments, labelled as the two different questions they are. The card on
 * the goal page labels them the same way and for the same reason: the marks share
 * one vocabulary and nothing else, and a figure whose reader cannot say which
 * question it answered is a figure that means nothing.
 * → docs/proposals/prediction-record-and-criteria-integrity.md §2.4
 */
const MOMENTS: readonly { key: 'plan' | 'outcome'; ordinal: string; ask: string; about: string }[] = [
  { key: 'plan', ordinal: 'Moment one', ask: 'Did you call it?', about: 'your reading of the system' },
  { key: 'outcome', ordinal: 'Moment two', ask: 'Was the plan right?', about: 'the plan' },
];

/**
 * The whole-history fold over the prediction record.
 *
 * Two rules carry this tab and everything on it is arranged around them. A rate
 * the server withheld is drawn as the **count toward the threshold** and never as
 * a figure — not 0%, not a dash — because the withholding exists precisely so that
 * nothing here can be read as a measurement it is not. And the counts, which are
 * never withheld, lead: they are facts at any n, and they are the figures that
 * matter first anyway.
 * → docs/proposals/prediction-record-and-criteria-integrity.md §2.5
 *
 * Nothing on it is keyed on a person, and there is no control that could be. The
 * payload carries no author to group by — `predictionFacts` drops it with the slot
 * text — and that is the shape rather than an omission. → §5
 */
export function PredictionTab({ aggregate }: { aggregate: PredictionAggregate }): JSX.Element {
  const { goals, criteriaDrift } = aggregate;
  if (goals.offered === 0 && goals.notOffered === 0) {
    return (
      <p className="empty">
        No goal has been planned yet, so the reveal gate has never been put to you and there is nothing to fold.
      </p>
    );
  }
  return (
    <div className="pred">
      <p className="pred-lede">
        The whole record, not the window above — a prediction is written once and marked once, so the fold is over every
        goal rather than over a span of hours. Nothing here is grouped by author, and no word of what you wrote reaches
        it.
      </p>

      <section className="pred-block">
        <h3>What happened at the gate</h3>
        <p className="pred-note">
          Three outcomes, not two. A goal the gate was put to either carries a prediction or was declined; a goal the
          gate was never put to is neither, and folding it into the declines would report a decline rate you never
          earned.
        </p>
        <div className="pred-figures">
          <Figure value={goals.offered} label="goals offered the gate" />
          <Figure value={goals.predicted} label="predicted" />
          <Figure value={goals.declined} label="declined" />
        </div>
        <p className="pred-apart">
          <b>{goals.notOffered}</b> planned {goals.notOffered === 1 ? 'goal was' : 'goals were'}{' '}
          <b>never offered the gate</b> — which is what every goal from before the switch reads as, permanently. They
          are not declines, and they are in neither rate below.
        </p>
        <div className="pred-rates">
          <RateFigure
            rate={aggregate.coverageRate}
            over="goals offered the gate"
            label="of the goals offered carried a prediction"
            fallbackCount={goals.offered}
            fallbackNoun={goals.offered === 1 ? 'goal offered the gate' : 'goals offered the gate'}
            threshold={aggregate.threshold}
          />
          <RateFigure
            rate={aggregate.declineRate}
            over="goals offered the gate"
            label="of the goals offered were declined"
            fallbackCount={goals.offered}
            fallbackNoun={goals.offered === 1 ? 'goal offered the gate' : 'goals offered the gate'}
            threshold={aggregate.threshold}
          />
        </div>
      </section>

      <section className="pred-block">
        <h3>How many records have been marked</h3>
        <p className="pred-note">
          The two moments are marked separately and neither implies the other, so they are counted apart.
        </p>
        <div className="pred-figures">
          <Figure value={goals.planMarked} label="marked at moment one — did you call it?" />
          <Figure value={goals.outcomeMarked} label="marked at moment two — was the plan right?" />
        </div>
      </section>

      {SLOT_ORDER.map((slot) => (
        <SlotBlock
          key={slot}
          slot={slot}
          figures={aggregate.slots.find((entry) => entry.slot === slot) ?? null}
          threshold={aggregate.threshold}
        />
      ))}

      <section className="pred-block">
        <h3>Acceptance criteria that changed after the fact</h3>
        <p className="pred-note">
          A count, never a rate: drift is a thing that happened, and every one of them is worth reading on its own goal.
        </p>
        <div className="pred-figures">
          <Figure value={criteriaDrift.records} label="recorded changes" strong={criteriaDrift.records > 0} />
          <Figure value={criteriaDrift.goals} label="goals they fall on" />
        </div>
      </section>
    </div>
  );
}

/**
 * One slot, at both moments. A slot with no entry in the payload is **absent** —
 * nothing has ever filled it — and is said so rather than drawn as a row of
 * zeroes, which is the reading a slot added next year would otherwise get on every
 * goal that predates it.
 */
function SlotBlock({
  slot,
  figures,
  threshold,
}: {
  slot: PredictionSlot;
  figures: SlotFigures | null;
  threshold: number;
}): JSX.Element {
  return (
    <section className="pred-block">
      <h3>{SLOT_LABEL[slot]}</h3>
      {figures === null ? (
        <p className="pred-absent">
          No prediction has ever filled this slot, so there is nothing to count here. Absent, not nought.
        </p>
      ) : (
        <>
          <div className="pred-figures">
            <Figure value={figures.filled} label="predictions filled it" />
          </div>
          <div className="pred-moments">
            {MOMENTS.map((moment) => (
              <Moment
                key={moment.key}
                ordinal={moment.ordinal}
                ask={moment.ask}
                about={moment.about}
                figures={figures[moment.key]}
                threshold={threshold}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function Moment({
  ordinal,
  ask,
  about,
  figures,
  threshold,
}: {
  ordinal: string;
  ask: string;
  about: string;
  figures: MomentFigures | null;
  threshold: number;
}): JSX.Element {
  return (
    <div className="pred-moment">
      <h4>
        {ordinal} · {ask} <span className="pred-about">about {about}</span>
      </h4>
      {figures === null ? (
        <p className="pred-absent">Nobody has answered this moment on this slot. Absent, not nought.</p>
      ) : (
        <>
          <div className="pred-figures">
            <Figure value={figures.marked} label="marked" />
            <Figure value={figures.matched} label="matched" />
            <Figure value={figures.missed} label="missed" />
            <Figure value={figures.notApplicable} label="the plan was silent" />
          </div>
          <RateFigure
            rate={figures.matchRate}
            over="marks that were a judgement"
            label="of the marks that judged were a match"
            fallbackCount={figures.judged}
            fallbackNoun={figures.judged === 1 ? 'mark judged' : 'marks judged'}
            threshold={threshold}
          />
        </>
      )}
    </div>
  );
}

/**
 * A rate, or the sentence that stands where one is not yet a measurement.
 *
 * The withheld arm draws the count toward the threshold — "4 goals marked; rates
 * appear at 10" — which is a true statement about the record and not a rate. There
 * is no arm that renders `null` as a number, a nought or a dash: the server
 * withheld it so that this component could not, and the client holds no branch
 * that could reconstruct it.
 */
function RateFigure({
  rate,
  over,
  label,
  fallbackCount,
  fallbackNoun,
  threshold,
}: {
  rate: Rate;
  over: string;
  label: string;
  fallbackCount: number;
  fallbackNoun: string;
  threshold: number;
}): JSX.Element {
  if (rate === null) {
    return (
      <p className="pred-withheld">
        <b>
          {fallbackCount} {fallbackNoun}
        </b>
        ; rates appear at {threshold}.
      </p>
    );
  }
  return (
    <div className="pred-rate">
      <span className="pred-rate-v">{Math.round(rate.rate * 100)}%</span>
      {/* The n, always, and beside the figure rather than under it: a percentage
          on its own is the reading this tab exists not to give. */}
      <span className="pred-rate-l">
        {label} — over {rate.n} {over}
      </span>
    </div>
  );
}

function Figure({ value, label, strong }: { value: number; label: string; strong?: boolean }): JSX.Element {
  return (
    <div className={`pred-figure${strong === true ? ' is-loud' : ''}`}>
      <span className="pred-figure-v">{value}</span>
      <span className="pred-figure-l">{label}</span>
    </div>
  );
}
