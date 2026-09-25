import { useCallback, useEffect, useState, type JSX } from 'react';
import { api, type GoalCriteriaReading } from '../api.js';
import type { CriteriaAlignmentPoint } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { buttonClass } from './button.js';
import { CONTAINMENT, EMPTY, REACHES_THE_FLEET, SLOTS, filled, type Draft } from './PlanRevealGate.js';

// → docs/spec/17-cockpit.md#the-reveal-gate

const WHY =
  'Nothing is planned for this goal until you have had the chance to say what you expect and what “done” ' +
  'means. Written now, before any plan exists, your criteria are handed to the planner and every part, and ' +
  'your prediction is a record of what you believed before the fleet said anything.';

const TAG: Record<CriteriaAlignmentPoint['tag'], string> = {
  matches: 'both say it',
  extra: 'only you say it',
  uncovered: 'only the ticket says it',
  contradicts: 'the two disagree',
};

const VERDICT: Record<string, string> = {
  aligned: 'Your criteria line up with the ticket’s own.',
  partial: 'Your criteria overlap with the ticket’s own — each side says something the other does not.',
  conflicting: 'Your criteria contradict the ticket’s own on at least one point.',
};

interface Loaded {
  criteria: GoalCriteriaReading | null;
  predicted: boolean | null;
}

/**
 * The intake sitting: what is asked of the operator before a goal is planned. Both
 * presses are the same weight — a hold that is awkward to decline is a hold that gets
 * switched off — and the planner waits on one of them.
 *
 * `aligning` is the pickup verdict's word that the alignment check is out; the page is
 * refreshed on every pulse, so the reading below is re-fetched when it flips.
 */
export function IntakeSitting({
  issueNumber,
  aligning,
  onClosed,
}: {
  issueNumber: number;
  aligning: boolean;
  onClosed: () => Promise<void> | void;
}): JSX.Element {
  const sitting = useIntakeSitting(issueNumber, aligning, onClosed);
  const { composing, recorded } = sitting;

  return (
    <div className="cn-gate cn-sitting">
      <div className="cn-gate-over">
        <h4>Before this goal is planned — anything to write down?</h4>
        <p className="cn-gate-why">{WHY}</p>

        {!composing && !recorded && (
          <div className="cn-gate-presses">
            {(sitting.asksPrediction || sitting.asksCriteria) && (
              <button
                type="button"
                className={buttonClass({ tone: 'primary' })}
                onClick={() => sitting.setComposing(true)}
              >
                Write these down
              </button>
            )}
            <AsyncButton tone="primary" onClick={sitting.close}>
              Skip, just plan it
            </AsyncButton>
          </div>
        )}

        {composing && <IntakeCompose sitting={sitting} />}

        {recorded && !composing && <IntakeRecorded sitting={sitting} aligning={aligning} />}
      </div>
    </div>
  );
}

function useIntakeSitting(issueNumber: number, aligning: boolean, onClosed: () => Promise<void> | void) {
  const [loaded, setLoaded] = useState<Loaded>({ criteria: null, predicted: null });
  const [composing, setComposing] = useState(false);
  const [revising, setRevising] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [criteria, setCriteria] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const [reading, prediction] = await Promise.all([
      api.getGoalCriteria(issueNumber).catch(() => null),
      api.getGoalPrediction(issueNumber).catch(() => null),
    ]);
    setLoaded({
      criteria: reading,
      predicted: prediction === null ? null : prediction.prediction !== null,
    });
  }, [issueNumber]);

  useEffect(() => {
    void load();
  }, [load, aligning]);

  const asksPrediction = loaded.predicted === false;
  const asksCriteria = loaded.criteria !== null && loaded.criteria.current === null;
  const recorded = loaded.predicted === true || (loaded.criteria?.current ?? null) !== null;

  const close = async (): Promise<void> => {
    await api.revealGoalPlan(issueNumber);
    await onClosed();
  };

  const record = async (): Promise<void> => {
    const slots = filled(draft);
    const text = criteria.trim();
    if (Object.keys(slots).length === 0 && text === '') {
      setRefusal('Nothing is written down yet — fill one prediction slot or say what “done” means.');
      return;
    }
    setRefusal(null);
    if (asksPrediction && Object.keys(slots).length > 0) await api.predictGoal(issueNumber, slots);
    if (asksCriteria && text !== '') await api.writeGoalCriteria(issueNumber, { text });
    setComposing(false);
    await load();
  };

  const revise = async (): Promise<void> => {
    const text = criteria.trim();
    if (text === '') {
      setRefusal('A version is the whole text restated — write the criteria out in full.');
      return;
    }
    setRefusal(null);
    await api.writeGoalCriteria(issueNumber, { text });
    setRevising(false);
    await load();
  };

  return {
    predicted: loaded.predicted,
    current: loaded.criteria?.current ?? null,
    alignment: loaded.criteria?.alignment ?? null,
    asksPrediction,
    asksCriteria,
    recorded,
    composing,
    setComposing,
    revising,
    setRevising,
    draft,
    setDraft,
    criteria,
    setCriteria,
    refusal,
    setRefusal,
    close,
    record,
    revise,
  };
}

type Sitting = ReturnType<typeof useIntakeSitting>;

function IntakeCompose({ sitting }: { sitting: Sitting }): JSX.Element {
  const { asksPrediction, asksCriteria, draft, setDraft, refusal } = sitting;
  return (
    <div className="cn-gate-slots">
      {asksPrediction &&
        SLOTS.map(({ key, question }) => (
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
      {asksPrediction && <p className="cn-gate-kept">{CONTAINMENT}</p>}
      {asksCriteria && (
        <div className="cn-gate-crit">
          <label>
            <span>What “done” means for this goal</span>
            <p className="cn-gate-crit-why">{REACHES_THE_FLEET}</p>
            <textarea
              className="cn-gate-slot"
              rows={4}
              value={sitting.criteria}
              placeholder="One criterion per line — skip this by leaving it empty"
              onChange={(e) => sitting.setCriteria(e.target.value)}
            />
          </label>
        </div>
      )}
      {refusal !== null && <p className="cn-gate-refusal">{refusal}</p>}
      <div className="cn-gate-presses">
        <AsyncButton tone="primary" onClick={sitting.record} onRefused={sitting.setRefusal}>
          Record these
        </AsyncButton>
        <button type="button" className={buttonClass({})} onClick={() => sitting.setComposing(false)}>
          Back
        </button>
      </div>
    </div>
  );
}

function IntakeRecorded({ sitting, aligning }: { sitting: Sitting; aligning: boolean }): JSX.Element {
  const { current, alignment, revising, refusal } = sitting;
  return (
    <div className="cn-sitting-recorded">
      {sitting.predicted === true && (
        <p className="cn-gate-kept">Your prediction is recorded, and kept from every agent but its judge.</p>
      )}
      {current !== null && !revising && (
        <div className="cn-sitting-crit">
          <span className="cn-sitting-label">Your criteria (version {current.version})</span>
          <pre className="cn-sitting-text">{current.text}</pre>
        </div>
      )}
      {current !== null && alignment === null && aligning && (
        <p className="cn-gate-why">Checking your criteria against the ticket’s own…</p>
      )}
      {current !== null && alignment !== null && !revising && <AlignmentReading alignment={alignment} />}
      {revising && (
        <div className="cn-gate-crit">
          <label>
            <span>Your criteria, restated in full</span>
            <textarea
              className="cn-gate-slot"
              rows={4}
              value={sitting.criteria}
              onChange={(e) => sitting.setCriteria(e.target.value)}
            />
          </label>
        </div>
      )}
      {refusal !== null && <p className="cn-gate-refusal">{refusal}</p>}
      <div className="cn-gate-presses">
        {revising ? <RevisingPresses sitting={sitting} /> : <RecordedPresses sitting={sitting} />}
      </div>
    </div>
  );
}

function AlignmentReading({ alignment }: { alignment: NonNullable<GoalCriteriaReading['alignment']> }): JSX.Element {
  return (
    <div className={`cn-align cn-align-${alignment.verdict}`}>
      <p className="cn-align-verdict">
        {VERDICT[alignment.verdict]} {alignment.summary}
      </p>
      <ul className="cn-align-points">
        {alignment.points.map((point, i) => (
          <li key={i} className={`cn-align-${point.tag}`}>
            <span className="cn-align-tag">{TAG[point.tag]}</span> {point.point}
            {point.note !== null && <span className="cn-align-note"> — {point.note}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RevisingPresses({ sitting }: { sitting: Sitting }): JSX.Element {
  return (
    <>
      <AsyncButton tone="primary" onClick={sitting.revise} onRefused={sitting.setRefusal}>
        Record this version
      </AsyncButton>
      <button type="button" className={buttonClass({})} onClick={() => sitting.setRevising(false)}>
        Back
      </button>
    </>
  );
}

function RecordedPresses({ sitting }: { sitting: Sitting }): JSX.Element {
  const { current } = sitting;
  return (
    <>
      <AsyncButton tone="primary" onClick={sitting.close}>
        {sitting.alignment?.verdict === 'conflicting' ? 'Plan it anyway' : 'Start planning'}
      </AsyncButton>
      {current !== null && (
        <button
          type="button"
          className={buttonClass({})}
          onClick={() => {
            sitting.setCriteria(current.text);
            sitting.setRevising(true);
          }}
        >
          Revise criteria
        </button>
      )}
    </>
  );
}
