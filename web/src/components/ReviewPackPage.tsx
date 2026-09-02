import type { JSX, ReactNode } from 'react';
import type {
  ReviewAnchor,
  ReviewAttention,
  ReviewClaim,
  ReviewFinding,
  ReviewIdea,
  ReviewMark,
  ReviewPackPayload,
  ReviewRange,
  ReviewVerdict,
  ScratchEntryView,
} from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { renderMarkdown } from './markdown.js';
import { Ref } from './refs.js';
import {
  ALL_IDEAS,
  falseClaims,
  ideaFlags,
  ideaOpen,
  KNOWN_REVIEW_PACK_SCHEMA,
  layMarks,
  numberIdeas,
  packCurrency,
  packFacts,
  packStanding,
  shortSha,
  type FalseClaim,
  type IdeaMarks,
  type NumberedIdea,
} from '../view/reviewPack.js';

/**
 * The page a review pack renders to, in the order
 * `docs/spec/31-review-packs.md#the-page` fixes: masthead, the gate, the idea
 * rows, and on opening one its walk and its claims; then the findings, where to
 * spend the time, and the folded colophon.
 *
 * A pure function of the payload and what the reviewer has done to it — no
 * fetch, no state — so it can be rendered to static markup and the order of
 * things asserted, which is how the four surface requirements under *What a
 * false claim does* are checked. `ReviewPackModal` is the shell that fetches
 * and takes the marks.
 *
 * **The renderer invents nothing.** Every field it draws is a field of the
 * document; where one is missing it draws the gap — a row with no cue, a code
 * block with no caption — rather than guessing. And a pack whose `schema` this
 * build does not know is refused whole, at the top, never drawn as far as it is
 * recognised.
 */
interface ReviewPackPageProps {
  payload: ReviewPackPayload;
  /** The marks as they stand — the payload's on open, then whatever the last write returned. */
  marks: readonly ReviewMark[];
  /**
   * The pad entries the claims cite, by id, or null while the pads have not
   * arrived. A `witnessed` or `disputed` claim shows its entry verbatim beside
   * it; one whose entry is not here is drawn as such rather than silently bare.
   */
  entries: ReadonlyMap<string, ScratchEntryView> | null;
  /** Which idea is unfolded — an id, `all`, or null — from the address bar. */
  openIdea: string | null;
  onOpenIdea: (id: string | null) => void;
  onRead: (ideaId: string, read: boolean) => Promise<void>;
  onAttention: (ideaId: string, attention: ReviewAttention | null) => Promise<void>;
  /** Ask for a new pack — the same control as the first ask, from the pull request's row. */
  onAsk: () => Promise<void>;
  refUrls: Record<string, string>;
}

const ATTENTION_LABEL: Record<ReviewAttention, string> = {
  read: 'Read',
  decide: 'Decide',
  skim: 'Skim',
  split: 'Split',
};

const VERDICT_LABEL: Record<ReviewVerdict, string> = { true: 'True', false: 'False', cant_tell: 'Can’t tell' };

export function ReviewPackPage(props: ReviewPackPageProps): JSX.Element {
  const { payload } = props;
  const { pack } = payload;
  if (pack.schema !== KNOWN_REVIEW_PACK_SCHEMA) {
    // Refused whole, not rendered as far as it is recognised: a page silently
    // missing its gate because the renderer was a version behind is the failure
    // the subsystem exists to catch, reproduced by the thing that reports it.
    return (
      <div className="rp rp-refuse" role="alert">
        <h2>This pack cannot be shown.</h2>
        <p>
          It states schema <code>{String(pack.schema)}</code>, and this cockpit knows only schema{' '}
          <code>{String(KNOWN_REVIEW_PACK_SCHEMA)}</code>. Drawing the parts it recognises could drop the parts that
          matter — a false claim, a finding — without saying so. Update the cockpit, or ask for the pack again on this
          build.
        </p>
      </div>
    );
  }

  const laid = layMarks(pack, props.marks);
  const numbered = numberIdeas(pack);
  const wrong = falseClaims(pack);
  const standing = packStanding(payload);

  return (
    <div className="rp">
      <Masthead {...props} />
      {standing !== 'checked' && <Unchecked standing={standing} onAsk={props.onAsk} />}
      {wrong.length > 0 && <Gate wrong={wrong} />}
      <IdeasRule numbered={numbered} openIdea={props.openIdea} onOpenIdea={props.onOpenIdea} />
      <div className="rp-ideas">
        {numbered.ideas.map((entry) => (
          <IdeaRow
            key={entry.idea.id}
            entry={entry}
            marks={laid.get(entry.idea.id) ?? { read: false, attention: null }}
            entries={props.entries}
            open={ideaOpen(props.openIdea, entry.idea.id)}
            onOpen={(open) => props.onOpenIdea(open ? entry.idea.id : null)}
            onRead={(read) => props.onRead(entry.idea.id, read)}
            onAttention={(attention) => props.onAttention(entry.idea.id, attention)}
            wrong={wrong}
          />
        ))}
      </div>
      {wrong.length > 0 && (
        <>
          <div className="rp-rule">
            <span>{wrong.length === 1 ? 'The one problem' : `The ${wrong.length} problems`}</span>
          </div>
          {wrong.map((item, i) => (
            <Finding key={`${item.idea.id}:${item.claimNumber}`} item={item} index={i + 1} refUrls={props.refUrls} />
          ))}
        </>
      )}
      <SpendTheTime numbered={numbered} estimatedMinutes={pack.estimatedMinutes} />
      <Colophon payload={payload} />
    </div>
  );
}

function Masthead({ payload, onAsk }: ReviewPackPageProps): JSX.Element {
  const { pack } = payload;
  const facts = packFacts(pack);
  const currency = packCurrency(payload);
  const claims =
    facts.claims.unchecked === facts.claims.total
      ? `${facts.claims.total} claims · unchecked`
      : `${facts.claims.total} claims · ${facts.claims.true} true · ${facts.claims.false} false · ${facts.claims.cantTell} can’t tell` +
        (facts.claims.unchecked > 0 ? ` · ${facts.claims.unchecked} unchecked` : '');
  return (
    <header className="rp-mast">
      <div className="rp-kicker">
        <span>Review pack</span>
        <Ref to={`pr:${pack.prNumber}`} />
        <code title={pack.headSha}>{shortSha(pack.headSha)}</code>
        <Currency currency={currency} />
        {!pack.witnessed && (
          <span className="rp-unwitnessed" title="Neither pad had an entry, so every claim is the author's reading.">
            nobody witnessed this change
          </span>
        )}
      </div>
      <h1>{pack.headline}</h1>
      <div className="rp-plain">{renderMarkdown(pack.summary)}</div>
      <div className="rp-facts">
        <span>
          <b>{facts.ideas}</b> {facts.ideas === 1 ? 'idea' : 'ideas'}
        </span>
        <span>
          <b>{facts.files}</b> {facts.files === 1 ? 'file' : 'files'}
        </span>
        <span>
          <b>{facts.changes}</b> {facts.changes === 1 ? 'change' : 'changes'}, all owned
        </span>
        <span>{claims}</span>
        <span>
          <b>~{pack.estimatedMinutes} min</b>
        </span>
      </div>
      {currency.kind !== 'current' && (
        <div className="rp-stale-line">
          {currency.kind === 'gone' ? (
            <span>
              The pull request is no longer in the world the harness draws, so whether this pack is current cannot be
              decided.
            </span>
          ) : (
            <span>
              Written against <code>{shortSha(pack.headSha)}</code>; the pull request is now at{' '}
              <code>{shortSha(currency.headSha)}</code>,{' '}
              {currency.commitsBehind === null
                ? 'an unknown number of commits on'
                : `${currency.commitsBehind} ${currency.commitsBehind === 1 ? 'commit' : 'commits'} on`}
              . Nothing regenerates it — ask again when the change has turned enough to be worth two agent runs.
            </span>
          )}
          {currency.kind === 'stale' && (
            <AsyncButton className="ghost small" onClick={onAsk} pendingLabel="asking…">
              Ask again
            </AsyncButton>
          )}
        </div>
      )}
    </header>
  );
}

function Currency({ currency }: { currency: ReturnType<typeof packCurrency> }): JSX.Element {
  if (currency.kind === 'current') return <span className="chip small ok">current</span>;
  if (currency.kind === 'gone') return <span className="chip small">pull request gone</span>;
  const behind =
    currency.commitsBehind === null
      ? 'unknown commits behind'
      : `${currency.commitsBehind} ${currency.commitsBehind === 1 ? 'commit' : 'commits'} behind`;
  return (
    <span className="chip small warn" title={`the pull request is at ${currency.headSha}`}>
      stale · {behind}
    </span>
  );
}

/**
 * A pack the checker has not finished with, drawn as itself. Two states that
 * look alike from the verdicts alone — every one null — and read differently:
 * being checked, and never checked. The second is a paused fleet or a checker
 * that failed (the error log says which), and nothing retries it on its own.
 */
function Unchecked({
  standing,
  onAsk,
}: {
  standing: 'unchecked' | 'checking';
  onAsk: () => Promise<void>;
}): JSX.Element {
  if (standing === 'checking') {
    return (
      <div className="rp-band rp-band-checking">
        <span className="chip small info">being checked</span>
        <p>
          A second agent is checking every claim against the tree. The attention labels, the verdicts and the reading
          order arrive when it finishes; until then the ideas are in the author’s order and every claim is unchecked.
        </p>
      </div>
    );
  }
  return (
    <div className="rp-band rp-band-unchecked">
      <span className="chip small warn">unchecked</span>
      <p>
        The checker never finished this pack — the fleet was paused between the two runs, or the checker failed; the
        error log says which. Nothing here has been verified, and nothing retries on its own. Asking again re-runs both
        agents.
      </p>
      <AsyncButton className="ghost small" onClick={onAsk} pendingLabel="asking…">
        Ask again
      </AsyncButton>
    </div>
  );
}

/**
 * The gate: first thing after the masthead and above the ideas, so a reader
 * cannot reach the ideas without passing it. Absent when nothing is false.
 * → docs/spec/31-review-packs.md#what-a-false-claim-does
 */
function Gate({ wrong }: { wrong: FalseClaim[] }): JSX.Element {
  const first = wrong[0]!;
  const rest = wrong.length - 1;
  return (
    <div className="rp-gate" role="alert">
      <span className="rp-gate-tag">
        {wrong.length} false {wrong.length === 1 ? 'claim' : 'claims'}
      </span>
      <p>
        {first.claim.finding?.headline ?? first.claim.text} — idea {pad(first.number)}.{' '}
        <a href="#rp-finding-1">Read the finding</a> before anything else.
        {rest > 0 && ` ${rest} more ${rest === 1 ? 'follows' : 'follow'} it.`}
      </p>
    </div>
  );
}

function IdeasRule({
  numbered,
  openIdea,
  onOpenIdea,
}: {
  numbered: ReturnType<typeof numberIdeas>;
  openIdea: string | null;
  onOpenIdea: (id: string | null) => void;
}): JSX.Element {
  const count = numbered.ideas.length;
  const allOpen = openIdea === ALL_IDEAS;
  return (
    <div className="rp-rule">
      <span>
        The {count} {count === 1 ? 'idea' : 'ideas'} — open one to see the code
      </span>
      <i className="rp-rule-note">
        {numbered.by === 'order'
          ? 'numbered in the order the checker says to read them'
          : 'in document order — the checker has not ordered them'}
      </i>
      <button type="button" className="rp-rule-btn" onClick={() => onOpenIdea(allOpen ? null : ALL_IDEAS)}>
        {allOpen ? 'close all' : 'open all'}
      </button>
    </div>
  );
}

const pad = (n: number): string => String(n).padStart(2, '0');

function IdeaRow({
  entry,
  marks,
  entries,
  open,
  onOpen,
  onRead,
  onAttention,
  wrong,
}: {
  entry: NumberedIdea;
  marks: IdeaMarks;
  entries: ReadonlyMap<string, ScratchEntryView> | null;
  open: boolean;
  onOpen: (open: boolean) => void;
  onRead: (read: boolean) => Promise<void>;
  onAttention: (attention: ReviewAttention | null) => Promise<void>;
  wrong: FalseClaim[];
}): JSX.Element {
  const { idea, number } = entry;
  const flags = ideaFlags(idea);
  const steps = idea.anchors.length;
  const changes = idea.anchors.filter((a) => a.kind === 'hunk').length;
  const attention = marks.attention ?? idea.attention;
  // The claims a reader must see first: a false one and a disputed one are
  // shown at the top of the idea with their evidence, never folded away with
  // the notes.
  const raised = idea.claims.filter((c) => c.verdict === 'false' || c.provenance.kind === 'disputed');
  return (
    <details className={`rp-idea ${marks.read ? 'rp-read' : ''}`} open={open}>
      <summary
        onClick={(e) => {
          // The address bar owns which idea is open, so the click is a move
          // rather than a toggle the element does on its own.
          e.preventDefault();
          onOpen(!open);
        }}
      >
        <div className="rp-row">
          <span className="rp-n">{pad(number)}</span>
          <AttentionChip attention={attention} overridden={marks.attention !== null} checker={idea.attention} />
          <h3>{idea.title}</h3>
          <span className="rp-meta">
            {steps} {steps === 1 ? 'step' : 'steps'} · {changes} {changes === 1 ? 'change' : 'changes'}
            {flags.falseClaims > 0 && (
              <>
                {' '}
                ·{' '}
                <span className="rp-flag">
                  {flags.falseClaims} false {flags.falseClaims === 1 ? 'claim' : 'claims'}
                </span>
              </>
            )}
            {flags.disputed > 0 && (
              <>
                {' '}
                ·{' '}
                <span className="rp-flag rp-flag-disputed">
                  {flags.disputed} {flags.disputed === 1 ? 'dispute' : 'disputes'}
                </span>
              </>
            )}
            {marks.read && <span className="rp-readmark"> · read</span>}
          </span>
        </div>
        {idea.cue !== null ? (
          <div className="rp-cue">{idea.cue}</div>
        ) : (
          <div className="rp-cue rp-gap">no cue — the checker has not written one</div>
        )}
      </summary>
      {open && (
        <div className="rp-panel">
          {raised.length > 0 && (
            <div className="rp-raised">
              {raised.map((claim) => (
                <ClaimLine
                  key={idea.claims.indexOf(claim)}
                  claim={claim}
                  entries={entries}
                  findingIndex={findingIndex(wrong, idea, claim)}
                />
              ))}
            </div>
          )}
          <div className="rp-marks">
            <AsyncButton className="ghost small" onClick={() => onRead(!marks.read)} pendingLabel="marking…">
              {marks.read ? 'Mark unread' : 'Mark read'}
            </AsyncButton>
            <label className="rp-override">
              <span>Attention</span>
              <select
                value={marks.attention ?? ''}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  void onAttention(value === '' ? null : (value as ReviewAttention));
                }}
              >
                <option value="">
                  {idea.attention === null
                    ? 'checker’s (not yet labelled)'
                    : `checker’s: ${ATTENTION_LABEL[idea.attention]}`}
                </option>
                {(Object.keys(ATTENTION_LABEL) as ReviewAttention[]).map((a) => (
                  <option key={a} value={a}>
                    {ATTENTION_LABEL[a]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <ol className="rp-walk">
            {idea.anchors.map((anchor, i) => (
              <Step key={i} anchor={anchor} index={i + 1} />
            ))}
          </ol>
          {idea.anchors.length === 0 && (
            <p className="rp-gap">This idea has no walk — the author gave it no anchors.</p>
          )}
          <p className="rp-claims-head">What the author claims · checked by a second agent</p>
          <ul className="rp-claims">
            {idea.claims.map((claim, i) => (
              <li key={i}>
                <ClaimLine claim={claim} entries={entries} findingIndex={findingIndex(wrong, idea, claim)} />
              </li>
            ))}
          </ul>
          {idea.claims.length === 0 && <p className="rp-gap">The author made no claims for this idea.</p>}
        </div>
      )}
    </details>
  );
}

function findingIndex(wrong: FalseClaim[], idea: ReviewIdea, claim: ReviewClaim): number | null {
  const i = wrong.findIndex((w) => w.idea === idea && w.claim === claim);
  return i < 0 ? null : i + 1;
}

function AttentionChip({
  attention,
  overridden,
  checker,
}: {
  attention: ReviewAttention | null;
  overridden: boolean;
  checker: ReviewAttention | null;
}): JSX.Element {
  if (attention === null) return <span className="rp-att rp-att-none">—</span>;
  return (
    <span
      className={`rp-att rp-att-${attention} ${overridden ? 'rp-att-over' : ''}`}
      title={
        overridden
          ? `your label; the checker said ${checker === null ? 'nothing' : ATTENTION_LABEL[checker]}`
          : "the checker's label"
      }
    >
      {ATTENTION_LABEL[attention]}
      {overridden && ' *'}
    </span>
  );
}

function rangeLabel(range: ReviewRange): ReactNode {
  return (
    <>
      {range.path}
      <b>
        :{range.start}
        {range.end > range.start ? `–${range.end}` : ''}
      </b>
    </>
  );
}

function diffCounts(code: readonly string[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of code) {
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

function Step({ anchor, index }: { anchor: ReviewAnchor; index: number }): JSX.Element {
  const region = anchor.kind === 'region';
  const counts = diffCounts(anchor.code);
  const disputedOrFalse = anchor.mark === 'false' || anchor.mark === 'disputed';
  return (
    <li className={`rp-step ${region ? 'rp-dashed' : ''} ${anchor.mark !== null ? `rp-mark-${anchor.mark}` : ''}`}>
      <div className="rp-step-head">
        <span className="rp-step-n">{index}</span>
        <span className="rp-path">{rangeLabel(anchor.range)}</span>
        {region ? (
          <span className="rp-tag rp-tag-region">not in this PR</span>
        ) : (
          <span className="rp-tag rp-tag-diff">
            changed {counts.added > 0 && `+${counts.added}`} {counts.removed > 0 && `−${counts.removed}`}
          </span>
        )}
        {anchor.mark === 'key' && <span className="rp-tag rp-tag-key">the important bit</span>}
        {anchor.mark === 'false' && <span className="rp-tag rp-tag-false">claim is false</span>}
        {anchor.mark === 'disputed' && <span className="rp-tag rp-tag-disputed">witness disagrees</span>}
      </div>
      <p className="rp-gist">{anchor.gist}</p>
      <CodeBlock code={anchor.code} caption={anchor.caption} dashed={region} diff={!region} />
      {anchor.note !== null && (
        <details className="rp-why" open={disputedOrFalse}>
          <summary>
            {anchor.note.by === 'witness' ? (
              <span className="rp-stamp" title={anchor.note.at}>
                witness · {clock(anchor.note.at)}
              </span>
            ) : (
              <span className="rp-stamp">added afterwards</span>
            )}
            <span> why</span>
          </summary>
          {/* Plain text with its newlines, for the notepad's reason: a note is
              testimony, and rendering it would let a stray backtick change what
              the testimony looks like. */}
          <div className="rp-why-body">{anchor.note.text}</div>
        </details>
      )}
    </li>
  );
}

function clock(iso: string): string {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? iso : t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function CodeBlock({
  code,
  caption,
  dashed,
  diff,
}: {
  code: readonly string[];
  caption: string | null;
  dashed: boolean;
  diff: boolean;
}): JSX.Element {
  return (
    <div className={`rp-code ${dashed ? 'rp-dashed' : ''}`}>
      {caption !== null && <div className="rp-code-cap">{caption}</div>}
      <pre>
        {code.map((line, i) => (
          <span
            key={i}
            className={`rp-l ${diff && line.startsWith('+') ? 'rp-add' : diff && line.startsWith('-') ? 'rp-del' : ''}`}
          >
            {line}
            {'\n'}
          </span>
        ))}
        {code.length === 0 && <span className="rp-l rp-gap">(no lines)</span>}
      </pre>
    </div>
  );
}

function VerdictChip({ verdict }: { verdict: ReviewVerdict | null }): JSX.Element {
  if (verdict === null) return <span className="rp-v rp-v-none">Unchecked</span>;
  return <span className={`rp-v rp-v-${verdict === 'cant_tell' ? 'un' : verdict}`}>{VERDICT_LABEL[verdict]}</span>;
}

/**
 * One claim: its verdict as a chip, its evidence in the sentence, and where it
 * came from — with the cited pad entry verbatim beside a `witnessed` or
 * `disputed` one. That is what stops the author quietly improving a note in the
 * retelling: the reader sees both halves at once.
 */
function ClaimLine({
  claim,
  entries,
  findingIndex,
}: {
  claim: ReviewClaim;
  entries: ReadonlyMap<string, ScratchEntryView> | null;
  findingIndex: number | null;
}): JSX.Element {
  const cited = claim.provenance.kind === 'inferred' ? null : claim.provenance.entryId;
  const entry = cited === null || entries === null ? null : (entries.get(cited) ?? null);
  return (
    <div className={`rp-claim ${claim.verdict === 'false' ? 'rp-claim-false' : ''}`}>
      <VerdictChip verdict={claim.verdict} />
      <span className="rp-claim-body">
        <span className={`rp-prov rp-prov-${claim.provenance.kind}`}>{claim.provenance.kind}</span> {claim.text}
        {claim.evidence !== null && <span className="rp-evidence"> {claim.evidence}</span>}
        {claim.verdict === 'cant_tell' && <strong> You decide.</strong>}
        {findingIndex !== null && (
          <>
            {' '}
            <a href={`#rp-finding-${findingIndex}`}>Read the finding</a>
          </>
        )}
        {cited !== null && (
          <blockquote className="rp-entry">
            {entry !== null ? (
              <>
                <span className="rp-stamp">
                  {entry.authorOriginRef} · {clock(entry.createdAt)}
                </span>
                <div>{entry.note}</div>
                {entry.decision && (
                  <div className="rp-entry-fork">
                    <b>chose</b> {entry.decision.chose} <b>because</b> {entry.decision.because}
                    {entry.decision.rejected.length > 0 && (
                      <>
                        {' '}
                        <b>rejected</b>{' '}
                        {entry.decision.rejected.map((r) => `${r.alternative} — ${r.because}`).join('; ')}
                      </>
                    )}
                  </div>
                )}
              </>
            ) : (
              <span className="rp-gap">
                cites pad entry <code>{cited}</code>
                {entries === null ? ' — the pads have not loaded' : ', which is not on either pad'}
              </span>
            )}
          </blockquote>
        )}
      </span>
    </div>
  );
}

/**
 * A finding: the page's most important prose. The two pieces of code that
 * disagree are the step the claim is about (`mark: 'false'` on the walk) and the
 * checker's counter, drawn side by side with their captions; then the body, a
 * table where numbers make it concrete, and the closing paragraph.
 */
function Finding({
  item,
  index,
  refUrls,
}: {
  item: FalseClaim;
  index: number;
  refUrls: Record<string, string>;
}): JSX.Element {
  const finding: ReviewFinding | null = item.claim.finding;
  const step = finding?.step ?? null;
  const marked = step !== null ? (item.idea.anchors[step - 1] ?? null) : null;
  return (
    <section className="rp-finding" id={`rp-finding-${index}`}>
      <h3>{finding?.headline ?? item.claim.text}</h3>
      <p className="rp-finding-where">
        Idea {pad(item.number)}, claim {item.claimNumber}: “{item.claim.text}”
        {item.claim.evidence !== null && <span className="rp-evidence"> {item.claim.evidence}</span>}
      </p>
      {finding === null ? (
        <p className="rp-gap">The claim is marked false but carries no finding — the document is missing one.</p>
      ) : (
        <>
          <div className="rp-pair">
            {marked !== null ? (
              <CodeBlock
                code={marked.code}
                caption={`step ${step} — ${marked.range.path}:${marked.range.start}${marked.caption !== null ? ` — ${marked.caption}` : ''}`}
                dashed={marked.kind === 'region'}
                diff={marked.kind === 'hunk'}
              />
            ) : (
              <p className="rp-gap">No step of the walk fits this claim; the code below is where the tree disagrees.</p>
            )}
            {finding.counter !== null && (
              <CodeBlock
                code={finding.counter.code}
                caption={`${finding.counter.range.path}:${finding.counter.range.start} — ${finding.counter.caption}`}
                dashed={false}
                diff={false}
              />
            )}
          </div>
          <div className="rp-finding-body">{renderMarkdown(finding.body, refUrls)}</div>
        </>
      )}
    </section>
  );
}

/** `attention` made actionable: the ideas in reading order, each with the reason. */
function SpendTheTime({
  numbered,
  estimatedMinutes,
}: {
  numbered: ReturnType<typeof numberIdeas>;
  estimatedMinutes: number;
}): JSX.Element {
  return (
    <>
      <div className="rp-rule">
        <span>Where to spend the {estimatedMinutes} minutes</span>
      </div>
      {numbered.by === 'document' ? (
        <p className="rp-gap">The checker has not ordered the ideas, so there is no reading order to give yet.</p>
      ) : (
        <ol className="rp-order">
          {numbered.ideas.map(({ idea, number }) => (
            <li key={idea.id}>
              <strong>
                Idea {pad(number)}
                {idea.attention !== null && ` — ${ATTENTION_LABEL[idea.attention].toLowerCase()}`}:
              </strong>{' '}
              {idea.title}
              {idea.cue !== null && <span className="rp-order-cue"> {idea.cue}</span>}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function Colophon({ payload }: { payload: ReviewPackPayload }): JSX.Element {
  const { pack } = payload;
  return (
    <details className="rp-colophon">
      <summary>How this pack was put together, and what in it is fake</summary>
      <p>
        <b>The notes.</b>{' '}
        {pack.witnessed
          ? 'The agents that wrote the change recorded their forks as they went, on the shared pad; the author grouped those into the ideas afterwards and could not edit what was already written.'
          : 'Nobody recorded a fork while this change was written, so the author worked from the diff and the tree alone: every claim is inferred, and nothing here is anybody’s testimony.'}
      </p>
      <p>
        <b>The checking.</b> A second agent was handed the claims and the tree and none of the author’s reasoning, and
        marked each claim true, false or can’t tell. Nothing here blocks a merge; a person decides.
      </p>
      <p>
        <b>Dashed boxes</b> are files that are <em>not</em> in the pull request — shown because the change cannot be
        judged without them, or because they are the file a reader would expect to have changed and deliberately did
        not.
      </p>
      <p>
        <b>What is fake.</b> {pack.fake}
      </p>
      <p className="rp-colophon-meta">
        Written {new Date(payload.writtenAt).toLocaleString()} against <code>{pack.headSha}</code>.
      </p>
    </details>
  );
}
