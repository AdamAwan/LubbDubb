import { useState, type JSX } from 'react';
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

const CONTAINMENT =
  'What you write here is kept from every agent the harness runs — it goes into no prompt, no ' +
  'transcript and no tool answer. The one leak the containment cannot stop is you: paste it into ' +
  "this goal's standing instructions and the fleet reads it.";

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
  const [refusal, setRefusal] = useState<string | null>(null);

  const reveal = async (): Promise<void> => {
    await api.revealGoalPlan(issueNumber);
    await onRevealed();
  };

  const predictThenReveal = async (): Promise<void> => {
    const slots = filled(draft);
    if (Object.keys(slots).length === 0) {
      setRefusal('Every slot is skippable, but not all four — write one of them and the prediction is a prediction.');
      return;
    }
    setRefusal(null);
    await api.predictGoal(issueNumber, slots);
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
        <h4>A plan is ready. Predict first?</h4>
        <p className="cn-gate-why">
          Writing down what you expect before you read it is the only way the record can tell a hunch that was right
          from one you formed afterwards. It holds nothing up: the fleet is not waiting on this.
        </p>
        {!composing && (
          <div className="cn-gate-presses">
            <button type="button" className={buttonClass({ tone: 'primary' })} onClick={() => setComposing(true)}>
              Predict
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
            {refusal !== null && <p className="cn-gate-refusal">{refusal}</p>}
            <div className="cn-gate-presses">
              <AsyncButton tone="primary" onClick={predictThenReveal} onRefused={setRefusal}>
                Predict and show me the plan
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
