import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
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
const COVERAGE: Record<GoalCriteriaReading['coverage'][number]['reading'], string> = {
  met: 'met',
  'not-met': 'not met',
  waived: 'waived',
  unread: 'not yet read',
  gap: 'no check names it',
};

export function GoalCriteria({
  issueNumber,
  workStarted,
  hasChecks,
  open,
  settled,
  onToggle,
  now,
}: {
  issueNumber: number;
  workStarted: boolean;
  /** Whether the goal has a check set, which is when each criterion has a reading to draw. */
  hasChecks: boolean;
  open: boolean;
  /** Whether `open` is the operator's own answer rather than the page's default. */
  settled: boolean;
  onToggle: (open: boolean) => void;
  now: number;
}): JSX.Element | null {
  const { reading, load } = useGoalCriteriaReading(issueNumber);
  const draft = useCriteriaDraft(issueNumber, load);
  /* Latched at the first reading, for the reason the prediction card latches its
     own: a card that folded itself the moment the version was appended would take
     the operator's own words away as they pressed. */
  const arrivedWritten = useRef<boolean | null>(null);

  if (reading === null) return null;

  const versions = reading.versions;
  const current = reading.current;
  const drifted = versions.filter((v) => v.standing === 'post-work');
  // Three sources, all answering the same question: a version already on record as
  // drift, a part already dispatched, and the route having just said so.
  const nextIsDrift = workStarted || drifted.length > 0 || draft.refused;
  /* Once somebody has written what "done" means the card is a record, and a record
     arrives folded — the heading still carries the version count and the drift tag,
     which is what a folded card owes its reader.
     → docs/spec/17-cockpit.md#goal-criteria-and-drift */
  if (arrivedWritten.current === null) arrivedWritten.current = current !== null;
  const showing = settled ? open : open && arrivedWritten.current === false;

  return (
    <section className="cn-card" id="cn-criteria">
      <CriteriaHeading showing={showing} onToggle={onToggle} versionCount={versions.length} drifted={drifted.length} />
      {showing && (
        <CriteriaBody reading={reading} hasChecks={hasChecks} draft={draft} nextIsDrift={nextIsDrift} now={now} />
      )}
    </section>
  );
}

function CriteriaBody({
  reading,
  hasChecks,
  draft,
  nextIsDrift,
  now,
}: {
  reading: GoalCriteriaReading;
  hasChecks: boolean;
  draft: ReturnType<typeof useCriteriaDraft>;
  nextIsDrift: boolean;
  now: number;
}): JSX.Element {
  const versions = reading.versions;
  const current = reading.current;
  const earlier = [...versions.slice(0, Math.max(0, versions.length - 1))].reverse();
  return (
    <div className="cn-crit-body">
      <p className="cn-crit-why">
        The goal&rsquo;s acceptance criteria, written by hand and kept as an append-only chain. Where these and a
        part&rsquo;s own acceptance disagree, these are the authority and the part is the defect. They are an oracle the
        work is judged against, so they are written for the fleet to read.
      </p>

      {current === null && <p className="cn-empty">No criteria have been written for this goal.</p>}
      {current !== null && <CurrentVersion version={current} now={now} />}
      {/* Once there is a check set, each criterion reads off the checks that name it —
          and one nothing names is a gap, drawn as loudly as a failure.
          → docs/spec/20-validation.md#satisfies-and-the-goals-criteria */}
      {current !== null && hasChecks && reading.coverage.length > 0 && <CoverageList coverage={reading.coverage} />}

      {earlier.length > 0 && <EarlierVersions earlier={earlier} now={now} />}

      {!draft.writing && (
        <CriteriaPresses first={current === null} nextIsDrift={nextIsDrift} onWrite={() => draft.setWriting(true)} />
      )}

      {draft.writing && (
        <CriteriaForm
          draft={draft}
          nextIsDrift={nextIsDrift}
          firstVersion={current === null}
          nextVersion={versions.length + 1}
        />
      )}
    </div>
  );
}

function CriteriaPresses({
  first,
  nextIsDrift,
  onWrite,
}: {
  first: boolean;
  nextIsDrift: boolean;
  onWrite: () => void;
}): JSX.Element {
  return (
    <div className="cn-crit-presses">
      {/* Primary only where there is nothing on record. A revision is one way
        on from a card that already says what it says, and drawn as the act
        the page is asking for it reads as work owed on every goal. */}
      <button type="button" className={buttonClass(first ? { tone: 'primary' } : {})} onClick={onWrite}>
        {first ? 'Write the criteria' : 'Revise the criteria'}
      </button>
      {nextIsDrift && <span className="cn-crit-warn">A revision now is drift, and will want a reason.</span>}
    </div>
  );
}

function useGoalCriteriaReading(issueNumber: number) {
  const [reading, setReading] = useState<GoalCriteriaReading | null>(null);

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

  return { reading, load };
}

function useCriteriaDraft(issueNumber: number, load: () => Promise<void>) {
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState('');
  const [reason, setReason] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  // Set when the route refuses for want of a reason, which is the case where the
  // standing moved underneath the form: a part was dispatched between the page
  // loading and the press. The field appears and what was typed is still there.
  const [refused, setRefused] = useState(false);

  const submit = async (nextIsDrift: boolean): Promise<void> => {
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

  const cancel = (): void => {
    setWriting(false);
    setRefusal(null);
  };

  return { writing, setWriting, text, setText, reason, setReason, refusal, setRefusal, refused, submit, cancel };
}

function CriteriaHeading({
  showing,
  onToggle,
  versionCount,
  drifted,
}: {
  showing: boolean;
  onToggle: (open: boolean) => void;
  versionCount: number;
  drifted: number;
}): JSX.Element {
  return (
    <h3>
      {/* The disclosure is the card's own, as the prediction panel's is: only this
          card knows whether anybody has written criteria, so only it can say
          whether there is a record here to fold. */}
      <button type="button" className="cn-disc" aria-expanded={showing} onClick={() => onToggle(!showing)}>
        <i className="cn-caret">{showing ? '▾' : '▸'}</i>
        What “done” means
      </button>
      {versionCount > 0 && <i className="cn-n">v{versionCount}</i>}
      {drifted > 0 && (
        <Tag tone="amber" title={STANDING['post-work'].why}>
          criteria changed after work started
        </Tag>
      )}
    </h3>
  );
}

function CoverageList({ coverage }: { coverage: GoalCriteriaReading['coverage'] }): JSX.Element {
  return (
    <ul className="cn-crit-cover">
      {coverage.map((c) => (
        <li key={c.criterion} className={`is-${c.reading}`}>
          <span className="cn-crit-cover-reading">{COVERAGE[c.reading]}</span> {c.criterion}
          {c.checks.length > 0 && <span className="cn-crit-cover-checks"> · {c.checks.join(', ')}</span>}
        </li>
      ))}
    </ul>
  );
}

function EarlierVersions({ earlier, now }: { earlier: CriteriaVersionReading[]; now: number }): JSX.Element {
  return (
    <details className="cn-crit-chain">
      <summary>{earlier.length === 1 ? 'The version behind it' : `The ${earlier.length} versions behind it`}</summary>
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
  );
}

function CriteriaForm({
  draft,
  nextIsDrift,
  firstVersion,
  nextVersion,
}: {
  draft: ReturnType<typeof useCriteriaDraft>;
  nextIsDrift: boolean;
  firstVersion: boolean;
  nextVersion: number;
}): JSX.Element {
  return (
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
            value={draft.reason}
            placeholder="What we learned, and what it changes"
            onChange={(e) => draft.setReason(e.target.value)}
          />
        </label>
      )}
      <label>
        <span>What “done” means for this goal</span>
        <textarea
          className="cn-crit-write"
          rows={6}
          value={draft.text}
          placeholder={firstVersion ? 'One criterion per line' : "The whole of what 'done' means, restated"}
          onChange={(e) => draft.setText(e.target.value)}
        />
      </label>
      <p className="cn-crit-note">
        A version is the whole text rather than a patch, and nothing is ever edited in place: this appends v
        {nextVersion} behind the one that stands now.
      </p>
      {draft.refusal !== null && <p className="cn-crit-refusal">{draft.refusal}</p>}
      <div className="cn-crit-presses">
        <AsyncButton tone="primary" onClick={() => draft.submit(nextIsDrift)} onRefused={draft.setRefusal}>
          Append this version
        </AsyncButton>
        <button type="button" className={buttonClass({})} onClick={draft.cancel}>
          Cancel
        </button>
      </div>
    </div>
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
