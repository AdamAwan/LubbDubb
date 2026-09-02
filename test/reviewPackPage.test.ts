import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { REVIEW_PACK_SCHEMA } from '../src/store/reviewPacks.js';
import type { ReviewIdea, ReviewPack, ReviewPackPayload } from '../src/wire.js';
import {
  falseClaims,
  ideaOpen,
  KNOWN_REVIEW_PACK_SCHEMA,
  layMarks,
  numberIdeas,
  packCurrency,
  packFacts,
  packStanding,
} from '../web/src/view/reviewPack.js';

// `tsx` compiles JSX with the classic runtime, which emits bare
// `React.createElement`; the global goes in before the components load.
(globalThis as { React?: typeof React }).React = React;

const { ReviewPackPage } = await import('../web/src/components/ReviewPackPage.js');
const { ReviewPackControl } = await import('../web/src/components/ReviewPackControl.js');
const { RefLinks } = await import('../web/src/components/refs.js');

/**
 * Review packs, stage 5: the cockpit rendering. The page is a pure function of
 * the payload, so the order of things on it — the four surface requirements
 * under *What a false claim does* — is asserted on static markup.
 * → docs/spec/31-review-packs.md#the-page
 */

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

function idea(over: Partial<ReviewIdea> & { id: string }): ReviewIdea {
  return {
    claim: 'claim',
    title: `Title of ${over.id}`,
    cue: null,
    anchors: [],
    claims: [],
    attention: null,
    ...over,
  };
}

/** A checked pack: two ideas, the second carrying a false claim and a finding on its first step. */
function checkedPack(): ReviewPack {
  return {
    schema: REVIEW_PACK_SCHEMA,
    prNumber: 7,
    headSha: HEAD,
    headline: 'The module imports y.',
    summary: 'Two files change; **the import is the point**.',
    estimatedMinutes: 4,
    order: ['idea_b', 'idea_a'],
    witnessed: true,
    fake: 'nothing',
    ideas: [
      idea({
        id: 'idea_a',
        title: 'One new import',
        cue: 'Small, but it is the whole change.',
        attention: 'read',
        anchors: [
          {
            kind: 'hunk',
            range: { path: 'src/a.ts', start: 1, end: 4 },
            code: [' import x from "x";', '+import y from "y";', ' ', ' export const a = 1;'],
            gist: 'The import lands here.',
            note: { by: 'witness', text: 'Chose y over z.', entryId: 'scr_1', at: '2026-09-01T13:04:00Z' },
            caption: 'new import',
            mark: 'key',
          },
          {
            kind: 'region',
            range: { path: 'src/unchanged.ts', start: 1, end: 2 },
            code: ['line one', 'line two'],
            gist: 'Should this have changed? No.',
            note: { by: 'author', text: 'Checked every importer.' },
            caption: null,
            mark: null,
          },
        ],
        claims: [
          {
            text: 'Nothing else imports y.',
            provenance: { kind: 'witnessed', entryId: 'scr_1' },
            verdict: 'true',
            evidence: 'grep found one importer.',
            finding: null,
          },
          {
            text: 'y is what the team would choose.',
            provenance: { kind: 'inferred' },
            verdict: 'cant_tell',
            evidence: 'A judgement, not the tree.',
            finding: null,
          },
        ],
      }),
      idea({
        id: 'idea_b',
        title: 'Dead code goes',
        cue: 'A deletion something still read.',
        attention: 'decide',
        anchors: [
          {
            kind: 'hunk',
            range: { path: 'src/b.ts', start: 9, end: 9 },
            code: ['-const old = 2;'],
            gist: 'An unused constant, said the author.',
            note: null,
            caption: null,
            mark: 'false',
          },
        ],
        claims: [
          {
            text: 'Nothing read old.',
            provenance: { kind: 'inferred' },
            verdict: 'false',
            evidence: 'src/unchanged.ts:2 still reads old.',
            finding: {
              headline: 'The deleted constant is still read.',
              body: 'The build breaks. **Blocking; the author’s call.**',
              step: 1,
              counter: {
                range: { path: 'src/unchanged.ts', start: 2, end: 2 },
                code: ['const two = old;'],
                caption: 'the surviving reader',
              },
            },
          },
        ],
      }),
    ],
  };
}

function payload(over: Partial<ReviewPackPayload> = {}): ReviewPackPayload {
  return {
    pack: checkedPack(),
    writtenAt: '2026-09-01T13:10:00Z',
    marks: [],
    head: HEAD,
    stale: null,
    checking: false,
    sharing: { available: true, share: null },
    ...over,
  };
}

const noop = async (): Promise<void> => {};

function render(p: ReviewPackPayload, openIdea: string | null = null): string {
  return renderToStaticMarkup(
    createElement(RefLinks, {
      refUrls: { 'pr:7': 'https://example.test/pull/7' },
      openGoal: () => undefined,
      hasGoal: () => false,
      children: createElement(ReviewPackPage, {
        payload: p,
        marks: p.marks,
        entries: null,
        openIdea,
        onOpenIdea: () => undefined,
        onRead: noop,
        onAttention: noop,
        onAsk: noop,
        onShare: noop,
        shareRefusal: null,
        onShareRefused: () => undefined,
        refUrls: {},
      }),
    }),
  );
}

// -- the derivations, purely ------------------------------------------------------------

test('the renderer knows the schema the harness writes', () => {
  assert.equal(KNOWN_REVIEW_PACK_SCHEMA, REVIEW_PACK_SCHEMA);
});

test('ideas are numbered by the reading order when the checker has run, and by document order when it has not', () => {
  const checked = numberIdeas(checkedPack());
  assert.equal(checked.by, 'order');
  assert.deepEqual(
    checked.ideas.map((n) => [n.number, n.idea.id]),
    [
      [1, 'idea_b'],
      [2, 'idea_a'],
    ],
  );
  const unchecked = numberIdeas({ ...checkedPack(), order: [] });
  assert.equal(unchecked.by, 'document');
  assert.deepEqual(
    unchecked.ideas.map((n) => [n.number, n.idea.id]),
    [
      [1, 'idea_a'],
      [2, 'idea_b'],
    ],
  );
});

test('the gate counts claims whose verdict is false, and the facts line reads every figure off the document', () => {
  const wrong = falseClaims(checkedPack());
  assert.equal(wrong.length, 1);
  assert.equal(wrong[0]!.idea.id, 'idea_b');
  assert.equal(wrong[0]!.number, 1, 'numbered as the page numbers it');
  assert.deepEqual(packFacts(checkedPack()), {
    ideas: 2,
    files: 2,
    changes: 2,
    claims: { total: 3, true: 1, false: 1, cantTell: 1, unchecked: 0 },
  });
});

test('standing and currency are three-valued each, and a gone pull request is never current', () => {
  assert.equal(packStanding(payload()), 'checked');
  assert.equal(packStanding(payload({ pack: { ...checkedPack(), order: [] }, checking: true })), 'checking');
  assert.equal(packStanding(payload({ pack: { ...checkedPack(), order: [] }, checking: false })), 'unchecked');
  assert.deepEqual(packCurrency(payload()), { kind: 'current' });
  assert.deepEqual(packCurrency(payload({ stale: { headSha: 'b'.repeat(40), commitsBehind: 3 } })), {
    kind: 'stale',
    headSha: 'b'.repeat(40),
    commitsBehind: 3,
  });
  assert.deepEqual(packCurrency(payload({ head: null, stale: null })), { kind: 'gone' });
});

test('marks lay over an idea only when every hunk it owns agrees', () => {
  const pack = checkedPack();
  const mark = (path: string, start: number, end: number, read: boolean, attention: 'skim' | null = null) => ({
    prNumber: 7,
    hunk: { path, start, end },
    headSha: HEAD,
    read,
    attention,
    markedAt: '2026-09-01T13:20:00Z',
  });
  assert.deepEqual(layMarks(pack, [mark('src/a.ts', 1, 4, true, 'skim')]).get('idea_a'), {
    read: true,
    attention: 'skim',
  });
  assert.deepEqual(layMarks(pack, []).get('idea_a'), { read: false, attention: null });
  // A mark on a hunk the pack no longer carries lands nowhere.
  assert.deepEqual(layMarks(pack, [mark('src/a.ts', 40, 44, true)]).get('idea_a'), { read: false, attention: null });
  // Two hunks, one marked: not read, and no override.
  const twoHunks: ReviewPack = {
    ...pack,
    ideas: [
      idea({
        id: 'idea_c',
        anchors: [
          { ...pack.ideas[0]!.anchors[0]!, range: { path: 'src/a.ts', start: 1, end: 4 } },
          { ...pack.ideas[0]!.anchors[0]!, range: { path: 'src/a.ts', start: 20, end: 22 } },
        ],
      }),
    ],
  };
  assert.deepEqual(layMarks(twoHunks, [mark('src/a.ts', 1, 4, true, 'skim')]).get('idea_c'), {
    read: false,
    attention: null,
  });
  assert.deepEqual(
    layMarks(twoHunks, [mark('src/a.ts', 1, 4, true, 'skim'), mark('src/a.ts', 20, 22, true, 'skim')]).get('idea_c'),
    { read: true, attention: 'skim' },
  );
});

test('an idea is open by its id or by the open-all value', () => {
  assert.equal(ideaOpen('idea_a', 'idea_a'), true);
  assert.equal(ideaOpen('all', 'idea_a'), true);
  assert.equal(ideaOpen(null, 'idea_a'), false);
  assert.equal(ideaOpen('idea_b', 'idea_a'), false);
});

// -- the page, rendered ---------------------------------------------------------------------

test('the page draws the masthead, then the gate, then the ideas — and the pull request is a reference', () => {
  const html = render(payload());
  const mast = html.indexOf('class="rp-mast"');
  const gate = html.indexOf('class="rp-gate"');
  const ideas = html.indexOf('class="rp-ideas"');
  assert.ok(mast >= 0 && gate > mast && ideas > gate, 'masthead, gate, ideas — in that order');
  assert.match(html, /1 false claim/);
  assert.match(html, /The deleted constant is still read\. — idea 01\./);
  assert.match(html, /href="#rp-finding-1"/);
  // The reference, drawn through <Ref>, boxed and leaving for the provider.
  assert.match(html, /<a[^>]*href="https:\/\/example\.test\/pull\/7"[^>]*>#7<\/a>/);
  assert.match(html, /The module imports y\./);
  assert.match(html, /<strong>the import is the point<\/strong>/);
  assert.match(html, /~4 min/);
});

test('no gate when nothing is false, and the collapsed row still carries the flag when something is', () => {
  const clean: ReviewPack = checkedPack();
  clean.ideas[1]!.claims[0]!.verdict = 'true';
  clean.ideas[1]!.claims[0]!.finding = null;
  clean.ideas[1]!.anchors[0]!.mark = null;
  assert.doesNotMatch(render(payload({ pack: clean })), /class="rp-gate"/);

  // Nothing open: the flag is on the row, and the finding box is still after the ideas.
  const html = render(payload(), null);
  assert.match(html, /<span class="rp-flag">1 false claim<\/span>/);
  assert.doesNotMatch(html, /class="rp-walk"/, 'nothing is unfolded');
  const ideas = html.indexOf('class="rp-ideas"');
  const finding = html.indexOf('id="rp-finding-1"');
  assert.ok(finding > ideas, 'the finding box comes after the ideas');
  assert.match(html, /The deleted constant is still read\./);
  assert.match(html, /the surviving reader/);
  assert.match(html, /const two = old;/);
  assert.match(html, /step 1 — src\/b\.ts:9/);
  assert.match(html, /<strong>Blocking; the author’s call\.<\/strong>/);
});

test('opening an idea shows the walk, the marks, the claims and the false claim at the top', () => {
  const html = render(payload(), 'idea_b');
  const raised = html.indexOf('class="rp-raised"');
  const walk = html.indexOf('class="rp-walk"');
  assert.ok(raised >= 0 && walk > raised, 'the false claim is shown at the top of the idea, before its walk');
  assert.match(html, /claim is false/);
  assert.match(html, /class="rp-v rp-v-false"/);
  assert.match(html, /src\/unchanged\.ts:2 still reads old\./);
  assert.match(html, /class="rp-l rp-del">-const old = 2;/);
  assert.match(html, /Mark read/);

  const other = render(payload(), 'idea_a');
  assert.match(other, /rp-step rp-dashed/, 'a region is drawn dashed');
  assert.match(other, /not in this PR/);
  assert.match(other, /the important bit/);
  assert.match(other, /class="rp-l rp-add">\+import y from &quot;y&quot;;/);
  assert.match(other, /new import/);
  assert.match(other, /witness · /);
  assert.match(other, /added afterwards/);
  assert.match(other, /Can’t tell/);
  assert.match(other, /<strong> You decide\.<\/strong>/);
  assert.match(other, /cites pad entry <code>scr_1<\/code> — the pads have not loaded/);
  assert.match(other, /class="rp-att rp-att-read/);
});

test('an unchecked pack says so and offers the ask; a pack being checked says that instead', () => {
  const unchecked = render(payload({ pack: { ...checkedPack(), order: [] }, checking: false }));
  assert.match(unchecked, /rp-band-unchecked/);
  assert.match(unchecked, /The checker never finished this pack/);
  assert.match(unchecked, /Ask again/);
  assert.match(unchecked, /in document order — the checker has not ordered them/);
  const checking = render(payload({ pack: { ...checkedPack(), order: [] }, checking: true }));
  assert.match(checking, /rp-band-checking/);
  assert.doesNotMatch(checking, /The checker never finished/);
});

test('a stale pack says how far behind, an unfetched head says unknown, and a gone pull request is not current', () => {
  assert.match(render(payload({ stale: { headSha: 'b'.repeat(40), commitsBehind: 3 } })), /stale · 3 commits behind/);
  assert.match(render(payload({ stale: { headSha: 'b'.repeat(40), commitsBehind: null } })), /unknown commits behind/);
  const gone = render(payload({ head: null, stale: null }));
  assert.match(gone, /pull request gone/);
  assert.doesNotMatch(gone, /class="chip small ok">current/);
});

test('a pack of a schema this build does not know is refused whole', () => {
  const html = render(payload({ pack: { ...checkedPack(), schema: REVIEW_PACK_SCHEMA + 1 } }));
  assert.match(html, /This pack cannot be shown\./);
  assert.doesNotMatch(html, /class="rp-mast"/);
  assert.doesNotMatch(html, /class="rp-gate"/);
  assert.doesNotMatch(html, /Dead code goes/);
});

test('no reference is drawn inside a button, on the page or on the row control', () => {
  const html = render(payload(), 'all');
  for (const [, inner] of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) {
    assert.doesNotMatch(inner ?? '', /<a\b|class="ref-/, `a reference inside a button: ${inner}`);
  }
  // The control's resting state is what a static render reaches: the row before its read lands.
  const control = renderToStaticMarkup(
    createElement(ReviewPackControl, { prNumber: 7, headSha: HEAD, canAsk: true, onOpen: () => undefined }),
  );
  assert.match(control, /rp-ctl-quiet/);
});
