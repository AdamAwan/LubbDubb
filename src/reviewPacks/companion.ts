import { REVIEW_PACK_SCHEMA } from '../store/reviewPacks.js';
import type {
  ReviewAnchor,
  ReviewAttention,
  ReviewClaim,
  ReviewIdea,
  ReviewPackRecord,
  ReviewRange,
  ReviewVerdict,
} from '../types.js';
import {
  codeBlockLines,
  codeLanguage,
  falseClaims,
  highlightCode,
  ideaFlags,
  numberIdeas,
  packFacts,
  shortSha,
  type FalseClaim,
} from './derive.js';

/**
 * The HTML companion: one self-contained file that draws the same page the
 * cockpit does, for the reviewer who has no LubbDubb — which is most reviewers on
 * most teams.
 *
 * **A pure function of the document, written beside it, never read back.** The
 * rule `docs/spec/28-cross-fleet-pool.md#the-human-readable-companion` states about
 * the pool's markdown, for the reason it gives: a second grammar for one fact is
 * free to disagree with the first, and it disagrees silently. Nothing here reads
 * the store, the tree or the clock — same record in, same bytes out.
 *
 * **It needs nothing checked out**, because the document carries its code, and it
 * needs no harness behind it: every fold is a `<details>` and the stylesheet is
 * inline, so there is no script and no request. It is read-only and **takes no
 * input** — a shared pack carries no marks, and a control that wrote one would
 * have nowhere to write to.
 *
 * The order is `docs/spec/31-review-packs.md#the-page`'s, the same order the
 * cockpit draws, because the layering *is* the product: what the change is, then
 * the code, then the reasoning folded under it.
 *
 * A pack stating a schema this build does not know is **refused whole**, exactly
 * as the cockpit refuses one: a page silently missing its false-claim banner
 * because the renderer was a version behind is the failure the subsystem exists to
 * catch, reproduced by the thing that reports it.
 */
export function renderReviewPackCompanion(record: ReviewPackRecord): string {
  const { pack } = record;
  if (pack.schema !== REVIEW_PACK_SCHEMA) return page(`Review pack · #${pack.prNumber}`, refusal(pack.schema));

  const numbered = numberIdeas(pack);
  const wrong = falseClaims(pack);
  const facts = packFacts(pack);
  const body = [
    `<header class="rp-mast">`,
    `<div class="rp-kicker"><span>Review pack</span> <code>#${pack.prNumber}</code> ` +
      `<code title="${esc(pack.headSha)}">${esc(shortSha(pack.headSha))}</code>` +
      (pack.witnessed ? '' : ` <span class="rp-unwitnessed">nobody witnessed this change</span>`) +
      `</div>`,
    `<h1>${esc(pack.headline)}</h1>`,
    `<div class="rp-plain">${markdown(pack.summary)}</div>`,
    `<div class="rp-facts">${facts_(facts, pack.estimatedMinutes)}</div>`,
    // Said on the page rather than only in the spec: a reader who found this file
    // in a wiki has no way to tell what it is downstream of, and the one thing they
    // must not do is treat it as the live view of a moving pull request.
    `<p class="rp-provenance">A rendering of the pack written against <code>${esc(pack.headSha)}</code> on ` +
      `${esc(record.writtenAt)}. It is a copy: it does not follow the pull request, it takes no input, and ` +
      `nothing here was re-checked when it was shared.</p>`,
    `</header>`,
    wrong.length > 0 ? gate(wrong) : '',
    `<div class="rp-rule"><span>The ${facts.ideas} ${facts.ideas === 1 ? 'idea' : 'ideas'} — open one to see the code</span>` +
      `<i>${numbered.by === 'order' ? 'numbered in the order the checker says to read them' : 'in document order — the checker has not ordered them'}</i></div>`,
    `<div class="rp-ideas">${numbered.ideas.map((entry) => ideaRow(entry.idea, entry.number, wrong)).join('')}</div>`,
    wrong.length > 0
      ? `<div class="rp-rule"><span>${wrong.length === 1 ? 'The one problem' : `The ${wrong.length} problems`}</span></div>` +
        wrong.map((item, i) => finding(item, i + 1)).join('')
      : '',
    spendTheTime(numbered, pack.estimatedMinutes),
    colophon(record),
  ];
  return page(`Review pack · #${pack.prNumber} · ${pack.headline}`, body.join('\n'));
}

/** Where one fleet's companion for a pull request's pack lives, beside the document. */
export function reviewPackCompanionPath(fleetId: string, prNumber: number): string {
  return `fleets/${fleetId}/packs/pr-${prNumber}.html`;
}

const ATTENTION_LABEL: Record<ReviewAttention, string> = {
  read: 'Read',
  decide: 'Decide',
  skim: 'Skim',
  split: 'Split',
};
const VERDICT_LABEL: Record<ReviewVerdict, string> = { true: 'True', false: 'False', cant_tell: 'Can’t tell' };

const pad = (n: number): string => String(n).padStart(2, '0');

function refusal(schema: number): string {
  return (
    `<div class="rp-refuse" role="alert"><h1>This pack cannot be shown.</h1>` +
    `<p>It states schema <code>${esc(String(schema))}</code>, and this renderer knows only schema ` +
    `<code>${esc(String(REVIEW_PACK_SCHEMA))}</code>. Drawing the parts it recognises could drop the parts that ` +
    `matter — a false claim, a finding — without saying so.</p></div>`
  );
}

function facts_(facts: ReturnType<typeof packFacts>, minutes: number): string {
  const claims =
    facts.claims.unchecked === facts.claims.total
      ? `${facts.claims.total} claims · unchecked`
      : `${facts.claims.total} claims · ${facts.claims.true} true · ${facts.claims.false} false · ` +
        `${facts.claims.cantTell} can’t tell` +
        (facts.claims.unchecked > 0 ? ` · ${facts.claims.unchecked} unchecked` : '');
  return [
    `<span><b>${facts.ideas}</b> ${facts.ideas === 1 ? 'idea' : 'ideas'}</span>`,
    `<span><b>${facts.files}</b> ${facts.files === 1 ? 'file' : 'files'}</span>`,
    `<span><b>${facts.changes}</b> ${facts.changes === 1 ? 'change' : 'changes'}, all owned</span>`,
    `<span>${esc(claims)}</span>`,
    `<span><b>~${minutes} min</b></span>`,
  ].join('');
}

/**
 * The gate: first thing after the masthead and above the ideas, so a reader cannot
 * reach the ideas without passing it. → `docs/spec/31-review-packs.md#what-a-false-claim-does`
 */
function gate(wrong: FalseClaim[]): string {
  const first = wrong[0]!;
  const rest = wrong.length - 1;
  return (
    `<div class="rp-gate" role="alert">` +
    `<span class="rp-gate-tag">${wrong.length} false ${wrong.length === 1 ? 'claim' : 'claims'}</span>` +
    `<p>${esc(first.claim.finding?.headline ?? first.claim.text)} — idea ${pad(first.number)}. ` +
    `<a href="#rp-finding-1">Read the finding</a> before anything else.` +
    (rest > 0 ? ` ${rest} more ${rest === 1 ? 'follows' : 'follow'} it.` : '') +
    `</p></div>`
  );
}

/**
 * One idea: the collapsed row a reader who opens nothing still sees, and the walk
 * and claims under it. Open by default here, unlike the cockpit's: there is no
 * address bar to hold which one is open, and a file a reviewer scrolls is better
 * open than clicked through.
 */
function ideaRow(idea: ReviewIdea, number: number, wrong: FalseClaim[]): string {
  const flags = ideaFlags(idea);
  const steps = idea.anchors.length;
  const changes = idea.anchors.filter((a) => a.kind === 'hunk').length;
  const raised = idea.claims.filter((c) => c.verdict === 'false' || c.provenance.kind === 'disputed');
  const meta =
    `${steps} ${steps === 1 ? 'step' : 'steps'} · ${changes} ${changes === 1 ? 'change' : 'changes'}` +
    (flags.falseClaims > 0
      ? ` · <span class="rp-flag">${flags.falseClaims} false ${flags.falseClaims === 1 ? 'claim' : 'claims'}</span>`
      : '') +
    (flags.disputed > 0
      ? ` · <span class="rp-flag rp-flag-disputed">${flags.disputed} ${flags.disputed === 1 ? 'dispute' : 'disputes'}</span>`
      : '');
  return (
    `<details class="rp-idea" open>` +
    `<summary><div class="rp-row"><span class="rp-n">${pad(number)}</span>` +
    attentionChip(idea.attention) +
    `<h3>${esc(idea.title)}</h3><span class="rp-meta">${meta}</span></div>` +
    (idea.cue !== null
      ? `<div class="rp-cue">${esc(idea.cue)}</div>`
      : `<div class="rp-cue rp-gap">no cue — the checker has not written one</div>`) +
    `</summary>` +
    `<div class="rp-panel">` +
    (raised.length > 0
      ? `<div class="rp-raised">${raised.map((c) => claimLine(c, findingIndex(wrong, idea, c))).join('')}</div>`
      : '') +
    `<ol class="rp-walk">${idea.anchors.map((a, i) => step(a, i + 1, number)).join('')}</ol>` +
    (idea.anchors.length === 0 ? `<p class="rp-gap">This idea has no walk — the author gave it no anchors.</p>` : '') +
    coveredBy(idea.coverage ?? []) +
    `<p class="rp-claims-head">What the author claims · checked by a second agent</p>` +
    `<ul class="rp-claims">${idea.claims.map((c) => `<li>${claimLine(c, findingIndex(wrong, idea, c))}</li>`).join('')}</ul>` +
    (idea.claims.length === 0 ? `<p class="rp-gap">The author made no claims for this idea.</p>` : '') +
    `</div></details>`
  );
}

/**
 * The scenarios the idea's tests cover, listed and never explained.
 *
 * Sits under the walk and above the claims because it answers the question the
 * walk raises — is this exercised? — for the reader who has just read the code,
 * rather than sending them to a tests section at the far end of the page.
 * → `docs/spec/31-review-packs.md#tests-are-never-an-idea`
 */
function coveredBy(coverage: readonly string[]): string {
  if (coverage.length === 0) return '';
  return (
    `<p class="rp-covered-head">Covered by</p>` +
    `<ul class="rp-covered">${coverage.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`
  );
}

function findingIndex(wrong: FalseClaim[], idea: ReviewIdea, claim: ReviewClaim): number | null {
  const i = wrong.findIndex((w) => w.idea === idea && w.claim === claim);
  return i < 0 ? null : i + 1;
}

function attentionChip(attention: ReviewAttention | null): string {
  return attention === null
    ? `<span class="rp-att rp-att-none">—</span>`
    : `<span class="rp-att rp-att-${attention}">${ATTENTION_LABEL[attention]}</span>`;
}

function step(anchor: ReviewAnchor, index: number, ideaNumber: number): string {
  const region = anchor.kind === 'region';
  const counts = diffCounts(anchor.code);
  const tag = region
    ? `<span class="rp-tag rp-tag-region">not in this PR</span>`
    : `<span class="rp-tag rp-tag-diff">changed ${counts.added > 0 ? `+${counts.added}` : ''} ${counts.removed > 0 ? `−${counts.removed}` : ''}</span>`;
  const mark =
    anchor.mark === 'key'
      ? `<span class="rp-tag rp-tag-key">the important bit</span>`
      : anchor.mark === 'false'
        ? `<span class="rp-tag rp-tag-false">claim is false</span>`
        : anchor.mark === 'disputed'
          ? `<span class="rp-tag rp-tag-disputed">witness disagrees</span>`
          : '';
  const note = anchor.note;
  return (
    `<li class="rp-step${region ? ' rp-dashed' : ''}${anchor.mark !== null ? ` rp-mark-${anchor.mark}` : ''}">` +
    `<div class="rp-step-head"><span class="rp-step-n">${pad(ideaNumber)}.${index}</span>` +
    `<span class="rp-path">${rangeLabel(anchor.range)}</span>${tag}${mark}</div>` +
    `<p class="rp-gist">${esc(anchor.gist)}</p>` +
    codeBlock(anchor.code, anchor.caption, region, !region, anchor.range.path) +
    (note === null
      ? ''
      : `<details class="rp-why"${anchor.mark === 'false' || anchor.mark === 'disputed' ? ' open' : ''}>` +
        `<summary><span class="rp-stamp">${note.by === 'witness' ? `witness · ${esc(note.at)}` : 'added afterwards'}</span><span> why</span></summary>` +
        // Plain text with its newlines, for the notepad's reason: a note is
        // testimony, and rendering it would let a stray backtick change what the
        // testimony looks like.
        `<div class="rp-why-body">${esc(note.text)}</div></details>`) +
    `</li>`
  );
}

function rangeLabel(range: ReviewRange): string {
  return `${esc(range.path)}<b>:${range.start}${range.end > range.start ? `–${range.end}` : ''}</b>`;
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
 * A code block: the caption, then the lines with their diff marker in a column of
 * its own rather than as the first character of the code.
 * → `docs/spec/31-review-packs.md#the-code-block`
 *
 * The marker span is `aria-hidden` and unselectable, so a reader who copies the
 * block gets the code and not a diff — the tint and the gutter say which lines
 * moved, and neither is part of the text. Where there is no gutter there is no
 * tint either: every line is the same kind, the step's tag has already said which,
 * and a screen of solid green reads worse than the code does.
 */
function codeBlock(
  code: readonly string[],
  caption: string | null,
  dashed: boolean,
  diff: boolean,
  path: string,
): string {
  const { gutter, lines: split } = codeBlockLines(code, diff);
  const coloured = highlightCode(
    split.map((l) => l.text),
    codeLanguage(path),
  );
  const rendered = split.map(({ marker, text }, i) => {
    const cls = !gutter ? '' : marker === '+' ? ' rp-add' : marker === '-' ? ' rp-del' : '';
    const mark = gutter ? `<span class="rp-m" aria-hidden="true">${esc(marker ?? ' ')}</span>` : '';
    const body = coloured[i] ?? [{ kind: 'plain' as const, text }];
    const runs = body
      .map((run) => (run.kind === 'plain' ? esc(run.text) : `<span class="rp-hl-${run.kind}">${esc(run.text)}</span>`))
      .join('');
    return `<span class="rp-l${cls}">${mark}<span class="rp-t">${runs}</span>\n</span>`;
  });
  // A block longer than this is scrolled past rather than read, and on this page
  // one of them buries the two ideas under it. The tail is folded rather than
  // dropped: everything the document carries is still in the file, still copyable,
  // and the fold is a `<details>` because the companion runs no script.
  const clip = rendered.length > HEAD_LINES + TAIL_MARGIN ? HEAD_LINES : rendered.length;
  const head = rendered.slice(0, clip).join('');
  const rest = rendered.slice(clip);
  return (
    `<div class="rp-code${dashed ? ' rp-dashed' : ''}${gutter ? ' rp-gutter' : ''}">` +
    (caption !== null || rest.length > 0
      ? `<div class="rp-code-cap">${esc(caption ?? '')}` +
        (rest.length > 0 ? `<span class="rp-code-len">${rendered.length} lines</span>` : '') +
        `</div>`
      : '') +
    `<pre>${head || `<span class="rp-l rp-gap">(no lines)</span>`}</pre>` +
    (rest.length > 0
      ? `<details class="rp-rest"><summary>${rest.length} more ${rest.length === 1 ? 'line' : 'lines'}</summary>` +
        `<pre>${rest.join('')}</pre></details>`
      : '') +
    `</div>`
  );
}

/** How much of a code block is shown before the rest is folded, and the slack that stops a fold saving nothing. */
const HEAD_LINES = 20;
const TAIL_MARGIN = 6;

/**
 * One claim, with its verdict, its evidence and where it came from. A `witnessed`
 * or `disputed` claim cites its pad entry by id and **the entry is not here**: the
 * pads are the fleet's own record and a shared pack carries the document alone, so
 * the citation is drawn as one rather than as a blank the reader might read as
 * nothing having been said.
 */
function claimLine(claim: ReviewClaim, findingAt: number | null): string {
  const cited = claim.provenance.kind === 'inferred' ? null : claim.provenance.entryId;
  return (
    `<div class="rp-claim${claim.verdict === 'false' ? ' rp-claim-false' : ''}">` +
    (claim.verdict === null
      ? `<span class="rp-v rp-v-none">Unchecked</span>`
      : `<span class="rp-v rp-v-${claim.verdict === 'cant_tell' ? 'un' : claim.verdict}">${VERDICT_LABEL[claim.verdict]}</span>`) +
    `<span class="rp-claim-body"><span class="rp-prov rp-prov-${claim.provenance.kind}">${claim.provenance.kind}</span> ` +
    esc(claim.text) +
    (claim.evidence !== null ? ` <span class="rp-evidence">${esc(claim.evidence)}</span>` : '') +
    (claim.verdict === 'cant_tell' ? ` <strong>You decide.</strong>` : '') +
    (findingAt !== null ? ` <a href="#rp-finding-${findingAt}">Read the finding</a>` : '') +
    (cited !== null
      ? `<blockquote class="rp-entry"><span class="rp-gap">cites pad entry <code>${esc(cited)}</code>, ` +
        `which stayed on the fleet that wrote it — a shared pack carries the document and nothing else.</span></blockquote>`
      : '') +
    `</span></div>`
  );
}

/** The page's most important prose: the two pieces of code that disagree, then the consequence. */
function finding(item: FalseClaim, index: number): string {
  const found = item.claim.finding;
  const stepNumber = found?.step ?? null;
  const marked = stepNumber !== null ? (item.idea.anchors[stepNumber - 1] ?? null) : null;
  const pair =
    (marked !== null
      ? codeBlock(
          marked.code,
          `step ${stepNumber} — ${marked.range.path}:${marked.range.start}${marked.caption !== null ? ` — ${marked.caption}` : ''}`,
          marked.kind === 'region',
          marked.kind === 'hunk',
          marked.range.path,
        )
      : `<p class="rp-gap">No step of the walk fits this claim; the code below is where the tree disagrees.</p>`) +
    (found?.counter != null
      ? codeBlock(
          found.counter.code,
          `${found.counter.range.path}:${found.counter.range.start} — ${found.counter.caption}`,
          false,
          false,
          found.counter.range.path,
        )
      : '');
  return (
    `<section class="rp-finding" id="rp-finding-${index}">` +
    `<h3>${esc(found?.headline ?? item.claim.text)}</h3>` +
    `<p class="rp-finding-where">Idea ${pad(item.number)}, claim ${item.claimNumber}: “${esc(item.claim.text)}”` +
    (item.claim.evidence !== null ? ` <span class="rp-evidence">${esc(item.claim.evidence)}</span>` : '') +
    `</p>` +
    (found === null
      ? `<p class="rp-gap">The claim is marked false but carries no finding — the document is missing one.</p>`
      : `<div class="rp-pair">${pair}</div><div class="rp-finding-body">${markdown(found.body)}</div>`) +
    `</section>`
  );
}

/** `attention` made actionable: the ideas in reading order, each with the reason. */
function spendTheTime(numbered: ReturnType<typeof numberIdeas>, minutes: number): string {
  if (numbered.by === 'document') {
    return (
      `<div class="rp-rule"><span>Where to spend the ${minutes} minutes</span></div>` +
      `<p class="rp-gap">The checker has not ordered the ideas, so there is no reading order to give yet.</p>`
    );
  }
  const items = numbered.ideas
    .map(
      ({ idea, number }) =>
        `<li><strong>Idea ${pad(number)}${idea.attention !== null ? ` — ${ATTENTION_LABEL[idea.attention].toLowerCase()}` : ''}:</strong> ` +
        `${esc(idea.title)}${idea.cue !== null ? ` <span class="rp-order-cue">${esc(idea.cue)}</span>` : ''}</li>`,
    )
    .join('');
  return `<div class="rp-rule"><span>Where to spend the ${minutes} minutes</span></div><ol class="rp-order">${items}</ol>`;
}

function colophon(record: ReviewPackRecord): string {
  const { pack } = record;
  return (
    `<details class="rp-colophon"><summary>How this pack was put together, and what in it is fake</summary>` +
    `<p><b>The notes.</b> ${
      pack.witnessed
        ? 'The agents that wrote the change recorded their forks as they went, on the shared pad; the author grouped those into the ideas afterwards and could not edit what was already written.'
        : 'Nobody witnessed this change — no fork was recorded while it was written, so the author worked from the diff and the tree alone: every claim is inferred, and nothing here is anybody’s testimony.'
    }</p>` +
    `<p><b>The checking.</b> A second agent was handed the claims and the tree and none of the author’s reasoning, ` +
    `and marked each claim true, false or can’t tell. Nothing here blocks a merge; a person decides.</p>` +
    `<p><b>Dashed boxes</b> are files that are <em>not</em> in the pull request — shown because the change cannot ` +
    `be judged without them, or because they are the file a reader would expect to have changed and deliberately ` +
    `did not.</p>` +
    `<p><b>What is fake.</b> ${esc(pack.fake)}</p>` +
    `<p class="rp-colophon-meta">Written ${esc(record.writtenAt)} against <code>${esc(pack.headSha)}</code>, ` +
    `and shared as a copy: this file has no harness behind it and is never read back by one.</p></details>`
  );
}

/** The whole file: one document, one stylesheet, no script and no request. */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
${STYLE}
</style>
</head>
<body>
<main class="rp">
${body}
</main>
</body>
</html>
`;
}

/**
 * Every colour is a custom property on `:root`, the cockpit's rule
 * (`docs/spec/17-cockpit.md#tokens`) applied to a file that has no cockpit behind
 * it: a hex at a use site is a colour nothing can reach, and this page has a dark
 * scheme to answer as well as a light one.
 */
const STYLE = `:root {
  color-scheme: light dark;
  --rp-bg: #fbfbfa; --rp-fg: #23211d; --rp-dim: #6c675f; --rp-line: #dcd8d0;
  --rp-panel: #ffffff; --rp-code-bg: #f5f3ef; --rp-accent: #3c5a8a;
  --rp-bad: #a33b34; --rp-bad-bg: #fdeceb; --rp-warn: #8a6a1f; --rp-ok: #3d6b46;
  --rp-add: #2f6b3d; --rp-del: #a33b34;
  /* Syntax. Four kinds and no more: the parts a scanner without a parser can name
     without ever being confidently wrong. */
  --rp-hl-comment: #7a8a6f; --rp-hl-string: #7a5a2a; --rp-hl-number: #7a5a2a; --rp-hl-keyword: #6a4d8a;
}
@media (prefers-color-scheme: dark) {
  :root {
    --rp-bg: #17171a; --rp-fg: #e6e3dd; --rp-dim: #9b958b; --rp-line: #34333a;
    --rp-panel: #1e1e22; --rp-code-bg: #131316; --rp-accent: #8fb0e0;
    --rp-bad: #e8867d; --rp-bad-bg: #3a1f1e; --rp-warn: #d8b35e; --rp-ok: #86c294;
    --rp-add: #86c294; --rp-del: #e8867d;
    --rp-hl-comment: #7f8f78; --rp-hl-string: #d3a76a; --rp-hl-number: #d3a76a; --rp-hl-keyword: #b79bd8;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--rp-bg); color: var(--rp-fg);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.rp { max-width: 60rem; margin: 0 auto; padding: 2rem 1.25rem 6rem; }
h1 { font-size: 1.7rem; line-height: 1.25; margin: .4rem 0; }
h3 { font-size: 1rem; margin: 0; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .86em; }
a { color: var(--rp-accent); }
.rp-kicker { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; color: var(--rp-dim); font-size: .85rem; }
.rp-unwitnessed { color: var(--rp-warn); }
.rp-facts { display: flex; flex-wrap: wrap; gap: 1rem; color: var(--rp-dim); font-size: .85rem; margin-top: .75rem;
  border-top: 1px solid var(--rp-line); border-bottom: 1px solid var(--rp-line); padding: .5rem 0; }
.rp-provenance, .rp-colophon-meta { color: var(--rp-dim); font-size: .8rem; }
.rp-gate { border: 2px solid var(--rp-bad); background: var(--rp-bad-bg); border-radius: 6px;
  padding: .75rem 1rem; margin: 1.25rem 0; }
.rp-gate-tag { color: var(--rp-bad); font-weight: 700; text-transform: uppercase; font-size: .75rem; letter-spacing: .04em; }
.rp-gate p { margin: .35rem 0 0; }
.rp-rule { display: flex; align-items: baseline; gap: .75rem; margin: 2rem 0 .75rem;
  border-bottom: 1px solid var(--rp-line); padding-bottom: .35rem; font-weight: 600; }
.rp-rule i { font-weight: 400; color: var(--rp-dim); font-size: .8rem; }
.rp-idea { background: var(--rp-panel); border: 1px solid var(--rp-line); border-radius: 6px;
  margin-bottom: .6rem; padding: .6rem .85rem; }
.rp-idea summary { cursor: pointer; list-style: none; position: sticky; top: 0; z-index: 2;
  background: var(--rp-panel); padding: .5rem 0; margin: -.5rem 0 0; border-bottom: 1px solid var(--rp-line); }
.rp-row { display: flex; flex-wrap: wrap; gap: .6rem; align-items: baseline; }
.rp-n { color: var(--rp-dim); font-variant-numeric: tabular-nums; }
.rp-meta, .rp-cue { color: var(--rp-dim); font-size: .82rem; }
.rp-cue { margin-top: .25rem; }
.rp-gap { color: var(--rp-dim); font-style: italic; }
.rp-flag { color: var(--rp-bad); font-weight: 600; }
.rp-flag-disputed { color: var(--rp-warn); }
.rp-att { border: 1px solid var(--rp-line); border-radius: 999px; padding: 0 .5rem; font-size: .72rem;
  text-transform: uppercase; letter-spacing: .04em; }
.rp-att-read { color: var(--rp-bad); border-color: var(--rp-bad); }
.rp-att-decide { color: var(--rp-warn); border-color: var(--rp-warn); }
.rp-att-skim { color: var(--rp-dim); }
.rp-att-split { color: var(--rp-accent); border-color: var(--rp-accent); }
.rp-panel { padding-top: .75rem; }
.rp-walk { list-style: none; margin: 0; padding: 0; border-left: 2px solid var(--rp-line); }
.rp-step { padding: .5rem 0 .5rem 1rem; }
.rp-step-head { display: flex; flex-wrap: wrap; gap: .5rem; align-items: baseline; }
.rp-step-n { color: var(--rp-dim); font-variant-numeric: tabular-nums; }
.rp-tag { font-size: .72rem; color: var(--rp-dim); border: 1px solid var(--rp-line); border-radius: 3px; padding: 0 .35rem; }
.rp-tag-region { border-style: dashed; }
.rp-tag-key { color: var(--rp-accent); border-color: var(--rp-accent); }
.rp-tag-false { color: var(--rp-bad); border-color: var(--rp-bad); }
.rp-tag-disputed { color: var(--rp-warn); border-color: var(--rp-warn); }
.rp-gist { margin: .35rem 0; }
.rp-code { border: 1px solid var(--rp-line); border-radius: 4px; background: var(--rp-code-bg); overflow: hidden; }
.rp-code.rp-dashed { border-style: dashed; }
.rp-code-cap { display: flex; justify-content: space-between; gap: 1rem; padding: .25rem .5rem;
  border-bottom: 1px solid var(--rp-line); color: var(--rp-dim); font-size: .78rem; }
.rp-code-len { font-variant-numeric: tabular-nums; }
.rp-rest > summary { cursor: pointer; padding: .25rem .5rem; border-top: 1px solid var(--rp-line);
  color: var(--rp-dim); font-size: .78rem; }
.rp-rest > pre { border-top: 1px solid var(--rp-line); }
.rp-code pre { margin: 0; padding: .5rem; overflow-x: auto; }
.rp-l { display: block; white-space: pre; }
.rp-m { display: inline-block; width: 1ch; margin-right: .75ch; color: var(--rp-dim); user-select: none; }
.rp-t { white-space: pre; }
.rp-hl-comment { color: var(--rp-hl-comment); font-style: italic; }
.rp-hl-string { color: var(--rp-hl-string); }
.rp-hl-number { color: var(--rp-hl-number); }
.rp-hl-keyword { color: var(--rp-hl-keyword); }
.rp-add { color: var(--rp-add); background: color-mix(in srgb, var(--rp-add) 12%, transparent); }
.rp-del { color: var(--rp-del); background: color-mix(in srgb, var(--rp-del) 12%, transparent); }
.rp-why { margin-top: .4rem; }
.rp-why summary { cursor: pointer; color: var(--rp-dim); font-size: .8rem; }
.rp-stamp { color: var(--rp-dim); }
.rp-why-body { white-space: pre-wrap; color: var(--rp-dim); padding: .35rem 0 0 .75rem; }
.rp-covered-head { font-weight: 600; margin: 1rem 0 .35rem; }
.rp-covered { margin: 0; padding-left: 1.1rem; color: var(--rp-dim); }
.rp-covered li { margin-bottom: .2rem; }
.rp-claims-head { font-weight: 600; margin: 1rem 0 .35rem; }
.rp-claims { list-style: none; margin: 0; padding: 0; }
.rp-claims li { margin-bottom: .4rem; }
.rp-claim { display: flex; gap: .5rem; align-items: baseline; }
.rp-claim-false { color: var(--rp-bad); }
.rp-v { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; border: 1px solid var(--rp-line);
  border-radius: 3px; padding: 0 .35rem; white-space: nowrap; }
.rp-v-true { color: var(--rp-ok); border-color: var(--rp-ok); }
.rp-v-false { color: var(--rp-bad); border-color: var(--rp-bad); }
.rp-v-un, .rp-v-none { color: var(--rp-dim); }
.rp-prov { color: var(--rp-dim); font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; }
.rp-evidence { color: var(--rp-dim); }
.rp-entry { margin: .35rem 0 .35rem .5rem; padding-left: .6rem; border-left: 2px solid var(--rp-line); }
.rp-finding { border: 2px solid var(--rp-bad); border-radius: 6px; padding: 1rem; margin-bottom: 1rem;
  background: var(--rp-panel); }
.rp-pair { display: grid; gap: .5rem; }
.rp-order li { margin-bottom: .35rem; }
.rp-order-cue { color: var(--rp-dim); }
.rp-colophon { margin-top: 2.5rem; color: var(--rp-dim); font-size: .85rem; }
.rp-colophon summary { cursor: pointer; }
.rp-refuse { border: 2px solid var(--rp-bad); background: var(--rp-bad-bg); border-radius: 6px; padding: 1rem; }
table { border-collapse: collapse; }
th, td { border: 1px solid var(--rp-line); padding: .25rem .5rem; text-align: left; }`;

/** Escaped for HTML text and for a double-quoted attribute alike, so one function serves both. */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The two markdown fields the document carries — the author's `summary` and the
 * checker's `body` — as HTML.
 *
 * **Deliberately small**: paragraphs, bullets, pipe tables, and inline bold,
 * italic, code and links. The escaping happens first and the markup is added
 * after, so nothing an agent wrote can reach the page as markup. Anything richer
 * renders as its own plain text rather than as a surprise — a companion is a page
 * a reviewer reads, not a document format.
 */
function markdown(text: string): string {
  const blocks = text.split(/\n{2,}/);
  return blocks
    .map((block) => {
      const lines = block.split('\n').filter((line) => line.trim() !== '');
      if (lines.length === 0) return '';
      if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
        return `<ul>${lines.map((line) => `<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
      }
      if (lines.length >= 2 && lines.every((line) => line.trim().startsWith('|'))) return table(lines);
      const heading = /^(#{1,4})\s+(.*)$/.exec(lines[0]!);
      if (lines.length === 1 && heading) {
        const level = Math.min(heading[1]!.length + 2, 6);
        return `<h${level}>${inline(heading[2]!)}</h${level}>`;
      }
      return `<p>${lines.map((line) => inline(line)).join('<br>')}</p>`;
    })
    .join('');
}

function table(lines: string[]): string {
  const cells = (line: string): string[] =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim());
  const rows = lines.filter((line) => !/^\s*\|[\s:|-]+\|\s*$/.test(line));
  const [head, ...rest] = rows;
  if (head === undefined) return '';
  return (
    `<table><thead><tr>${cells(head)
      .map((c) => `<th>${inline(c)}</th>`)
      .join('')}</tr></thead><tbody>` +
    rest
      .map(
        (row) =>
          `<tr>${cells(row)
            .map((c) => `<td>${inline(c)}</td>`)
            .join('')}</tr>`,
      )
      .join('') +
    `</tbody></table>`
  );
}

/** Inline markdown over already-escaped text: code first, so nothing inside a span is re-read. */
function inline(text: string): string {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
}
