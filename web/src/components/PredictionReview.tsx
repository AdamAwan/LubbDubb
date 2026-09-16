import { useEffect, useState, type JSX } from 'react';
import { api, type GoalPredictionReading } from '../api.js';
import type { PlanPart, PlanView, PredictionMark, PredictionSlot } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { renderMarkdown } from './markdown.js';
import { relTime } from './util.js';

// → docs/spec/17-cockpit.md

/** The four slots in the order the composer asked them, each with its question. */
const SLOTS: readonly { key: PredictionSlot; question: string }[] = [
  { key: 'locus', question: 'Where did you think this lives?' },
  { key: 'cause', question: 'What did you think the cause / approach is?' },
  { key: 'hard', question: 'What did you think would be hard?' },
  { key: 'surprise', question: 'What would have surprised you?' },
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

const STATE_LABEL: Record<PredictionMark, string> = {
  matched: 'Matched',
  missed: 'Missed',
  'not-applicable': 'The plan is silent on this',
};

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
 * Moment one — "did I predict the plan?" — drawn where the gate stood. The plan is
 * beside the prediction because the operator cannot answer without both in front of
 * them, and the card is keyed off the record rather than off the press that made it:
 * a prediction exists and the goal is revealed, so an operator who closed the tab
 * before marking finds it waiting rather than gone.
 *
 * `revealed` is a dependency of the fetch and not a condition on it, so the reveal
 * the gate has just performed pulls the record down without a remount.
 */
export function PredictionReview({
  issueNumber,
  revealed,
  plan,
  parts,
  now,
}: {
  issueNumber: number;
  revealed: boolean;
  plan: PlanView | null;
  parts: readonly PlanPart[];
  now: number;
}): JSX.Element | null {
  const [reading, setReading] = useState<GoalPredictionReading | null>(null);

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

  const panes =
    plan === null
      ? []
      : PLAN_PANES.flatMap((pane) => {
          const body = pane.read(plan)?.trim() ?? '';
          return body === '' ? [] : [{ label: pane.label, body }];
        });

  return (
    <div className="cn-pmark">
      <div className="cn-pmark-said">
        <h4>What you predicted</h4>
        <p className="cn-pmark-why">
          You wrote this before the plan was lifted. Mark each line against what the plan actually says — a line you
          leave alone stays unmarked, which is its own answer and never counted as a miss.
          {prediction.planMarkedAt !== null && <> Last marked {relTime(prediction.planMarkedAt, now)}.</>}
        </p>
        {SLOTS.map(({ key, question }) => {
          const said = prediction.slots[key];
          const mark = prediction.planMarks[key];
          if (said === null)
            return (
              <div className="cn-pmark-row is-skipped" key={key}>
                <div className="cn-pmark-q">{question}</div>
                <p className="cn-pmark-skipped">Skipped — nothing was written here, so there is nothing to mark.</p>
              </div>
            );
          return (
            <div className={`cn-pmark-row ${mark === null ? 'is-unmarked' : `is-${mark}`}`} key={key}>
              <div className="cn-pmark-q">
                {question}
                {mark === null ? (
                  <i className="cn-pmark-state is-open">Not marked yet</i>
                ) : (
                  <i className="cn-pmark-state">{STATE_LABEL[mark]}</i>
                )}
              </div>
              <blockquote className="cn-pmark-said-text">{said}</blockquote>
              <div className="cn-pmark-marks" role="group" aria-label={`How the plan stood against: ${question}`}>
                {MARKS.map((option) => (
                  <AsyncButton
                    key={option.mark}
                    size="small"
                    ghost
                    className={`cn-pmark-mark ${mark === option.mark ? 'is-on' : ''}`}
                    aria-pressed={mark === option.mark}
                    title={
                      mark === option.mark
                        ? `${option.why}. Press again to take the mark off and leave this unmarked.`
                        : option.why
                    }
                    onClick={() => write(key, mark === option.mark ? null : option.mark)}
                  >
                    {option.label}
                  </AsyncButton>
                ))}
              </div>
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
  );
}
