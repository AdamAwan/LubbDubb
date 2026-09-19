import { useLayoutEffect, useRef, useState, type JSX, type MutableRefObject } from 'react';
import { api } from '../api.js';
import type { DescriptionFindingKind, DescriptionQuestion, PrDescriptionVersion } from '../types.js';
import { descriptionPrompt } from '../cockpit/desktopLink.js';
import { usePartDescriptions } from './partDescriptions.js';
import { AsyncButton } from './AsyncButton.js';
import { buttonClass } from './button.js';
import { DesktopLink } from './DesktopLink.js';
import { relTime } from './util.js';
import { Tag } from './tag.js';
import { PanelRows, type PanelRowModel } from '../console/PanelRow.js';

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

/**
 * Where to draw the pointer that ties this panel to the card it was opened for, as
 * a distance from the panel's own left edge.
 *
 * Measured rather than computed from a share of the width: the board's columns wrap
 * on a narrow pane, so which one the chosen card ended up in is a question only the
 * laid-out page can answer. Null where the card is not on the page, or where the
 * pointer would land in the panel's corner radius, which reads as a drawing mistake
 * rather than as a pointer.
 */
function usePointerAt(
  anchor: MutableRefObject<HTMLElement | null>,
  panel: MutableRefObject<HTMLElement | null>,
  slug: string,
): number | null {
  const [at, setAt] = useState<number | null>(null);
  useLayoutEffect(() => {
    const measure = (): void => {
      const card = anchor.current;
      const box = panel.current;
      if (card === null || box === null) return setAt(null);
      const cardAt = card.getBoundingClientRect();
      const boxAt = box.getBoundingClientRect();
      const x = cardAt.left + cardAt.width / 2 - boxAt.left;
      setAt(x < 20 || x > boxAt.width - 20 ? null : x);
    };
    measure();
    const watch = new ResizeObserver(measure);
    if (anchor.current !== null) watch.observe(anchor.current);
    if (panel.current !== null) watch.observe(panel.current);
    return () => watch.disconnect();
  }, [anchor, panel, slug]);
  return at;
}

/**
 * The description an operator writes for one part's pull request, and the offer to
 * have their own Claude Code argue with it.
 *
 * Drawn only for a part whose pull request is **open** — a description is a reading
 * of a change, and before the pull request there is nothing to read. What is written
 * here is put at the top of that pull request's body on the next pulse.
 *
 * Drawn only where `manualDescriptions` is on, and it learns that the way the
 * criteria card does: the routes are mounted only where the key is on, so a read
 * that does not answer is a deployment with the feature off and the panel is not
 * drawn. The presence of the data decides, never a flag on the payload.
 *
 * Nothing here holds anything up. A part nobody describes leaves its pull request
 * carrying the evidence and the reference alone, which is why the empty state says
 * so rather than nagging.
 */
export function PrDescription({
  issueNumber,
  slug,
  position,
  title,
  row,
  anchor,
  desktopFolder,
  now,
}: {
  issueNumber: number;
  slug: string;
  position: number;
  title: string;
  /** The pull request this describes, as the cockpit's one pull-request row. */
  row: PanelRowModel | undefined;
  /** The board card this panel was opened for, which its pointer aims at. */
  anchor: MutableRefObject<HTMLDivElement | null>;
  desktopFolder: string | null;
  now: number;
}): JSX.Element | null {
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const held = usePartDescriptions();
  const panel = useRef<HTMLElement | null>(null);
  const pointerAt = usePointerAt(anchor, panel, slug);

  if (held === null) return null;

  const current = held.parts[slug] ?? null;

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
    await held.reload();
  };

  return (
    <section className="cn-card cn-desc is-chosen-panel" ref={panel}>
      {/* The pointer back up at the card. Drawn only where it has somewhere to point:
          a panel whose card is off the page keeps the number and the title, which say
          the same thing in words.
          → docs/spec/17-cockpit.md#one-panel-for-the-part-in-front */}
      {pointerAt !== null && <span className="cn-desc-point" style={{ left: `${pointerAt}px` }} />}
      {/* The part is named in the heading because these stack one per part: three
          panels under one title are three panels an operator cannot tell apart. */}
      <h3>
        <span className="cn-desc-part is-chosen-num">{position}</span>
        What pull request {position} says it does
        <span className="cn-desc-title">{title}</span>
        {current !== null && current.version > 1 && <i className="cn-n">v{current.version}</i>}
      </h3>
      {/* The pull request this describes, so the operator can go and read it — which
          is the whole reason the panel waits for it to be open. The row rather than
          the bare reference: a panel about what a pull request says it does is a
          strange place to say less about that pull request than its own card on the
          board does. → docs/spec/17-cockpit.md#a-part-and-its-pull-request */}
      {row !== undefined && (
        <div className="cn-desc-pr cn-read-marks">
          <PanelRows layout="stacked" rows={[row]} />
        </div>
      )}

      {/* Only where nobody has written one. On a panel that already carries a
          description the argument for writing it has been made and won, and the same
          three sentences under every part is noise a reader learns to skip. */}
      {current === null && !writing && (
        <p className="cn-desc-why">
          A reviewer reads this before the diff, and you are the one spending their hour — so it is yours to write, not
          the agent&rsquo;s. Read the pull request first; what you write goes to the top of its body. It holds nothing
          up: leave it and the pull request carries the evidence alone.
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
