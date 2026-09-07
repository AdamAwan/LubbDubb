import { useEffect, useState, type JSX, type ReactNode } from 'react';
import type {
  ReviewAnchor,
  ReviewAttention,
  ReviewClaim,
  ReviewFinding,
  ReviewIdea,
  ReviewMark,
  ReviewPack,
  ReviewPackPayload,
  ReviewPackSharing,
  ReviewRange,
  ReviewVerdict,
  ScratchEntryView,
} from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { renderMarkdown } from './markdown.js';
import { Ref } from './refs.js';
import { Tag, type TagTone } from './tag.js';
import { logUsage } from '../cockpit/usage.js';
import {
  ALL_IDEAS,
  falseClaims,
  ideaFlags,
  anchorWeight,
  codeBlockLines,
  codeLanguage,
  highlightCode,
  ideaAtom,
  ideaOpen,
  KNOWN_REVIEW_PACK_SCHEMA,
  layMarks,
  numberIdeas,
  packCurrency,
  packFacts,
  packStanding,
  plainSummary,
  shortSha,
  splitBody,
  testScenarios,
  type FalseClaim,
  type IdeaMarks,
  type NumberedIdea,
} from '../view/reviewPack.js';

// → docs/spec/17-cockpit.md

interface ReviewPackPageProps {
  payload: ReviewPackPayload;
  marks: readonly ReviewMark[];
  entries: ReadonlyMap<string, ScratchEntryView> | null;
  openIdea: string | null;
  onOpenIdea: (id: string | null) => void;
  onRead: (ideaId: string, read: boolean) => Promise<void>;
  onSeen: (ideaId: string, seen: boolean) => Promise<void>;
  onAttention: (ideaId: string, attention: ReviewAttention | null) => Promise<void>;
  onAsk: () => Promise<void>;
  askRefusal: string | null;
  onAskRefused: (message: string) => void;
  onShare: () => Promise<void>;
  onUnshare: () => Promise<void>;
  shareRefusal: string | null;
  onShareRefused: (message: string) => void;
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
    <div className="rp rp-wrap">
      <Contents
        numbered={numbered}
        openIdea={props.openIdea}
        onOpenIdea={props.onOpenIdea}
        marks={laid}
        wrong={wrong}
      />
      <div className="rp-main">
        <Masthead {...props} />
        <Share
          sharing={payload.sharing}
          headSha={pack.headSha}
          onShare={props.onShare}
          onUnshare={props.onUnshare}
          refused={props.shareRefusal}
          onRefused={props.onShareRefused}
        />
        {standing !== 'checked' && (
          <Unchecked
            standing={standing}
            onAsk={props.onAsk}
            refused={props.askRefusal}
            onRefused={props.onAskRefused}
          />
        )}
        {wrong.length > 0 && <Gate wrong={wrong} />}
        <IdeasRule numbered={numbered} openIdea={props.openIdea} onOpenIdea={props.onOpenIdea} />
        <div className="rp-ideas">
          {numbered.ideas.map((entry) => (
            <IdeaRow
              key={entry.idea.id}
              pack={pack}
              entry={entry}
              marks={laid.get(entry.idea.id) ?? { read: false, attention: null, seen: false }}
              entries={props.entries}
              open={ideaOpen(props.openIdea, entry.idea.id)}
              onOpen={(open) => {
                if (open) logUsage('review-pack.expand');
                props.onOpenIdea(open ? entry.idea.id : null);
              }}
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
              <Finding
                key={`${item.idea.id}:${item.claimNumber}`}
                item={item}
                index={i + 1}
                refUrls={props.refUrls}
                seen={(laid.get(item.idea.id) ?? { seen: false }).seen}
                onSeen={(seen) => props.onSeen(item.idea.id, seen)}
              />
            ))}
          </>
        )}
        <SpendTheTime numbered={numbered} estimatedMinutes={pack.estimatedMinutes} />
        <Colophon payload={payload} />
      </div>
    </div>
  );
}

/**
 * The contents rail: every idea, and the stops of the one that is open.
 *
 * A pack is the longest read in the cockpit, and since it became a page rather
 * than a modal there is a column to hold the map of it. It draws each stop's
 * [weight](../view/reviewPack.js) — a `key` stop marked, a `minor` one dimmed — so
 * it says where the time goes before the reader has scrolled to find out, and it
 * flags the idea carrying a false claim, which is the one thing that must survive
 * a reader who opens nothing.
 *
 * **Only the open idea's stops.** Every other idea is collapsed, so its steps are
 * not on the page to jump to; clicking an idea here opens it, which is a `Place`
 * change like every other way in.
 *
 * **It follows the scroll.** The stop the reader is actually at is marked and kept
 * in view, so the map answers "where am I" and not only "where could I go" — a rail
 * that never moves is one a reader loses their place in the moment they scroll.
 * → docs/spec/31-review-packs.md#the-contents-rail
 */
function Contents({
  numbered,
  openIdea,
  onOpenIdea,
  marks,
  wrong,
}: {
  numbered: ReturnType<typeof numberIdeas>;
  openIdea: string | null;
  onOpenIdea: (id: string | null) => void;
  marks: Map<string, IdeaMarks>;
  wrong: FalseClaim[];
}): JSX.Element {
  const stops: string[] = [];
  for (const { idea, number } of numbered.ideas) {
    stops.push(`rp-i${number}`);
    if (ideaOpen(openIdea, idea.id)) idea.anchors.forEach((_, i) => stops.push(`rp-s${number}-${i + 1}`));
  }
  const here = useHere(stops.join(' '));
  return (
    <nav className="rp-rail" aria-label="Contents">
      {numbered.ideas.map(({ idea, number }) => {
        const open = ideaOpen(openIdea, idea.id);
        const flags = ideaFlags(idea);
        return (
          <div className="rp-c-grp" key={idea.id}>
            <a
              className={`rp-c-idea ${open ? 'rp-c-on' : ''} ${here === `rp-i${number}` ? 'rp-c-here' : ''}`}
              ref={here === `rp-i${number}` ? keepInView : null}
              href={`#rp-i${number}`}
              onClick={() => {
                if (!open) onOpenIdea(idea.id);
              }}
            >
              <span className="rp-c-n">{pad(number)}</span>
              <span>{idea.title}</span>
              {flags.falseClaims > 0 && <span className="rp-flag">!</span>}
              {(marks.get(idea.id)?.read ?? false) && <span className="rp-c-read">✓</span>}
            </a>
            {open && (
              <ol>
                {idea.anchors.map((anchor, i) => (
                  <li
                    key={i}
                    className={`rp-c-${anchorWeight(anchor)} ${here === `rp-s${number}-${i + 1}` ? 'rp-c-here' : ''}`}
                  >
                    <a ref={here === `rp-s${number}-${i + 1}` ? keepInView : null} href={`#rp-s${number}-${i + 1}`}>
                      <span className="rp-c-n">
                        {pad(number)}.{i + 1}
                      </span>
                      <span>{anchor.range.path.split('/').pop() ?? anchor.range.path}</span>
                    </a>
                  </li>
                ))}
              </ol>
            )}
          </div>
        );
      })}
      {wrong.length > 0 && (
        <div className="rp-c-grp">
          <a className="rp-c-idea rp-c-bad" href="#rp-finding-1">
            <span className="rp-c-n">!</span>
            <span>
              {wrong.length} false {wrong.length === 1 ? 'claim' : 'claims'}
            </span>
          </a>
        </div>
      )}
    </nav>
  );
}

/**
 * Which stop the reader is at, from the scroll.
 *
 * `ids` is one space-joined string rather than an array so the effect's dependency
 * is the list itself and not a new array on every render.
 */
function useHere(ids: string): string | null {
  const [here, setHere] = useState<string | null>(null);
  useEffect(() => {
    const read = (): void => {
      let at: string | null = null;
      for (const id of ids.split(' ')) {
        const el = document.getElementById(id);
        if (el !== null && el.getBoundingClientRect().top <= HERE_LINE) at = id;
      }
      setHere(at);
    };
    read();
    window.addEventListener('scroll', read, { passive: true });
    window.addEventListener('resize', read);
    return () => {
      window.removeEventListener('scroll', read);
      window.removeEventListener('resize', read);
    };
  }, [ids]);
  return here;
}

const HERE_LINE = 140;

/**
 * Scrolls the rail — and only the rail — so the marked stop is on it. Never
 * `scrollIntoView`, which walks up to the window and moves the page the reader
 * is scrolling.
 */
function keepInView(el: HTMLElement | null): void {
  const rail = el?.closest('.rp-rail');
  if (el === null || !(rail instanceof HTMLElement)) return;
  const stop = el.getBoundingClientRect();
  const view = rail.getBoundingClientRect();
  if (stop.top < view.top) rail.scrollTop -= view.top - stop.top;
  else if (stop.bottom > view.bottom) rail.scrollTop += stop.bottom - view.bottom;
}

function Masthead({ payload, onAsk, askRefusal, onAskRefused }: ReviewPackPageProps): JSX.Element {
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
      <div className="rp-plain">{renderMarkdown(plainSummary(pack.summary))}</div>
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
          {currency.kind === 'stale' && <AskAgain onAsk={onAsk} refused={askRefusal} onRefused={onAskRefused} />}
        </div>
      )}
    </header>
  );
}

function Share({
  sharing,
  headSha,
  onShare,
  onUnshare,
  refused,
  onRefused,
}: {
  sharing: ReviewPackSharing;
  headSha: string;
  onShare: () => Promise<void>;
  onUnshare: () => Promise<void>;
  refused: string | null;
  onRefused: (message: string) => void;
}): JSX.Element | null {
  if (!sharing.available) {
    return (
      <div className="rp-share rp-share-off">
        This deployment publishes to no pool, so this pack stays here. It is the fleet&rsquo;s own record either way.
      </div>
    );
  }
  const share = sharing.share;
  const button = (label: string) => (
    <AsyncButton ghost size="small" onClick={onShare} onRefused={onRefused} pendingLabel="sharing…">
      {label}
    </AsyncButton>
  );
  const unshare = (
    <AsyncButton ghost size="small" onClick={onUnshare} onRefused={onRefused} pendingLabel="unsharing…">
      Unshare
    </AsyncButton>
  );
  const refusal = refused ?? share?.refusal ?? null;
  return (
    <div className="rp-share">
      {share === null && (
        <>
          <span>
            Not shared. Publishing puts this pack — <b>its code included</b> — in the pool, where every fleet can read
            it. It is pruned when the pull request has been closed a while.
          </span>
          {button('Share this pack')}
        </>
      )}
      {share !== null && share.refusal === null && share.publishedAt === null && (
        <>
          <span className="rp-share-waiting">
            Shared — waiting for the next pool publish. It goes out on the pool&rsquo;s own clock, never on the click.
          </span>
          {unshare}
        </>
      )}
      {share !== null && share.publishedAt !== null && share.withdrawnAt === null && (
        <>
          <span className="rp-share-live">In the pool since {new Date(share.publishedAt).toLocaleString()}.</span>
          {share.headSha !== headSha && button('Share this pack instead')}
          {unshare}
        </>
      )}
      {share !== null && share.withdrawnAt !== null && (
        <span className="rp-share-waiting">
          Unshared — waiting for the next pool publish to take it out. It leaves on the pool&rsquo;s own clock, never on
          the click.
        </span>
      )}
      {share !== null && share.refusal !== null && share.publishedAt === null && button('Try again')}
      {refusal !== null && (
        <p className="rp-share-refused" role="alert">
          <b>Not shared.</b> {refusal}
        </p>
      )}
    </div>
  );
}

function Currency({ currency }: { currency: ReturnType<typeof packCurrency> }): JSX.Element {
  if (currency.kind === 'current') return <Tag tone="green">current</Tag>;
  if (currency.kind === 'gone') return <Tag>pull request gone</Tag>;
  const behind =
    currency.commitsBehind === null
      ? 'unknown commits behind'
      : `${currency.commitsBehind} ${currency.commitsBehind === 1 ? 'commit' : 'commits'} behind`;
  return (
    <Tag tone="amber" title={`the pull request is at ${currency.headSha}`}>
      stale · {behind}
    </Tag>
  );
}

function Unchecked({
  standing,
  onAsk,
  refused,
  onRefused,
}: {
  standing: 'unchecked' | 'checking';
  onAsk: () => Promise<void>;
  refused: string | null;
  onRefused: (message: string) => void;
}): JSX.Element {
  if (standing === 'checking') {
    return (
      <div className="rp-band rp-band-checking">
        <Tag tone="blue">being checked</Tag>
        <p>
          A second agent is checking every claim against the tree. The attention labels, the verdicts and the reading
          order arrive when it finishes; until then the ideas are in the author’s order and every claim is unchecked.
        </p>
      </div>
    );
  }
  return (
    <div className="rp-band rp-band-unchecked">
      <Tag tone="amber">unchecked</Tag>
      <p>
        The checker never finished this pack — the fleet was paused between the two runs, or the checker failed; the
        error log says which. Nothing here has been verified, and nothing retries on its own. Asking again re-runs both
        agents.
      </p>
      <AskAgain onAsk={onAsk} refused={refused} onRefused={onRefused} />
    </div>
  );
}

function AskAgain({
  onAsk,
  refused,
  onRefused,
}: {
  onAsk: () => Promise<void>;
  refused: string | null;
  onRefused: (message: string) => void;
}): JSX.Element {
  return (
    <>
      <AsyncButton ghost size="small" onClick={onAsk} onRefused={onRefused} pendingLabel="asking…">
        Ask again
      </AsyncButton>
      {refused !== null && <p className="rp-refusal">{refused}</p>}
    </>
  );
}

function Gate({ wrong }: { wrong: FalseClaim[] }): JSX.Element {
  const first = wrong[0]!;
  const rest = wrong.length - 1;
  return (
    <div className="rp-gate" role="alert">
      <Tag tone="red">
        {wrong.length} false {wrong.length === 1 ? 'claim' : 'claims'}
      </Tag>
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
  pack,
  entry,
  marks,
  entries,
  open,
  onOpen,
  onRead,
  onAttention,
  wrong,
}: {
  pack: ReviewPack;
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
  const raised = idea.claims.filter((c) => c.verdict === 'false' || c.provenance.kind === 'disputed');
  return (
    <details className={`rp-idea ${marks.read ? 'rp-read' : ''}`} id={`rp-i${number}`} open={open}>
      <summary
        onClick={(e) => {
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
        <AtomLine pack={pack} idea={idea} />
      </summary>
      {open && (
        <div className="rp-panel">
          {raised.length > 0 && (
            <div className={`rp-raised ${raised.some((c) => c.verdict === 'false') ? 'rp-raised-false' : ''}`}>
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
            <AsyncButton ghost size="small" onClick={() => onRead(!marks.read)} pendingLabel="marking…">
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
              <Step key={i} anchor={anchor} index={i + 1} ideaNumber={number} />
            ))}
          </ol>
          {idea.anchors.length === 0 && (
            <p className="rp-gap">This idea has no walk — the author gave it no anchors.</p>
          )}
          <CoveredBy coverage={idea.coverage ?? []} />
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

/**
 * The atom this idea corresponds to, under the cue. An idea no atom covers is drawn
 * as the finding it is; a pack with no atoms behind it draws nothing.
 * → docs/spec/31-review-packs.md#an-idea-the-atoms-do-not-cover-is-a-finding
 */
function AtomLine({ pack, idea }: { pack: ReviewPack; idea: ReviewIdea }): JSX.Element | null {
  const atom = ideaAtom(pack, idea);
  if (atom.kind === 'none') return null;
  if (atom.kind === 'declared') {
    return (
      <div className="rp-atom">
        atom <code>{atom.slug}</code>
      </div>
    );
  }
  return (
    <div className="rp-atom rp-atom-none">
      no atom — the plan did not declare this work, which is what makes it worth a look
    </div>
  );
}

function CoveredBy({ coverage }: { coverage: readonly string[] }): JSX.Element | null {
  if (coverage.length === 0) return null;
  return (
    <>
      <p className="rp-covered-head">Covered by</p>
      <ul className="rp-covered">
        {coverage.map((scenario, i) => (
          <li key={i}>{scenario}</li>
        ))}
      </ul>
    </>
  );
}

function findingIndex(wrong: FalseClaim[], idea: ReviewIdea, claim: ReviewClaim): number | null {
  const i = wrong.findIndex((w) => w.idea === idea && w.claim === claim);
  return i < 0 ? null : i + 1;
}

const ATTENTION_TONE: Record<ReviewAttention, TagTone> = {
  read: 'red',
  decide: 'amber',
  skim: 'grey',
  split: 'blue',
};

function AttentionChip({
  attention,
  overridden,
  checker,
}: {
  attention: ReviewAttention | null;
  overridden: boolean;
  checker: ReviewAttention | null;
}): JSX.Element {
  if (attention === null) return <Tag>—</Tag>;
  return (
    <Tag
      tone={ATTENTION_TONE[attention]}
      fill
      dashed={overridden}
      title={
        overridden
          ? `your label; the checker said ${checker === null ? 'nothing' : ATTENTION_LABEL[checker]}`
          : "the checker's label"
      }
    >
      {ATTENTION_LABEL[attention]}
      {overridden && ' *'}
    </Tag>
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

/**
 * One stop of the walk.
 *
 * The head carries the path and, of the badges, only the ones that ask something of
 * the reader — the important bit, a false claim, a witness disagreeing. What is
 * merely true of the hunk (how many lines it moved, that it is mechanical) is quiet
 * text: a page where everything is badged is a page with no emphasis left to spend.
 * A `region` says in words what it is, because "not in this PR" beside a caption
 * reading "should this have changed? no" is a puzzle the colophon answers ten
 * screens down.
 * → docs/spec/31-review-packs.md#the-page
 */
function Step({ anchor, index, ideaNumber }: { anchor: ReviewAnchor; index: number; ideaNumber: number }): JSX.Element {
  const region = anchor.kind === 'region';
  const counts = diffCounts(anchor.code);
  const disputedOrFalse = anchor.mark === 'false' || anchor.mark === 'disputed';
  const weight = anchorWeight(anchor);
  const scenarios = testScenarios(anchor.range.path, anchor.code);
  const code = (
    <CodeBlock code={anchor.code} caption={anchor.caption} dashed={region} diff={!region} path={anchor.range.path} />
  );
  return (
    <li
      className={`rp-step rp-w-${weight} ${region ? 'rp-dashed' : ''} ${anchor.mark !== null ? `rp-mark-${anchor.mark}` : ''}`}
      id={`rp-s${ideaNumber}-${index}`}
    >
      <div className="rp-step-head">
        <span className="rp-step-n">
          {pad(ideaNumber)}.{index}
        </span>
        <span className="rp-path">{rangeLabel(anchor.range)}</span>
        {anchor.mark === 'key' && (
          <Tag tone="accent" fill>
            the important bit
          </Tag>
        )}
        {anchor.mark === 'false' && (
          <Tag tone="red" fill>
            claim is false
          </Tag>
        )}
        {anchor.mark === 'disputed' && (
          <Tag tone="amber" fill>
            witness disagrees
          </Tag>
        )}
        <span className="rp-step-meta">
          {region
            ? 'unchanged'
            : `${counts.added > 0 ? `+${counts.added}` : ''}${counts.added > 0 && counts.removed > 0 ? ' ' : ''}${counts.removed > 0 ? `−${counts.removed}` : ''}`}
          {weight === 'minor' && !region && ' · mechanical'}
        </span>
      </div>
      <p className="rp-gist">{anchor.gist}</p>
      {region && (
        <p className="rp-region-note">
          This file is not in the pull request. The author is showing it to you on purpose — either the change cannot be
          judged without it, or it is the file you would expect to have changed and deliberately did not.
        </p>
      )}
      {scenarios.length > 0 ? (
        <div className="rp-scenarios">
          <p className="rp-scenarios-head">
            The {scenarios.length} {scenarios.length === 1 ? 'case' : 'cases'} it covers
          </p>
          <ul>
            {scenarios.map((name, i) => (
              <li key={i}>{name}</li>
            ))}
          </ul>
          <details className="rp-minor-code">
            <summary>
              show the {anchor.code.length} {anchor.code.length === 1 ? 'line' : 'lines'}
            </summary>
            {code}
          </details>
        </div>
      ) : weight === 'minor' ? (
        <details className="rp-minor-code">
          <summary>
            show the {anchor.code.length} {anchor.code.length === 1 ? 'line' : 'lines'}
          </summary>
          {code}
        </details>
      ) : (
        code
      )}
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
  path,
}: {
  code: readonly string[];
  caption: string | null;
  dashed: boolean;
  diff: boolean;
  path: string;
}): JSX.Element {
  const { gutter, lines } = codeBlockLines(code, diff);
  const coloured = highlightCode(
    lines.map((l) => l.text),
    codeLanguage(path),
  );
  const cut = lines.length > HEAD_LINES + TAIL_MARGIN ? HEAD_LINES : lines.length;
  const row = ({ marker, text }: { marker: '+' | '-' | ' ' | null; text: string }, i: number): JSX.Element => (
    <span key={i} className={`rp-l ${!gutter ? '' : marker === '+' ? 'rp-add' : marker === '-' ? 'rp-del' : ''}`}>
      {gutter && (
        <span className="rp-m" aria-hidden="true">
          {marker ?? ' '}
        </span>
      )}
      <span className="rp-t">
        {(coloured[i] ?? [{ kind: 'plain' as const, text }]).map((run, k) =>
          run.kind === 'plain' ? (
            run.text
          ) : (
            <span key={k} className={`rp-hl-${run.kind}`}>
              {run.text}
            </span>
          ),
        )}
      </span>
      {'\n'}
    </span>
  );
  return (
    <div className={`rp-code ${dashed ? 'rp-dashed' : ''} ${gutter ? 'rp-gutter' : ''}`}>
      {(caption !== null || cut < lines.length) && (
        <div className="rp-code-cap">
          <span>{caption}</span>
          {cut < lines.length && <span className="rp-code-len">{lines.length} lines</span>}
        </div>
      )}
      <pre>
        {lines.slice(0, cut).map((line, i) => row(line, i))}
        {lines.length === 0 && <span className="rp-l rp-gap">(no lines)</span>}
      </pre>
      {cut < lines.length && (
        <details className="rp-rest">
          <summary>
            {lines.length - cut} more {lines.length - cut === 1 ? 'line' : 'lines'}
          </summary>
          <pre>{lines.slice(cut).map((line, i) => row(line, cut + i))}</pre>
        </details>
      )}
    </div>
  );
}

const HEAD_LINES = 20;
const TAIL_MARGIN = 6;

const VERDICT_TONE: Record<ReviewVerdict, TagTone> = { true: 'green', false: 'red', cant_tell: 'amber' };

function VerdictChip({ verdict }: { verdict: ReviewVerdict | null }): JSX.Element {
  if (verdict === null) return <Tag>Unchecked</Tag>;
  return (
    <Tag tone={VERDICT_TONE[verdict]} fill>
      {VERDICT_LABEL[verdict]}
    </Tag>
  );
}

/**
 * One claim: the sentence, its verdict, and nothing else on the line.
 *
 * The checker's `evidence` is what it ran and read to settle the claim — often a
 * paragraph of paths and greps. It is the working, not the answer, so it is folded:
 * a reader scanning verdicts reads sentences, and a reader who doubts one opens it.
 * `inferred` is the provenance most claims have and it is drawn as nothing, so the
 * two that mean something — a witness quoted, a witness contradicted — are the ones
 * that catch the eye.
 * → docs/spec/31-review-packs.md#claims
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
        <span className="rp-claim-text">{claim.text}</span>
        {claim.provenance.kind === 'disputed' && <Tag tone="amber">witness disagrees</Tag>}
        {claim.verdict === 'cant_tell' && <strong className="rp-claim-yours"> You decide.</strong>}
        {findingIndex !== null && (
          <>
            {' '}
            <a href={`#rp-finding-${findingIndex}`}>Read the finding</a>
          </>
        )}
        {claim.evidence !== null && (
          <details className="rp-evidence">
            <summary>how it was checked</summary>
            <div className="rp-evidence-body">{claim.evidence}</div>
          </details>
        )}
        {cited !== null && (
          <details className="rp-entry-fold">
            <summary>
              {claim.provenance.kind === 'disputed' ? 'the note it contradicts' : 'what the witness wrote'}
            </summary>
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
          </details>
        )}
      </span>
    </div>
  );
}

function Finding({
  item,
  index,
  refUrls,
  seen,
  onSeen,
}: {
  item: FalseClaim;
  index: number;
  refUrls: Record<string, string>;
  seen: boolean;
  onSeen: (seen: boolean) => Promise<void>;
}): JSX.Element {
  const finding: ReviewFinding | null = item.claim.finding;
  const split = finding === null ? { lead: '', rest: '' } : splitBody(finding.body);
  const step = finding?.step ?? null;
  const marked = step !== null ? (item.idea.anchors[step - 1] ?? null) : null;
  return (
    <section className="rp-finding" id={`rp-finding-${index}`}>
      <h3>{finding?.headline ?? item.claim.text}</h3>
      <p className="rp-finding-where">
        Idea {pad(item.number)}, claim {item.claimNumber}: “{item.claim.text}”
      </p>
      {finding === null ? (
        <p className="rp-gap">The claim is marked false but carries no finding — the document is missing one.</p>
      ) : (
        <>
          <div className="rp-finding-lead">{renderMarkdown(split.lead, refUrls)}</div>
          <div className="rp-pair">
            {marked !== null ? (
              <CodeBlock
                code={marked.code}
                caption={`step ${step} — ${marked.range.path}:${marked.range.start}${marked.caption !== null ? ` — ${marked.caption}` : ''}`}
                dashed={marked.kind === 'region'}
                diff={marked.kind === 'hunk'}
                path={marked.range.path}
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
                path={finding.counter.range.path}
              />
            )}
          </div>
          {split.rest !== '' && (
            <details className="rp-finding-more">
              <summary>the rest of the finding</summary>
              <div className="rp-finding-body">{renderMarkdown(split.rest, refUrls)}</div>
            </details>
          )}
        </>
      )}
      {/*
        The one mark that is about the checker's output rather than the author's,
        and the only measure of whether prominence works: a pull request that
        merged with this unticked is a false claim nobody read. Nothing blocks on
        it — it is a reader saying they have taken it, not an approval.
      */}
      <div className="rp-finding-seen">
        <AsyncButton
          className={seen ? 'ghost small' : 'primary small'}
          onClick={() => onSeen(!seen)}
          pendingLabel="marking…"
        >
          {seen ? 'Taken — undo' : 'I have taken this'}
        </AsyncButton>
        <span className="rp-finding-seen-note">
          Nothing here blocks a merge. This only records that somebody read it.
        </span>
      </div>
    </section>
  );
}

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
