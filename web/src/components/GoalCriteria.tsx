import { useCallback, useEffect, useState, type JSX } from 'react';
import { api, type CriteriaVersionReading, type GoalCriteriaReading } from '../api.js';
import type { CriteriaStanding } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { buttonClass } from './button.js';
import { Tag, type TagTone } from './tag.js';
import { relTime } from './util.js';

// → docs/spec/17-cockpit.md

/**
 * How each standing is drawn, and what it is a statement about. `pre-reveal` is the
 * independent one and is the only one drawn as a pass; `post-work` is drift and is
 * drawn as the thing that wants explaining, which is why the reason sits with it.
 */
const STANDING: Record<CriteriaStanding, { label: string; tone: TagTone; why: string }> = {
  'pre-reveal': {
    label: 'Written before the plan',
    tone: 'green',
    why: 'Authored before the plan was revealed to anybody, so it is an oracle the plan cannot have shaped.',
  },
  'post-reveal': {
    label: 'Written after reading the plan',
    tone: 'blue',
    why: 'Authored after the plan was read but before any part went out. Not independent of the plan, and not drift.',
  },
  'post-work': {
    label: 'Changed after work started',
    tone: 'amber',
    why: 'Authored after the first part was dispatched, so the fleet was already building against something else.',
  },
};

const DRIFT_REASON_HINT =
  'Work has already been dispatched on this goal, so a new version is drift: say what changed and why before ' +
  'you write it. The record keeps the reason beside the version for whoever reads the chain later.';

/**
 * A goal's acceptance criteria: the version that stands now, the chain behind it,
 * and the control that appends the next one.
 *
 * Criteria are an oracle the work is *meant* to be judged against and they reach
 * agents by design — they are the opposite of the prediction record beside them and
 * must never borrow its containment language.
 *
 * The card is keyed off the reading rather than off a flag: the routes are mounted
 * only where the key is on, so a read that does not answer is a deployment with no
 * criteria and the card draws nothing at all.
 */
export function GoalCriteria({
  issueNumber,
  workStarted,
  now,
}: {
  issueNumber: number;
  workStarted: boolean;
  now: number;
}): JSX.Element | null {
  const [reading, setReading] = useState<GoalCriteriaReading | null>(null);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState('');
  const [reason, setReason] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  // Set when the route refuses for want of a reason, which is the case where the
  // standing moved underneath the form: a part was dispatched between the page
  // loading and the press. The field appears and what was typed is still there.
  const [refused, setRefused] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setReading(await api.getGoalCriteria(issueNumber));
  }, [issueNumber]);

  useEffect(() => {
    let live = true;
    void api
      .getGoalCriteria(issueNumber)
      .then((answer) => {
        if (live) setReading(answer);
      })
      .catch(() => {
        if (live) setReading(null);
      });
    return () => {
      live = false;
    };
  }, [issueNumber]);

  if (reading === null) return null;

  const versions = reading.versions;
  const current = reading.current;
  const earlier = [...versions.slice(0, Math.max(0, versions.length - 1))].reverse();
  const drifted = versions.filter((v) => v.standing === 'post-work');
  // Three sources, all answering the same question: a version already on record as
  // drift, a part already dispatched, and the route having just said so.
  const nextIsDrift = workStarted || drifted.length > 0 || refused;

  const submit = async (): Promise<void> => {
    const body = text.trim();
    if (body === '') {
      setRefusal('A version is the text of what "done" means — there is nothing here to append.');
      return;
    }
    const note = reason.trim();
    if (nextIsDrift && note === '') {
      setRefusal(DRIFT_REASON_HINT);
      return;
    }
    try {
      await api.writeGoalCriteria(issueNumber, { text: body, ...(note === '' ? {} : { reason: note }) });
    } catch (err) {
      // The one refusal worth reading rather than just reporting: the standing
      // moved under the form and a reason is owed after all.
      setRefused(true);
      throw err;
    }
    setText('');
    setReason('');
    setWriting(false);
    setRefused(false);
    setRefusal(null);
    await load();
  };

  return (
    <section className="cn-card" id="cn-criteria">
      <h3>
        What “done” means
        {versions.length > 0 && <i className="cn-n">v{versions.length}</i>}
        {drifted.length > 0 && (
          <Tag tone="amber" title={STANDING['post-work'].why}>
            criteria changed after work started
          </Tag>
        )}
      </h3>
      <div className="cn-crit-body">
        <p className="cn-crit-why">
          The goal&rsquo;s acceptance criteria, written by hand and kept as an append-only chain. Where these and a
          part&rsquo;s own acceptance disagree, these are the authority and the part is the defect. They are an oracle
          the work is judged against, so they are written for the fleet to read.
        </p>

        {current === null && <p className="cn-empty">No criteria have been written for this goal.</p>}
        {current !== null && <CurrentVersion version={current} now={now} />}

        {earlier.length > 0 && (
          <details className="cn-crit-chain">
            <summary>
              {earlier.length === 1 ? 'The version behind it' : `The ${earlier.length} versions behind it`}
            </summary>
            <ol className="cn-crit-olds">
              {earlier.map((version) => (
                <li className="cn-crit-old" key={version.id}>
                  <div className="hdr hdr-base">
                    <span className="cn-crit-v">v{version.version}</span>
                    <Tag tone="grey" title={STANDING[version.standing].why}>
                      {STANDING[version.standing].label}
                    </Tag>
                    <span className="cn-crit-by">
                      {version.author ?? 'author unrecorded'} · {relTime(version.authoredAt, now)}
                    </span>
                  </div>
                  <blockquote className="cn-crit-text">{version.text}</blockquote>
                  {version.standing === 'post-work' && <Reason reason={version.reason} />}
                </li>
              ))}
            </ol>
          </details>
        )}

        {!writing && (
          <div className="cn-crit-presses">
            <button type="button" className={buttonClass({ tone: 'primary' })} onClick={() => setWriting(true)}>
              {current === null ? 'Write the criteria' : 'Revise the criteria'}
            </button>
            {nextIsDrift && <span className="cn-crit-warn">A revision now is drift, and will want a reason.</span>}
          </div>
        )}

        {writing && (
          <div className="cn-crit-form">
            {/* The requirement is surfaced before the press rather than after it: the
                chain is append-only, so a refused submission is a whole draft the
                operator retypes. */}
            {nextIsDrift && <p className="cn-crit-warn">{DRIFT_REASON_HINT}</p>}
            {nextIsDrift && (
              <label>
                <span>Why are the criteria changing?</span>
                <input
                  className="cn-crit-reason"
                  value={reason}
                  placeholder="What we learned, and what it changes"
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
            )}
            <label>
              <span>What “done” means for this goal</span>
              <textarea
                className="cn-crit-write"
                rows={6}
                value={text}
                placeholder={current === null ? 'One criterion per line' : "The whole of what 'done' means, restated"}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            <p className="cn-crit-note">
              A version is the whole text rather than a patch, and nothing is ever edited in place: this appends v
              {versions.length + 1} behind the one that stands now.
            </p>
            {refusal !== null && <p className="cn-crit-refusal">{refusal}</p>}
            <div className="cn-crit-presses">
              <AsyncButton tone="primary" onClick={submit} onRefused={setRefusal}>
                Append this version
              </AsyncButton>
              <button
                type="button"
                className={buttonClass({})}
                onClick={() => {
                  setWriting(false);
                  setRefusal(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function CurrentVersion({ version, now }: { version: CriteriaVersionReading; now: number }): JSX.Element {
  const standing = STANDING[version.standing];
  return (
    <div className={`cn-crit-now is-${version.standing}`}>
      <div className="hdr hdr-base">
        <span className="cn-crit-v">v{version.version}</span>
        <Tag tone={standing.tone} title={standing.why}>
          {standing.label}
        </Tag>
        <span className="cn-crit-by">
          {version.author ?? 'author unrecorded'} · {relTime(version.authoredAt, now)}
        </span>
      </div>
      <blockquote className="cn-crit-text">{version.text}</blockquote>
      {version.standing === 'post-work' && <Reason reason={version.reason} />}
    </div>
  );
}

function Reason({ reason }: { reason: string | null }): JSX.Element {
  return (
    <p className="cn-crit-reason-read">
      <span className="cn-crit-reason-label">Why it changed</span>
      {reason ?? 'No reason was recorded, which is the one thing a drift version is not supposed to be able to be.'}
    </p>
  );
}
