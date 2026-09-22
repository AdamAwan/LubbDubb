import { useEffect, useRef, useState, type JSX } from 'react';
import { api, type GoalPredictionReading } from '../api.js';
import type { PlanPart, PlanView, PredictionMark, PredictionOutcomeMarks, PredictionSlot } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { renderMarkdown } from './markdown.js';
import { relTime } from './util.js';

// → docs/spec/17-cockpit.md

/** The four slots in the order the composer asked them, each with its question. */
const SLOTS: readonly { key: PredictionSlot; question: string }[] = [
  { key: 'locus', question: 'Where did you think this lives?' },
  { key: 'cause', question: 'What did you think the cause / approach is?' },
  { key: 'split', question: 'How did you think this should be split up?' },
  { key: 'avoid', question: 'What did you say should not happen?' },
];

/**
 * The three marks, each labelled as the judgement it is. `not-applicable` is worded
 * so that it reads as a statement about the plan — it did not go near this — rather
 * than as a way of not answering. Not answering is what leaving the row alone is,
 * and that is a fourth state the aggregate counts separately.
 */
const MARKS: readonly { mark: PredictionMark; label: string; why: string }[] = [
  { mark: 'matched', label: 'Matched', why: 'The plan says what you said it would' },
  { mark: 'missed', label: 'Missed', why: 'The plan says something else' },
  {
    mark: 'not-applicable',
    label: 'Plan is silent',
    why: 'The plan did not speak to this at all, so there was nothing for it to match or miss',
  },
];

/**
 * Moment two's three marks, worded for the question moment two asks. The mark
 * vocabulary is the same three values, and that is exactly why the words must not
 * be: `matched` here is the *plan* bearing out, not the operator having called it,
 * and two rows of buttons reading "Matched / Missed" would leave a record nobody
 * can say which question they answered.
 */
const OUTCOME_MARKS: readonly { mark: PredictionMark; label: string; why: string }[] = [
  { mark: 'matched', label: 'Held up', why: 'Delivery bore the plan out on this' },
  { mark: 'missed', label: 'Did not hold', why: 'Delivery went the other way — the plan was wrong here' },
  {
    mark: 'not-applicable',
    label: 'Never came up',
    why: 'Delivery never went near this, so there was nothing for the plan to be right or wrong about',
  },
];

/**
 * `avoid` asks for a thing the operator expects *not* to see, and the three marks
 * above are written for the three slots that ask for a thing they expect to see.
 * Read against a prohibition, "The plan says what you said it would" runs both ways
 * at once — did the plan do the thing, or did it honour the ban? — and an operator
 * who reads it the second way files the exact opposite of what they mean, in the one
 * record that cannot be corrected by asking them later. So the slot carries its own
 * words. The stored value is the same three-valued mark: `matched` is the operator's
 * reading borne out, which here is the plan staying clear.
 * → docs/spec/17-cockpit.md#a-slot-that-asks-for-a-thing-that-should-not-happen
 */
const AVOID_MARKS: readonly { mark: PredictionMark; label: string; why: string }[] = [
  { mark: 'matched', label: 'Stayed clear', why: 'The plan does not do the thing you said should not happen' },
  { mark: 'missed', label: 'The plan does it', why: 'The plan does the thing you said should not happen' },
  {
    mark: 'not-applicable',
    label: 'Plan is silent',
    why: 'The plan does not go near this either way, so there was nothing for it to keep clear of',
  },
];

/** Moment two's words for the same slot: delivery either kept clear of it or did not. */
const AVOID_OUTCOME_MARKS: readonly { mark: PredictionMark; label: string; why: string }[] = [
  { mark: 'matched', label: 'Stayed clear', why: 'Delivery never did the thing you said should not happen' },
  { mark: 'missed', label: 'It happened anyway', why: 'Delivery did it — the plan did not keep clear of it' },
  {
    mark: 'not-applicable',
    label: 'Never came up',
    why: 'Delivery never went near this, so there was nothing for the plan to keep clear of',
  },
];

const STATE_LABEL: Record<PredictionMark, string> = {
  matched: 'Matched',
  missed: 'Missed',
  'not-applicable': 'The plan is silent on this',
};

const OUTCOME_STATE_LABEL: Record<PredictionMark, string> = {
  matched: 'The plan held up',
  missed: 'The plan did not hold',
  'not-applicable': 'It never came up',
};

const AVOID_STATE_LABEL: Record<PredictionMark, string> = {
  matched: 'The plan stays clear',
  missed: 'The plan does it',
  'not-applicable': 'The plan is silent on this',
};

const AVOID_OUTCOME_STATE_LABEL: Record<PredictionMark, string> = {
  matched: 'It stayed clear',
  missed: 'It happened anyway',
  'not-applicable': 'It never came up',
};

/**
 * Which wording a slot's two controls carry. Only `avoid` departs, and it departs on
 * both moments at once: a slot drawn with one moment's words and the other's default
 * would leave a record whose two halves were answered to two different questions.
 */
function wordingFor(slot: PredictionSlot): {
  options: readonly { mark: PredictionMark; label: string; why: string }[];
  state: Record<PredictionMark, string>;
  outcomeOptions: readonly { mark: PredictionMark; label: string; why: string }[];
  outcomeState: Record<PredictionMark, string>;
} {
  return slot === 'avoid'
    ? {
        options: AVOID_MARKS,
        state: AVOID_STATE_LABEL,
        outcomeOptions: AVOID_OUTCOME_MARKS,
        outcomeState: AVOID_OUTCOME_STATE_LABEL,
      }
    : { options: MARKS, state: STATE_LABEL, outcomeOptions: OUTCOME_MARKS, outcomeState: OUTCOME_STATE_LABEL };
}

/**
 * The two moments' answers said back as one sentence, drawn only where both have
 * been answered. It derives nothing the server does not hold — it restates the two
 * marks in the order they were asked — because the reading worth having is the
 * *pair*, and a pair split across two rows of buttons is a pair nobody reads.
 * `apart` is the pair where the operator's reading and the plan's came out
 * differently, which is the row the record exists for; it is a property of the two
 * marks, not a verdict of its own.
 * → docs/proposals/prediction-record-and-criteria-integrity.md
 */
const PAIRINGS: Readonly<Record<string, { said: string; apart: boolean }>> = {
  'missed/missed': {
    said: 'You read this differently from the plan, and the plan did not hold.',
    apart: true,
  },
  'matched/missed': {
    said: 'You read this the way the plan did, and the plan did not hold.',
    apart: true,
  },
  'missed/matched': { said: 'You read this differently from the plan, and the plan held up.', apart: false },
  'matched/matched': { said: 'You read this the way the plan did, and the plan held up.', apart: false },
};

function pairingOf(
  plan: PredictionMark | null,
  outcome: PredictionMark | null,
): { said: string; apart: boolean } | null {
  if (plan === null || outcome === null) return null;
  return PAIRINGS[`${plan}/${outcome}`] ?? null;
}

/**
 * The plan in the operator's own reading order. Each pane names the field it reads
 * rather than indexing one, so a field that is renamed is a typecheck rather than a
 * pane that silently empties.
 */
const PLAN_PANES: readonly { label: string; read: (plan: PlanView) => string | null }[] = [
  { label: 'The diagnosis', read: (plan) => plan.diagnosis },
  { label: 'The approach', read: (plan) => plan.approach },
  { label: 'Why this shape', read: (plan) => plan.reason },
  { label: 'Risks', read: (plan) => plan.risks },
  { label: 'Out of scope', read: (plan) => plan.outOfScope },
  { label: 'Open questions', read: (plan) => plan.openQuestions },
];

/**
 * The card both moments are answered on. Moment one — "did I predict the plan?" —
 * is drawn where the gate stood. Moment two — "was the plan right?" — is the same
 * four slots asked a different question, and joins the card once delivery has asked
 * it. They are *labelled* apart rather than merely stacked: the two moments share a
 * mark vocabulary and nothing else, and a record whose reader cannot say which
 * question a mark answered is a record that means nothing.
 * → docs/proposals/prediction-record-and-criteria-integrity.md §2.4
 *
 * The plan is beside the prediction because the operator cannot answer without both
 * in front of them, and the card is keyed off the record rather than off the press
 * that made it: a prediction exists and the goal is revealed, so an operator who
 * closed the tab before marking finds it waiting rather than gone.
 *
 * `revealed` is a dependency of the fetch and not a condition on it, so the reveal
 * the gate has just performed pulls the record down without a remount.
 */
export function PredictionReview({
  issueNumber,
  revealed,
  outcomeAsked,
  plan,
  parts,
  open,
  settled,
  onToggle,
  now,
}: {
  issueNumber: number;
  revealed: boolean;
  outcomeAsked: boolean;
  plan: PlanView | null;
  parts: readonly PlanPart[];
  open: boolean;
  /** Whether `open` is the operator's own answer rather than the page's default. */
  settled: boolean;
  onToggle: (open: boolean) => void;
  now: number;
}): JSX.Element | null {
  const [reading, setReading] = useState<GoalPredictionReading | null>(null);
  /* Latched at the first reading rather than read live: the panel narrowing its own
     default is a decision about how the page arrives, and one taken again on every
     answer would shut the card under the operator as they marked the last slot.
     → docs/spec/17-cockpit.md#where-the-prediction-is-drawn */
  const arrivedAnswered = useRef<boolean | null>(null);

  useEffect(() => {
    let live = true;
    const settle = (next: GoalPredictionReading | null): void => {
      if (live) setReading(next);
    };
    void api
      .getGoalPrediction(issueNumber)
      .then((answer) => settle(answer))
      .catch(() => settle(null));
    return () => {
      live = false;
    };
  }, [issueNumber, revealed]);

  const prediction = reading?.prediction ?? null;
  if (prediction === null || (reading?.reveal ?? null) === null) return null;

  const write = async (slot: PredictionSlot, next: PredictionMark | null): Promise<void> => {
    const answer = await api.markGoalPrediction(issueNumber, { [slot]: next });
    setReading((prev) => (prev === null ? prev : { ...prev, prediction: answer.prediction }));
  };

  const writeOutcome = async (slot: PredictionSlot, next: PredictionMark | null): Promise<void> => {
    const answer = await api.markGoalPredictionOutcome(issueNumber, { [slot]: next });
    setReading((prev) => (prev === null ? prev : { ...prev, prediction: answer.prediction }));
  };

  /* Asked, or answered before: a record that carries moment two goes on drawing it
     once the bench row it was asked through has been closed. Neither is a default —
     a goal nobody has been asked about draws moment one alone. */
  const outcomeMarks: PredictionOutcomeMarks = prediction.outcomeMarks;
  const showOutcome = outcomeAsked || prediction.outcomeMarkedAt !== null;

  const panes =
    plan === null
      ? []
      : PLAN_PANES.flatMap((pane) => {
          const body = pane.read(plan)?.trim() ?? '';
          return body === '' ? [] : [{ label: pane.label, body }];
        });

  const marked = SLOTS.filter(({ key }) => prediction.slots[key] !== null && prediction.planMarks[key] !== null).length;
  const askedOf = SLOTS.filter(({ key }) => prediction.slots[key] !== null).length;

  /* Nothing in here is still the operator's to do: every slot they wrote is marked
     against the plan, and moment two is either unasked or answered. The page's
     default opens this card where the prediction is the live question; once it has
     been answered it is a record, and a record arrives folded. */
  const answered = marked === askedOf && (!showOutcome || prediction.outcomeMarkedAt !== null);
  if (arrivedAnswered.current === null) arrivedAnswered.current = answered;
  const showing = settled ? open : open && arrivedAnswered.current === false;

  return (
    <div className="cn-pmark-fold">
      {/* The disclosure is the panel's own, as the work record's is: only this
          component knows whether there is a prediction to draw at all, and a
          heading drawn outside it would be an empty card on every goal nobody
          predicted. The count is drawn closed as well as open, because what a
          folded record owes its reader is whether anything in it is unanswered.
          → docs/spec/17-cockpit.md#where-the-prediction-is-drawn */}
      <h4 className="cn-pmark-hdr">
        <button type="button" className="cn-disc" aria-expanded={showing} onClick={() => onToggle(!showing)}>
          <i className="cn-caret">{showing ? '\u25be' : '\u25b8'}</i>
          What you predicted
        </button>
        {askedOf > 0 && (
          <i className="cn-n">
            {marked}/{askedOf} marked
          </i>
        )}
        {showOutcome && prediction.outcomeMarkedAt === null && <i className="cn-n">outcome unanswered</i>}
      </h4>
      {showing && (
        <div className="cn-pmark">
          <div className="cn-pmark-said">
            <p className="cn-pmark-why">
              You wrote this before the plan was lifted. Mark each line against what the plan actually says — a line you
              leave alone stays unmarked, which is its own answer and never counted as a miss.
              {prediction.planMarkedAt !== null && <> Last marked {relTime(prediction.planMarkedAt, now)}.</>}
            </p>
            {showOutcome && (
              <p className="cn-pmark-why cn-pmark-why-two">
                Delivery has landed, so each line now carries a second, separate question: whether the <em>plan</em>{' '}
                turned out right. It is not the same question as whether you called the plan, and answering one says
                nothing about the other — either may be left alone.
                {prediction.outcomeMarkedAt !== null && <> Last answered {relTime(prediction.outcomeMarkedAt, now)}.</>}
              </p>
            )}
            {SLOTS.map(({ key, question }) => {
              const said = prediction.slots[key];
              const mark = prediction.planMarks[key];
              const outcome = outcomeMarks[key];
              if (said === null)
                return (
                  <div className="cn-pmark-row is-skipped" key={key}>
                    <div className="cn-pmark-q">{question}</div>
                    <p className="cn-pmark-skipped">Skipped — nothing was written here, so there is nothing to mark.</p>
                  </div>
                );
              const pairing = showOutcome ? pairingOf(mark, outcome) : null;
              const wording = wordingFor(key);
              return (
                <div className={`cn-pmark-row ${mark === null ? 'is-unmarked' : `is-${mark}`}`} key={key}>
                  <div className="cn-pmark-q">{question}</div>
                  <blockquote className="cn-pmark-said-text">{said}</blockquote>
                  <Moment
                    moment="one"
                    ask="Did you call it?"
                    about="about your reading of the system"
                    options={wording.options}
                    state={wording.state}
                    unanswered="Not marked yet"
                    question={question}
                    mark={mark}
                    onPick={(next) => write(key, next)}
                  />
                  {showOutcome && (
                    <Moment
                      moment="two"
                      ask="Was the plan right?"
                      about="about the plan, not about you"
                      options={wording.outcomeOptions}
                      state={wording.outcomeState}
                      unanswered="Not answered yet"
                      question={question}
                      mark={outcome}
                      onPick={(next) => writeOutcome(key, next)}
                    />
                  )}
                  {pairing !== null && (
                    <p className={`cn-pmark-pair ${pairing.apart ? 'is-apart' : ''}`}>{pairing.said}</p>
                  )}
                </div>
              );
            })}
          </div>
          <div className="cn-pmark-plan">
            <h4>What the plan says</h4>
            {plan === null && <p className="cn-pmark-skipped">This goal no longer carries a plan to read against.</p>}
            {plan !== null && (
              <>
                <div className="cn-pmark-title">{plan.title}</div>
                {panes.map((pane) => (
                  <div className="cn-pmark-pane" key={pane.label}>
                    <div className="cn-pmark-pane-label">{pane.label}</div>
                    <div className="cn-pmark-prose">{renderMarkdown(pane.body)}</div>
                  </div>
                ))}
                {parts.length > 0 && (
                  <div className="cn-pmark-pane">
                    <div className="cn-pmark-pane-label">The parts</div>
                    <ul className="cn-pmark-parts">
                      {parts.map((part) => (
                        <li key={part.id}>
                          {part.title}
                          {part.touches.length > 0 && <i className="cn-pmark-touches">{part.touches.join(', ')}</i>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {panes.length === 0 && parts.length === 0 && (
                  <p className="cn-pmark-skipped">The plan records no prose and no parts.</p>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One moment's three-way control over one slot, with the question it answers said
 * above it. The label is the whole point: the two moments are the same three marks,
 * and only the wording keeps an operator from answering the wrong one. `null` is
 * drawn as its own state — never pre-selected, and never as a miss.
 */
function Moment({
  moment,
  ask,
  about,
  options,
  state,
  unanswered,
  question,
  mark,
  onPick,
}: {
  moment: 'one' | 'two';
  ask: string;
  about: string;
  options: readonly { mark: PredictionMark; label: string; why: string }[];
  state: Record<PredictionMark, string>;
  unanswered: string;
  question: string;
  mark: PredictionMark | null;
  onPick: (next: PredictionMark | null) => Promise<void>;
}): JSX.Element {
  return (
    <div className={`cn-pmark-moment is-${moment} ${mark === null ? 'is-unmarked' : `is-${mark}`}`}>
      <div className="cn-pmark-moment-q">
        <span className="cn-pmark-moment-ask">{ask}</span>
        <span className="cn-pmark-moment-of">{about}</span>
        {mark === null ? (
          <i className="cn-pmark-state is-open">{unanswered}</i>
        ) : (
          <i className={`cn-pmark-state is-${mark}`}>{state[mark]}</i>
        )}
      </div>
      <div className="cn-pmark-marks" role="group" aria-label={`${ask} — ${question}`}>
        {options.map((option) => (
          <AsyncButton
            key={option.mark}
            size="small"
            ghost
            className={`cn-pmark-mark ${mark === option.mark ? 'is-on' : ''}`}
            aria-pressed={mark === option.mark}
            title={
              mark === option.mark
                ? `${option.why}. Press again to take the answer off and leave this unanswered.`
                : option.why
            }
            onClick={() => onPick(mark === option.mark ? null : option.mark)}
          >
            {option.label}
          </AsyncButton>
        ))}
      </div>
    </div>
  );
}
