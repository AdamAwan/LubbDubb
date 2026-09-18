import { useEffect, useState, type JSX } from 'react';
import { api, type PredictionDraft } from '../api.js';
import { AsyncButton } from './AsyncButton.js';
import { buttonClass } from './button.js';

// → docs/spec/17-cockpit.md

/** The four slots, in the order they are asked, each with the question it asks. */
const SLOTS: readonly { key: keyof PredictionDraft; question: string }[] = [
  { key: 'locus', question: 'Where do I think this lives?' },
  { key: 'cause', question: 'What do I think the cause / approach is?' },
  { key: 'hard', question: 'What do I think will be hard?' },
  { key: 'surprise', question: 'What would surprise me?' },
];

/**
 * Why predicting is worth the interruption, in the gate's own words.
 *
 * Exported because the approval ask carries it too: the rail is where an operator
 * meets this plan first, and a card that says only that the plan is withheld argues
 * nothing — it reads as an obstacle rather than as the offer it is. Two spellings of
 * the one argument is how the gate comes to be resented on one surface and welcomed
 * on the other.
 *
 * @public drawn by `EscalationCard` on a withheld plan's ask
 */
export const PREDICT_WHY =
  'Writing down what you expect before you read it is the only way the record can tell a hunch that was ' +
  'right from one you formed afterwards.';

/**
 * The half of the offer that is about cost, always said last. It is the answer to
 * the question the interruption raises — is the fleet waiting on me — and it is no
 * less true on the ask than it is on the gate.
 *
 * @public drawn by `EscalationCard` on a withheld plan's ask
 */
export const HOLDS_NOTHING_UP = 'It holds nothing up: the fleet is not waiting on this.';

const CONTAINMENT =
  'What you write here is kept from every agent the harness runs — it goes into no prompt, no ' +
  'transcript and no tool answer. The one leak the containment cannot stop is you: paste it into ' +
  "this goal's standing instructions and the fleet reads it.";

/**
 * The criteria field's own note, and the reason it cannot be folded in under
 * {@link CONTAINMENT}. The two records share this moment and have opposite postures:
 * a prediction is withheld from the fleet and criteria are written for it. Drawn as
 * one block, the operator carries whichever posture they read first across to the
 * other field — which either leaks the prediction or buries the criteria.
 */
const REACHES_THE_FLEET =
  'Unlike the prediction above, this is meant to be read: it is the oracle the work is judged ' +
  'against, and where it and a part’s own acceptance disagree, this is the authority. Writing it ' +
  'now, before you have read the plan, is what makes it independent of the plan.';

type Draft = Record<keyof PredictionDraft, string>;

const EMPTY: Draft = { locus: '', cause: '', hard: '', surprise: '' };

function filled(draft: Draft): PredictionDraft {
  const slots: PredictionDraft = {};
  for (const { key } of SLOTS) {
    const text = draft[key].trim();
    if (text !== '') slots[key] = text;
  }
  return slots;
}

/**
 * The gate that stands in front of a plan the operator has not read. Both presses
 * are the same button at the same weight: a gate that is awkward to decline is a
 * gate that gets resented and then disabled outright.
 *
 * It asks for the two records that can only be authored here, because the reveal is
 * the last moment at which either is independent of the plan: the prediction, and
 * the goal's acceptance criteria. Criteria offered only on the goal page are
 * criteria written after the plan has been read, which is the one standing that
 * cannot catch a goal understood wrongly and then built consistently with the wrong
 * understanding.
 *
 * Whether the criteria half is asked at all is keyed off the reading rather than a
 * flag: the routes are mounted only where `goalCriteria.enabled` is on, so a read
 * that does not answer is a deployment with no criteria and the field is not drawn.
 * A goal that already has criteria is not asked again either — revising them is the
 * goal page's job, and a revision is a version with a standing of its own.
 *
 * `onRevealed` lifts the gate on this page at once; the payload refresh behind it
 * carries the parts, which the reveal's own response does not have.
 */
export function PlanRevealGate({
  issueNumber,
  onRevealed,
}: {
  issueNumber: number;
  onRevealed: () => Promise<void> | void;
}): JSX.Element {
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [criteria, setCriteria] = useState('');
  const [asksCriteria, setAsksCriteria] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // What has already landed, so a retry after one half failed does not re-send the
  // half that succeeded. Both writes are once-only in opposite ways — a second
  // prediction is refused outright, a second criteria version is silently v2 — so a
  // press that resent them would either dead-end the gate or mint a version nobody
  // asked for.
  const [landed, setLanded] = useState({ prediction: false, criteria: false });

  useEffect(() => {
    let live = true;
    void api
      .getGoalCriteria(issueNumber)
      .then((reading) => {
        if (live) setAsksCriteria(reading.current === null);
      })
      .catch(() => {
        if (live) setAsksCriteria(false);
      });
    return () => {
      live = false;
    };
  }, [issueNumber]);

  const reveal = async (): Promise<void> => {
    await api.revealGoalPlan(issueNumber);
    await onRevealed();
  };

  /**
   * Everything the operator wrote, then the reveal. Both records are written first
   * and the stamp last, because the stamp is what ends their independence: a
   * prediction after it is refused, and criteria after it are a version that reads
   * `post-reveal` for ever.
   */
  const recordThenReveal = async (): Promise<void> => {
    const slots = filled(draft);
    const text = criteria.trim();
    if (Object.keys(slots).length === 0 && text === '') {
      setRefusal(
        asksCriteria
          ? 'Nothing is written down yet — fill one prediction slot or say what “done” means, and there is a record to keep.'
          : 'Every slot is skippable, but not all four — write one of them and the prediction is a prediction.',
      );
      return;
    }
    setRefusal(null);
    if (Object.keys(slots).length > 0 && !landed.prediction) {
      await api.predictGoal(issueNumber, slots);
      setLanded((was) => ({ ...was, prediction: true }));
    }
    if (text !== '' && !landed.criteria) {
      await api.writeGoalCriteria(issueNumber, { text });
      setLanded((was) => ({ ...was, criteria: true }));
    }
    await reveal();
  };

  return (
    <div className="cn-gate">
      {/* Nothing of the plan is on the wire yet, so what is obscured here is a
          stand-in rather than the document under a blur. */}
      <div className="cn-gate-under" aria-hidden>
        <span />
        <span />
        <span />
        <span />
      </div>
      <div className="cn-gate-over">
        <h4>{asksCriteria ? 'A plan is ready. Anything to write down first?' : 'A plan is ready. Predict first?'}</h4>
        <p className="cn-gate-why">
          {PREDICT_WHY}
          {asksCriteria &&
            ' This is also the last moment at which what you call “done” is your answer and not the plan’s.'}{' '}
          {HOLDS_NOTHING_UP}
        </p>
        {!composing && (
          <div className="cn-gate-presses">
            <button type="button" className={buttonClass({ tone: 'primary' })} onClick={() => setComposing(true)}>
              {asksCriteria ? 'Write these down' : 'Predict'}
            </button>
            <AsyncButton tone="primary" onClick={reveal}>
              Show me the plan
            </AsyncButton>
          </div>
        )}
        {composing && (
          <div className="cn-gate-slots">
            {SLOTS.map(({ key, question }) => (
              <label key={key}>
                <span>{question}</span>
                <textarea
                  className="cn-gate-slot"
                  rows={2}
                  value={draft[key]}
                  placeholder="Skip this one by leaving it empty"
                  onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                />
              </label>
            ))}
            <p className="cn-gate-kept">{CONTAINMENT}</p>
            {asksCriteria && (
              /* Fenced off rather than listed as a fifth slot: the posture is the
                 opposite of the four above it and the note has to land before the
                 field, not after it. */
              <div className="cn-gate-crit">
                <label>
                  <span>What “done” means for this goal</span>
                  <p className="cn-gate-crit-why">{REACHES_THE_FLEET}</p>
                  <textarea
                    className="cn-gate-slot"
                    rows={4}
                    value={criteria}
                    placeholder="One criterion per line — skip this by leaving it empty"
                    onChange={(e) => setCriteria(e.target.value)}
                  />
                </label>
              </div>
            )}
            {refusal !== null && <p className="cn-gate-refusal">{refusal}</p>}
            <div className="cn-gate-presses">
              <AsyncButton tone="primary" onClick={recordThenReveal} onRefused={setRefusal}>
                {asksCriteria ? 'Record these and show me the plan' : 'Predict and show me the plan'}
              </AsyncButton>
              <button
                type="button"
                className={buttonClass({})}
                onClick={() => {
                  setComposing(false);
                  setRefusal(null);
                }}
              >
                Back
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
