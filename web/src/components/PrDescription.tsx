import { useCallback, useEffect, useState, type JSX } from 'react';
import { api } from '../api.js';
import type {
  DescriptionFindingKind,
  DescriptionQuestion,
  PrDescriptionDraft,
  PrDescriptionVersion,
} from '../types.js';
import { descriptionPrompt } from '../cockpit/desktopLink.js';
import { AsyncButton } from './AsyncButton.js';
import { buttonClass } from './button.js';
import { DesktopLink } from './DesktopLink.js';
import { relTime } from './util.js';
import { Tag } from './tag.js';

// → docs/spec/07-pull-requests.md#the-pull-requests-own-page-is-where-it-is-written

/**
 * The four questions, as hints under the field.
 *
 * They are drawn beside the box and never as four boxes, which is the whole
 * decision: four inputs make the form the task, and a question with nothing to say
 * under it gets an answer anyway. Beside it they do the one job worth doing — an
 * operator who cannot answer one notices before a reviewer does.
 */
const PROMPTS: readonly { key: DescriptionQuestion; ask: string }[] = [
  { key: 'asked-for', ask: 'Is this what we asked for?' },
  { key: 'undone', ask: 'What can’t be undone if this is wrong?' },
  { key: 'missing', ask: 'What’s missing?' },
  { key: 'reach', ask: 'How far does it reach if it’s wrong?' },
];

const ASK: Readonly<Record<DescriptionQuestion, string>> = Object.fromEntries(
  PROMPTS.map(({ key, ask }) => [key, ask]),
) as Record<DescriptionQuestion, string>;

/**
 * How a finding is drawn. `contradicted` is the only one that takes red: it means
 * the pull request would have carried a false sentence under a person's name, which
 * is not the same defect as having left something out.
 */
const KINDS: Readonly<Record<DescriptionFindingKind, { label: string; tone: 'red' | 'amber' }>> = {
  contradicted: { label: 'the diff contradicts this', tone: 'red' },
  gap: { label: 'the diff raises this and you did not', tone: 'amber' },
};

const STOOD: Readonly<Record<'clean' | 'gaps' | 'contradicted', { label: string; tone: 'green' | 'amber' | 'red' }>> = {
  clean: { label: 'checked, and it stood up', tone: 'green' },
  gaps: { label: 'checked — gaps', tone: 'amber' },
  contradicted: { label: 'checked — contradicted', tone: 'red' },
};

/**
 * The check's findings, as a list rather than a row per question.
 *
 * A check is not four answers. The four questions are hints under the field, and a
 * reading keyed by them could only ever report on four things while most of what is
 * worth saying about a description against its diff is none of them. So a finding
 * stands on its own and names a question only where it happens to be one.
 */
function Checked({ version, now }: { version: PrDescriptionVersion; now: number }): JSX.Element | null {
  if (version.checkedAt === null) return null;
  const stood = version.findings.some((f) => f.kind === 'contradicted')
    ? 'contradicted'
    : version.findings.length > 0
      ? 'gaps'
      : 'clean';
  return (
    <div className="cn-desc-check">
      <div className="cn-desc-check-hdr">
        <Tag tone={STOOD[stood].tone}>{STOOD[stood].label}</Tag>
        <span className="cn-desc-when">{relTime(version.checkedAt, now)}</span>
      </div>
      {version.findings.length === 0 && (
        <p className="cn-desc-clean">Nothing it could hold against the diff. A clean check, not an unchecked one.</p>
      )}
      {version.findings.length > 0 && (
        <ul className="cn-desc-findings">
          {version.findings.map((finding, i) => (
            <li key={i}>
              <div className="cn-desc-finding-hdr">
                <Tag tone={KINDS[finding.kind].tone}>{KINDS[finding.kind].label}</Tag>
                {/* Only where the finding happens to be one of the four. Most are not. */}
                {finding.question !== null && <span className="cn-desc-tagged">{ASK[finding.question]}</span>}
              </div>
              <p className="cn-desc-note">{finding.note}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface Reading {
  /** The part this pull request carries, or null for one that is not a part's. */
  originRef: string | null;
  current: PrDescriptionVersion | null;
  /** The body the agent sent to `open_pr`, kept as a draft, or null where it sent none. */
  draft: PrDescriptionDraft | null;
}

/**
 * Null until the read answers, and null for good where it does not — the panel is
 * not drawn then.
 */
function usePrDescription(prNumber: number): { reading: Reading; reload: () => Promise<void> } | null {
  const [reading, setReading] = useState<Reading | null>(null);

  const read = useCallback(async (): Promise<Reading | null> => {
    try {
      const answer = await api.getPrDescription(prNumber);
      return { originRef: answer.originRef, current: answer.current, draft: answer.draft ?? null };
    } catch {
      return null;
    }
  }, [prNumber]);

  const reload = useCallback(async (): Promise<void> => {
    setReading(await read());
  }, [read]);

  useEffect(() => {
    let live = true;
    void read().then((next) => {
      if (live) setReading(next);
    });
    return () => {
      live = false;
    };
  }, [read]);

  return reading === null ? null : { reading, reload };
}

function Unwritten(): JSX.Element {
  return (
    <>
      {/* Only where nobody has written one. On a page that already carries a
          description the argument for writing it has been made and won. */}
      <p className="cn-desc-why">
        A reviewer reads this before the diff, and you are the one spending their hour — so it is yours to write, not
        the agent&rsquo;s. Read the change above first; what you write goes to the top of this pull request&rsquo;s
        body. It holds nothing up: leave it and the pull request carries the evidence alone, or use the agent&rsquo;s
        draft instead.
      </p>
      <p className="cn-empty">Nobody has described this pull request.</p>
    </>
  );
}

function HandedOver({ handedOver, now }: { handedOver: PrDescriptionDraft; now: number }): JSX.Element {
  if (handedOver.text === null) {
    return <p className="cn-empty">Handed to an agent. It is reading the diff and writing the description.</p>;
  }
  return (
    <div className="cn-desc-current">
      <blockquote className="cn-desc-text">{handedOver.text}</blockquote>
      <div className="cn-desc-by">
        written by an agent · {relTime(handedOver.writtenAt ?? handedOver.handedAt ?? '', now)}
        {handedOver.pushedAt === null && ' · not on the pull request yet'}
      </div>
    </div>
  );
}

function CurrentVersion({ current, now }: { current: PrDescriptionVersion; now: number }): JSX.Element {
  return (
    <div className="cn-desc-current">
      <blockquote className="cn-desc-text">{current.text}</blockquote>
      <div className="cn-desc-by">
        {current.author ?? 'author unrecorded'} · {relTime(current.authoredAt, now)}
      </div>
      {/* Checked without asking: rule pr-description-check reads every version against the diff.
          → docs/spec/07-pull-requests.md#every-description-is-checked-without-asking */}
      {current.checkedAt === null && (
        <p className="cn-desc-pending">An agent is reading this against the diff. It will only flag what matters.</p>
      )}
      <Checked version={current} now={now} />
    </div>
  );
}

function DescriptionReading({
  current,
  handedOver,
  hiddenDraft,
  revealed,
  now,
}: {
  current: PrDescriptionVersion | null;
  handedOver: PrDescriptionDraft | null;
  hiddenDraft: string | null;
  revealed: boolean;
  now: number;
}): JSX.Element {
  return (
    <>
      {current === null && handedOver === null && <Unwritten />}

      {handedOver !== null && <HandedOver handedOver={handedOver} now={now} />}

      {hiddenDraft !== null && revealed && (
        <div className="cn-desc-current">
          <blockquote className="cn-desc-text">{hiddenDraft}</blockquote>
          <div className="cn-desc-by">the agent&rsquo;s draft · not on the pull request</div>
        </div>
      )}

      {current !== null && <CurrentVersion current={current} now={now} />}
    </>
  );
}

/* Handed over, and not since overridden by the operator's own version, which
   outranks it. Before the press the draft is hidden behind a reveal, so the
   operator can write first. → docs/spec/07-pull-requests.md#the-agents-draft */
function draftShown(
  current: PrDescriptionVersion | null,
  draft: PrDescriptionDraft | null,
): { handedOver: PrDescriptionDraft | null; hiddenDraft: string | null } {
  const handedOver = current === null && draft !== null && draft.handedAt !== null ? draft : null;
  const hiddenDraft = current === null && handedOver === null && draft?.text ? draft.text : null;
  return { handedOver, hiddenDraft };
}

function DescriptionForm({
  text,
  setText,
  refusal,
  onCancel,
  onSubmit,
}: {
  text: string;
  setText: (text: string) => void;
  refusal: string | null;
  onCancel: () => void;
  onSubmit: () => Promise<void>;
}): JSX.Element {
  return (
    <div className="cn-desc-form">
      <div className="cn-desc-cols">
        <label>
          <span>Say what this pull request does, in your own words</span>
          <textarea
            className="cn-desc-write"
            rows={8}
            value={text}
            placeholder="Why it is needed, and what it changes"
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <div className="cn-desc-hints">
          <div className="cn-desc-hints-hdr">A reviewer has to be able to answer these</div>
          <ul>
            {PROMPTS.map(({ key, ask }) => (
              <li key={key}>{ask}</li>
            ))}
          </ul>
          <p className="cn-desc-hints-foot">
            Hints, not boxes. Nothing is required — but a question you cannot answer is worth noticing before a reviewer
            meets it.
          </p>
        </div>
      </div>
      {refusal !== null && <p className="cn-desc-refusal">{refusal}</p>}
      <div className="cn-desc-presses">
        <button type="button" className={buttonClass({ ghost: true })} onClick={onCancel}>
          Cancel
        </button>
        <AsyncButton tone="primary" onClick={onSubmit}>
          Save it
        </AsyncButton>
      </div>
    </div>
  );
}

function writeLabel(current: PrDescriptionVersion | null, handedOver: PrDescriptionDraft | null): string {
  if (current !== null) return 'Rewrite it';
  return handedOver !== null ? 'Write your own instead' : 'Describe it';
}

function DescriptionPresses({
  current,
  handedOver,
  hiddenDraft,
  revealed,
  setRevealed,
  onWrite,
  handOff,
  desktopFolder,
  part,
}: {
  current: PrDescriptionVersion | null;
  handedOver: PrDescriptionDraft | null;
  hiddenDraft: string | null;
  revealed: boolean;
  setRevealed: (revealed: boolean) => void;
  onWrite: () => void;
  handOff: () => Promise<void>;
  desktopFolder: string | null;
  part: RegExpExecArray | null;
}): JSX.Element {
  return (
    <div className="cn-desc-presses">
      {/* Primary only where nobody has written one. A rewrite is one way on from
          a page that already carries a description, and drawn as the act the
          page is asking for it reads as work owed on every pull request. */}
      <button
        type="button"
        className={buttonClass(current === null && handedOver === null ? { tone: 'primary' } : {})}
        onClick={onWrite}
      >
        {writeLabel(current, handedOver)}
      </button>
      {/* The agent's body, on this one pull request and only on a press. */}
      {hiddenDraft !== null && (
        <button type="button" className={buttonClass({ ghost: true })} onClick={() => setRevealed(!revealed)}>
          {revealed ? 'Hide the agent’s draft' : 'Reveal the agent’s draft'}
        </button>
      )}
      {hiddenDraft !== null && <AsyncButton onClick={handOff}>Use the agent&rsquo;s</AsyncButton>}
      {/* No draft to use: the agent sent no body, so one is dispatched to write it. */}
      {current === null && handedOver === null && hiddenDraft === null && (
        <AsyncButton onClick={handOff}>Hand it to the agent</AsyncButton>
      )}
      {/* The check is the operator's own Claude Code rather than a dispatched
          agent, because what follows the report is an argument and an argument on
          the pulse costs an afternoon. It contradicts; it never hands back prose.
          → docs/spec/07-pull-requests.md#it-contradicts-it-never-drafts */}
      {current !== null && desktopFolder !== null && part !== null && (
        <DesktopLink
          folder={desktopFolder}
          prompt={descriptionPrompt(Number(part[1]), part[2] ?? '')}
          label="Check my description"
          explain="which reads what you wrote against the diff and says where they disagree. It will not write one for you."
        />
      )}
    </div>
  );
}

/**
 * The description an operator writes for a pull request, and the offer to have their
 * own Claude Code argue with it.
 *
 * **On the pull request's own page**, which is the whole of where it is: this is a
 * reading of a change, and the page the change is read on is the only page an
 * operator is already on when they have something to say. Drawn against an open pull
 * request — before the pull request there is nothing to read, and a merged one is
 * not a change anybody is going to describe.
 *
 * Nothing here holds anything up. A pull request nobody describes carries the
 * evidence and the reference alone, which is why the empty state says so rather than
 * nagging.
 */
export function PrDescription({
  prNumber,
  open,
  desktopFolder,
  now,
}: {
  prNumber: number;
  /** Drawn only against an open pull request. */
  open: boolean;
  desktopFolder: string | null;
  now: number;
}): JSX.Element | null {
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const held = usePrDescription(prNumber);

  if (held === null || !open) return null;
  const { current, originRef, draft } = held.reading;
  if (originRef === null) return null;

  const part = /^issue:(\d+):part:(.+)$/.exec(originRef);

  const submit = async (): Promise<void> => {
    const body = text.trim();
    if (body === '') {
      setRefusal('There is nothing here to save. Say what the pull request does, or leave it and it will carry none.');
      return;
    }
    setRefusal(null);
    await api.writePrDescription(prNumber, { text: body });
    setText('');
    setWriting(false);
    await held.reload();
  };

  const handOff = async (): Promise<void> => {
    await api.handOffPrDescription(prNumber);
    await held.reload();
  };

  const { handedOver, hiddenDraft } = draftShown(current, draft);

  return (
    <section className="cn-card cn-desc">
      <h3>
        What this pull request says it does
        {current !== null && current.version > 1 && <i className="cn-n">v{current.version}</i>}
      </h3>

      {!writing && (
        <DescriptionReading
          current={current}
          handedOver={handedOver}
          hiddenDraft={hiddenDraft}
          revealed={revealed}
          now={now}
        />
      )}

      {writing && (
        <DescriptionForm
          text={text}
          setText={setText}
          refusal={refusal}
          onCancel={() => setWriting(false)}
          onSubmit={submit}
        />
      )}

      {!writing && (
        <DescriptionPresses
          current={current}
          handedOver={handedOver}
          hiddenDraft={hiddenDraft}
          revealed={revealed}
          setRevealed={setRevealed}
          onWrite={() => setWriting(true)}
          handOff={handOff}
          desktopFolder={desktopFolder}
          part={part}
        />
      )}
    </section>
  );
}
