import { REVIEW_PACK_SCHEMA } from '../store/reviewPacks.js';
import type {
  ReviewAnchor,
  ReviewAttention,
  ReviewClaim,
  ReviewIdea,
  ReviewPack,
  ReviewPackRecord,
  ReviewRange,
  ReviewVerdict,
} from '../types.js';
import {
  anchorWeight,
  codeBlockLines,
  codeLanguage,
  falseClaims,
  highlightCode,
  ideaAtom,
  ideaFlags,
  numberIdeas,
  packFacts,
  plainSummary,
  shortSha,
  splitBody,
  testScenarios,
  type FalseClaim,
} from './derive.js';

// → docs/spec/31-review-packs.md

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
    `<div class="rp-plain">${markdown(plainSummary(pack.summary))}</div>`,
    `<div class="rp-facts">${facts_(facts, pack.estimatedMinutes)}</div>`,
    `<p class="rp-provenance">A rendering of the pack written against <code>${esc(pack.headSha)}</code> on ` +
      `${esc(record.writtenAt)}. It is a copy: it does not follow the pull request, it takes no input, and ` +
      `nothing here was re-checked when it was shared.</p>`,
    `</header>`,
    wrong.length > 0 ? gate(wrong) : '',
    `<div class="rp-rule"><span>The ${facts.ideas} ${facts.ideas === 1 ? 'idea' : 'ideas'} — open one to see the code</span>` +
      `<i>${numbered.by === 'order' ? 'numbered in the order the checker says to read them' : 'in document order — the checker has not ordered them'}</i></div>`,
    `<div class="rp-ideas">${numbered.ideas.map((entry) => ideaRow(pack, entry.idea, entry.number, wrong)).join('')}</div>`,
    wrong.length > 0
      ? `<div class="rp-rule"><span>${wrong.length === 1 ? 'The one problem' : `The ${wrong.length} problems`}</span></div>` +
        wrong.map((item, i) => finding(item, i + 1)).join('')
      : '',
    spendTheTime(numbered, pack.estimatedMinutes),
    colophon(record),
  ];
  return page(
    `Review pack · #${pack.prNumber} · ${pack.headline}`,
    `<div class="rp-wrap">${contents(numbered)}<main class="rp-main" id="rp-top">${body.join('\n')}</main></div>`,
  );
}

function contents(numbered: ReturnType<typeof numberIdeas>): string {
  const rows = numbered.ideas
    .map(({ idea, number }) => {
      const steps = idea.anchors
        .map((a, i) => {
          const weight = anchorWeight(a);
          const name = a.range.path.split('/').pop() ?? a.range.path;
          return (
            `<li class="rp-c-${weight}"><a href="#rp-s${number}-${i + 1}">` +
            `<span class="rp-c-n">${pad(number)}.${i + 1}</span> <span>${esc(name)}</span></a></li>`
          );
        })
        .join('');
      return (
        `<div class="rp-c-grp"><a class="rp-c-idea" href="#rp-i${number}">` +
        `<span class="rp-c-n">${pad(number)}</span> <span>${esc(idea.title)}</span></a>` +
        (idea.attention === null ? '' : ` ${attentionChip(idea.attention)}`) +
        `<ol>${steps}</ol></div>`
      );
    })
    .join('');
  return (
    `<nav class="rp-rail" aria-label="Contents">` +
    `<div class="rp-c-grp"><a class="rp-c-idea" href="#rp-top"><span class="rp-c-n">↑</span> <span>Top</span></a></div>` +
    rows +
    `</nav>`
  );
}

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

function ideaRow(pack: ReviewPack, idea: ReviewIdea, number: number, wrong: FalseClaim[]): string {
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
    `<details class="rp-idea" id="rp-i${number}" open>` +
    `<summary><div class="rp-row"><span class="rp-n">${pad(number)}</span>` +
    attentionChip(idea.attention) +
    `<h3>${esc(idea.title)}</h3><span class="rp-meta">${meta}</span></div>` +
    (idea.cue !== null
      ? `<div class="rp-cue">${esc(idea.cue)}</div>`
      : `<div class="rp-cue rp-gap">no cue — the checker has not written one</div>`) +
    atomLine(pack, idea) +
    `</summary>` +
    `<div class="rp-panel">` +
    (raised.length > 0
      ? `<div class="rp-raised${raised.some((c) => c.verdict === 'false') ? ' rp-raised-false' : ''}">` +
        `${raised.map((c) => claimLine(c, findingIndex(wrong, idea, c))).join('')}</div>`
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
 * The atom this idea corresponds to, under the cue. An idea no atom covers is drawn
 * as the finding it is; a pack with no atoms behind it draws nothing.
 * → docs/spec/31-review-packs.md#an-idea-the-atoms-do-not-cover-is-a-finding
 */
function atomLine(pack: ReviewPack, idea: ReviewIdea): string {
  const atom = ideaAtom(pack, idea);
  if (atom.kind === 'none') return '';
  if (atom.kind === 'declared') return `<div class="rp-atom">atom <code>${esc(atom.slug)}</code></div>`;
  return (
    `<div class="rp-atom rp-atom-none">no atom — the plan did not declare this work, ` +
    `which is what makes it worth a look</div>`
  );
}

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
  const weight = anchorWeight(anchor);
  const counts = diffCounts(anchor.code);
  const meta = region
    ? 'unchanged'
    : [counts.added > 0 ? `+${counts.added}` : '', counts.removed > 0 ? `−${counts.removed}` : '']
        .filter((part) => part !== '')
        .join(' ') + (weight === 'minor' ? ' · mechanical' : '');
  const mark =
    anchor.mark === 'key'
      ? `<span class="rp-tag rp-tag-key">the important bit</span>`
      : anchor.mark === 'false'
        ? `<span class="rp-tag rp-tag-false">claim is false</span>`
        : anchor.mark === 'disputed'
          ? `<span class="rp-tag rp-tag-disputed">witness disagrees</span>`
          : '';
  const scenarios = testScenarios(anchor.range.path, anchor.code);
  const code = codeBlock(anchor.code, anchor.caption, region, !region, anchor.range.path);
  const folded = (body: string): string =>
    `<details class="rp-minor-code"><summary>show the ${anchor.code.length} ` +
    `${anchor.code.length === 1 ? 'line' : 'lines'}</summary>${body}</details>`;
  const note = anchor.note;
  return (
    `<li class="rp-step rp-w-${weight}${region ? ' rp-dashed' : ''}${anchor.mark !== null ? ` rp-mark-${anchor.mark}` : ''}" ` +
    `id="rp-s${ideaNumber}-${index}">` +
    `<div class="rp-step-head"><span class="rp-step-n">${pad(ideaNumber)}.${index}</span>` +
    `<span class="rp-path">${rangeLabel(anchor.range)}</span>${mark}` +
    `<span class="rp-step-meta">${esc(meta)}</span></div>` +
    `<p class="rp-gist">${esc(anchor.gist)}</p>` +
    (region
      ? `<p class="rp-region-note">This file is not in the pull request. The author is showing it to you on ` +
        `purpose — either the change cannot be judged without it, or it is the file you would expect to have ` +
        `changed and deliberately did not.</p>`
      : '') +
    (scenarios.length > 0
      ? `<div class="rp-scenarios"><p class="rp-scenarios-head">The ${scenarios.length} ` +
        `${scenarios.length === 1 ? 'case' : 'cases'} it covers</p>` +
        `<ul>${scenarios.map((name) => `<li>${esc(name)}</li>`).join('')}</ul>${folded(code)}</div>`
      : weight === 'minor'
        ? folded(code)
        : code) +
    (note === null
      ? ''
      : `<details class="rp-why"${anchor.mark === 'false' || anchor.mark === 'disputed' ? ' open' : ''}>` +
        `<summary><span class="rp-stamp">${note.by === 'witness' ? `witness · ${esc(note.at)}` : 'added afterwards'}</span><span> why</span></summary>` +
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

const HEAD_LINES = 20;
const TAIL_MARGIN = 6;

function claimLine(claim: ReviewClaim, findingAt: number | null): string {
  const cited = claim.provenance.kind === 'inferred' ? null : claim.provenance.entryId;
  return (
    `<div class="rp-claim${claim.verdict === 'false' ? ' rp-claim-false' : ''}">` +
    (claim.verdict === null
      ? `<span class="rp-v rp-v-none">Unchecked</span>`
      : `<span class="rp-v rp-v-${claim.verdict === 'cant_tell' ? 'un' : claim.verdict}">${VERDICT_LABEL[claim.verdict]}</span>`) +
    `<span class="rp-claim-body"><span class="rp-claim-text">${esc(claim.text)}</span>` +
    (claim.provenance.kind === 'disputed' ? ` <span class="rp-tag rp-tag-disputed">witness disagrees</span>` : '') +
    (claim.verdict === 'cant_tell' ? ` <strong class="rp-claim-yours">You decide.</strong>` : '') +
    (findingAt !== null ? ` <a href="#rp-finding-${findingAt}">Read the finding</a>` : '') +
    (claim.evidence !== null
      ? `<details class="rp-evidence"><summary>how it was checked</summary>` +
        `<div class="rp-evidence-body">${esc(claim.evidence)}</div></details>`
      : '') +
    (cited !== null
      ? `<blockquote class="rp-entry"><span class="rp-gap">cites pad entry <code>${esc(cited)}</code>, ` +
        `which stayed on the fleet that wrote it — a shared pack carries the document and nothing else.</span></blockquote>`
      : '') +
    `</span></div>`
  );
}

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
  const split = found === null ? { lead: '', rest: '' } : splitBody(found.body);
  return (
    `<section class="rp-finding" id="rp-finding-${index}">` +
    `<h3>${esc(found?.headline ?? item.claim.text)}</h3>` +
    `<p class="rp-finding-where">Idea ${pad(item.number)}, claim ${item.claimNumber}: “${esc(item.claim.text)}”</p>` +
    (found === null
      ? `<p class="rp-gap">The claim is marked false but carries no finding — the document is missing one.</p>`
      : `<div class="rp-finding-lead">${markdown(split.lead)}</div><div class="rp-pair">${pair}</div>` +
        (split.rest === ''
          ? ''
          : `<details class="rp-finding-more"><summary>the rest of the finding</summary>` +
            `<div class="rp-finding-body">${markdown(split.rest)}</div></details>`)) +
    `</section>`
  );
}

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
.rp { max-width: 76rem; margin: 0 auto; padding: 2rem 1.25rem 6rem; }
/* The rail and the page beside it. The rail is the one screen a reader can come
   back to: every idea is open here, so nothing else on the page is a map of it.
   → docs/spec/31-review-packs.md#the-contents-rail */
.rp-wrap { display: grid; grid-template-columns: 15rem minmax(0, 1fr); gap: 2rem; align-items: start; }
.rp-main { min-width: 0; }
.rp-rail { position: sticky; top: 1rem; max-height: calc(100vh - 2rem); overflow: auto; font-size: .85rem; }
.rp-c-grp { margin-bottom: .8rem; }
.rp-c-idea { display: flex; gap: .4rem; font-weight: 600; text-decoration: none; color: var(--rp-fg); padding: .15rem 0; }
.rp-c-idea:hover { text-decoration: underline; }
.rp-rail ol { list-style: none; margin: .15rem 0 0; padding: 0; border-left: 2px solid var(--rp-line); }
.rp-rail ol a { display: flex; gap: .4rem; padding: .1rem .55rem; color: var(--rp-dim); text-decoration: none;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rp-rail ol a:hover { color: var(--rp-fg); background: var(--rp-panel); }
.rp-rail .rp-c-n { font-variant-numeric: tabular-nums; color: var(--rp-dim); }
.rp-rail li.rp-c-minor a { opacity: .55; }
.rp-rail li.rp-c-key a { color: var(--rp-fg); font-weight: 600; }
.rp-rail li.rp-c-key .rp-c-n { color: var(--rp-accent); }
/* No rail below the width that would leave the page too narrow to read: it folds
   to the top of the document, where it is still a map and costs no column. */
@media (max-width: 60rem) {
  .rp-wrap { grid-template-columns: minmax(0, 1fr); gap: 1rem; }
  .rp-rail { position: static; max-height: none; border-bottom: 1px solid var(--rp-line); padding-bottom: .5rem; }
}
/* A mechanical stop — an import block, or two changed lines or fewer — drawn quiet,
   because a walk that gives it the weight of a fifty-line function is unreadable.
   → docs/spec/31-review-packs.md#how-hard-to-look-at-one-stop */
.rp-step.rp-w-minor { opacity: .62; padding: .2rem 0 .3rem 1rem; }
.rp-step.rp-w-minor .rp-gist { margin: .15rem 0; font-size: .9rem; }
.rp-step.rp-w-minor:hover, .rp-step.rp-w-minor:focus-within { opacity: 1; }
.rp-step.rp-w-key { border-left: 2px solid var(--rp-accent); margin-left: -1rem; padding-left: calc(1rem - 2px); }
.rp-minor-code > summary { cursor: pointer; color: var(--rp-dim); font-size: .78rem; padding: .15rem 0; }
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
.rp-atom { margin-top: .25rem; color: var(--rp-dim); font-size: .78rem; }
.rp-atom-none { color: var(--rp-warn); font-style: italic; }
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
.rp-raised { border: 1px solid var(--rp-warn); border-radius: 4px; padding: .5rem .6rem; margin-bottom: .6rem; }
.rp-raised-false { border-color: var(--rp-bad); }
.rp-walk { list-style: none; margin: 0; padding: 0; border-left: 2px solid var(--rp-line); }
.rp-step { padding: .5rem 0 .5rem 1rem; }
.rp-step-head { display: flex; flex-wrap: wrap; gap: .5rem; align-items: baseline; }
.rp-step-n { color: var(--rp-dim); font-variant-numeric: tabular-nums; }
.rp-tag { font-size: .72rem; color: var(--rp-dim); border: 1px solid var(--rp-line); border-radius: 3px; padding: 0 .35rem; }
.rp-tag-key { color: var(--rp-accent); border-color: var(--rp-accent); }
.rp-tag-false { color: var(--rp-bad); border-color: var(--rp-bad); }
.rp-tag-disputed { color: var(--rp-warn); border-color: var(--rp-warn); }
.rp-gist { margin: .35rem 0; }
.rp-step-meta { margin-left: auto; color: var(--rp-dim); font-size: .72rem; font-variant-numeric: tabular-nums; }
.rp-region-note { margin: 0 0 .4rem; color: var(--rp-dim); font-size: .85rem; max-width: 78ch; }
.rp-scenarios ul { margin: 0 0 .4rem; padding-left: 1.1rem; }
.rp-scenarios li { margin-bottom: .15rem; }
.rp-scenarios-head { margin: 0 0 .25rem; color: var(--rp-dim); font-size: .75rem; text-transform: uppercase;
  letter-spacing: .04em; }
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
.rp-claim-body { flex: 1; }
.rp-claim-yours { color: var(--rp-warn); }
.rp-evidence { margin-top: .2rem; }
.rp-evidence > summary { cursor: pointer; color: var(--rp-dim); font-size: .78rem; }
.rp-evidence-body { margin-top: .25rem; padding-left: .6rem; border-left: 1px solid var(--rp-line);
  color: var(--rp-dim); font-size: .85rem; }
.rp-entry { margin: .35rem 0 .35rem .5rem; padding-left: .6rem; border-left: 2px solid var(--rp-line); }
.rp-finding { border: 2px solid var(--rp-bad); border-radius: 6px; padding: 1rem; margin-bottom: 1rem;
  background: var(--rp-panel); }
.rp-finding-lead { margin: 0 0 .6rem; }
.rp-finding-lead p { margin: 0; }
.rp-finding-more > summary { cursor: pointer; color: var(--rp-dim); font-size: .78rem; }
.rp-pair { display: grid; gap: .5rem; }
.rp-order li { margin-bottom: .35rem; }
.rp-order-cue { color: var(--rp-dim); }
.rp-colophon { margin-top: 2.5rem; color: var(--rp-dim); font-size: .85rem; }
.rp-colophon summary { cursor: pointer; }
.rp-refuse { border: 2px solid var(--rp-bad); background: var(--rp-bad-bg); border-radius: 6px; padding: 1rem; }
table { border-collapse: collapse; }
th, td { border: 1px solid var(--rp-line); padding: .25rem .5rem; text-align: left; }`;

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

function inline(text: string): string {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
}
