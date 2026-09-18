import { useCallback, useEffect, useState, type JSX } from 'react';
import { api, type PrDescriptionReading } from '../api.js';
import type { DescriptionMark, DescriptionQuestion, PrDescriptionVersion } from '../types.js';
import { descriptionPrompt } from '../cockpit/desktopLink.js';
import { AsyncButton } from './AsyncButton.js';
import { buttonClass } from './button.js';
import { DesktopLink } from './DesktopLink.js';
import { relTime } from './util.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md#the-description-a-reviewer-reads

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

/**
 * How a mark is drawn. `contradicted` is the only one that takes red, and it is
 * spelled out rather than shortened: it is the mark that says the pull request is
 * carrying a false sentence under a person's name, and it is the reason this is a
 * four-valued mark where a prediction's is three.
 */
const MARKS: Readonly<Record<DescriptionMark, { label: string; tone: 'green' | 'amber' | 'red' | 'grey' }>> = {
  matched: { label: 'matched the diff', tone: 'green' },
  missed: { label: 'the diff answers this and you did not', tone: 'amber' },
  contradicted: { label: 'the diff contradicts this', tone: 'red' },
  'not-applicable': { label: 'not applicable here', tone: 'grey' },
};

function Checked({ version, now }: { version: PrDescriptionVersion; now: number }): JSX.Element | null {
  if (version.checkedAt === null) return null;
  const marked = PROMPTS.filter(({ key }) => version.marks[key] !== null);
  if (marked.length === 0) return null;
  return (
    <div className="cn-desc-check">
      <div className="cn-desc-check-hdr">Checked against the diff · {relTime(version.checkedAt, now)}</div>
      <ul className="cn-desc-marks">
        {marked.map(({ key, ask }) => {
          const mark = version.marks[key];
          if (mark === null) return null;
          return (
            <li className="hdr hdr-base" key={key}>
              <span className="cn-desc-ask">{ask}</span>
              <Tag tone={MARKS[mark].tone}>{MARKS[mark].label}</Tag>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The description an operator writes for one part's pull request, and the offer to
 * have their own Claude Code argue with it.
 *
 * Drawn only where `manualDescriptions` is on, and it learns that the way the
 * criteria card does: the routes are mounted only where the key is on, so a read
 * that does not answer is a deployment with the feature off and the panel is not
 * drawn. The presence of the data decides, never a flag on the payload.
 *
 * Nothing here holds anything up. A part nobody describes opens its pull request
 * with no body above the reference, which is why the empty state says so rather than
 * nagging.
 */
export function PrDescription({
  issueNumber,
  slug,
  position,
  title,
  desktopFolder,
  now,
}: {
  issueNumber: number;
  slug: string;
  position: number;
  title: string;
  desktopFolder: string | null;
  now: number;
}): JSX.Element | null {
  const [reading, setReading] = useState<PrDescriptionReading | null>(null);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setReading(await api.getPrDescription(issueNumber, slug));
  }, [issueNumber, slug]);

  useEffect(() => {
    let live = true;
    void api
      .getPrDescription(issueNumber, slug)
      .then((answer) => {
        if (live) setReading(answer);
      })
      .catch(() => {
        if (live) setReading(null);
      });
    return () => {
      live = false;
    };
  }, [issueNumber, slug]);

  if (reading === null) return null;

  const current = reading.current;

  const submit = async (): Promise<void> => {
    const body = text.trim();
    if (body === '') {
      setRefusal('There is nothing here to save. Say what the pull request does, or leave it and it will carry none.');
      return;
    }
    setRefusal(null);
    await api.writePrDescription(issueNumber, slug, { text: body });
    setText('');
    setWriting(false);
    await load();
  };

  return (
    <section className="cn-card cn-desc">
      {/* The part is named in the heading because these stack one per part: three
          panels under one title are three panels an operator cannot tell apart. */}
      <h3>
        <span className="cn-desc-part">{position}</span>
        What pull request {position} says it does
        <span className="cn-desc-title">{title}</span>
        {reading.versions.length > 1 && <i className="cn-n">v{reading.versions.length}</i>}
      </h3>

      {/* Only where nobody has written one. On a panel that already carries a
          description the argument for writing it has been made and won, and the same
          three sentences under every part is noise a reader learns to skip. */}
      {current === null && !writing && (
        <p className="cn-desc-why">
          A reviewer reads this before the diff, and you are the one spending their hour — so it is yours to write, not
          the agent&rsquo;s. It holds nothing up: leave it and the pull request opens with no description.
        </p>
      )}

      {current === null && !writing && <p className="cn-empty">Nobody has described this part.</p>}

      {current !== null && !writing && (
        <div className="cn-desc-current">
          <blockquote className="cn-desc-text">{current.text}</blockquote>
          <div className="cn-desc-by">
            {current.author ?? 'author unrecorded'} · {relTime(current.authoredAt, now)}
          </div>
          <Checked version={current} now={now} />
        </div>
      )}

      {writing && (
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
                Hints, not boxes. Nothing is required — but a question you cannot answer is worth noticing before a
                reviewer meets it.
              </p>
            </div>
          </div>
          {refusal !== null && <p className="cn-desc-refusal">{refusal}</p>}
          <div className="cn-desc-presses">
            <button type="button" className={buttonClass({ ghost: true })} onClick={() => setWriting(false)}>
              Cancel
            </button>
            <AsyncButton tone="primary" onClick={submit}>
              Save it
            </AsyncButton>
          </div>
        </div>
      )}

      {!writing && (
        <div className="cn-desc-presses">
          <button type="button" className={buttonClass({ tone: 'primary' })} onClick={() => setWriting(true)}>
            {current === null ? 'Describe it' : 'Rewrite it'}
          </button>
          {/* The check is the operator's own Claude Code rather than a dispatched
              agent, because what follows the report is an argument and an argument on
              the pulse costs an afternoon. It contradicts; it never hands back prose.
              → docs/spec/07-pull-requests.md#it-contradicts-it-never-drafts */}
          {current !== null && desktopFolder !== null && (
            <DesktopLink
              folder={desktopFolder}
              prompt={descriptionPrompt(issueNumber, slug)}
              label="Check my description"
              explain="which reads what you wrote against the diff and says where they disagree. It will not write one for you."
            />
          )}
        </div>
      )}
    </section>
  );
}
