import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReviewPackCompanion, reviewPackCompanionPath } from '../src/reviewPacks/companion.js';
import { falseClaims, numberIdeas, packFacts } from '../src/reviewPacks/derive.js';
import { REVIEW_PACK_SCHEMA } from '../src/store/reviewPacks.js';
import type { ReviewIdea, ReviewPack, ReviewPackRecord } from '../src/types.js';
import {
  falseClaims as webFalseClaims,
  numberIdeas as webNumberIdeas,
  packFacts as webPackFacts,
  KNOWN_REVIEW_PACK_SCHEMA,
} from '../web/src/view/reviewPack.js';

/**
 * Review packs, stage 6: the HTML companion — one self-contained file rendered by
 * the harness from the document alone, drawing the page in the order
 * docs/spec/31-review-packs.md#the-page fixes, with no harness behind it and no
 * input.
 */

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

function idea(over: Partial<ReviewIdea> = {}): ReviewIdea {
  return {
    id: 'idea_one',
    claim: 'a.ts gains a dependency on y.',
    title: 'One new import',
    cue: 'The import is the whole change.',
    attention: 'read',
    anchors: [
      {
        kind: 'hunk',
        range: { path: 'src/a.ts', start: 1, end: 4 },
        code: [' import x from "x";', '+import y from "y";'],
        gist: 'The import lands here.',
        note: { by: 'author', text: 'Added afterwards, from the diff.' },
        caption: 'new import',
        mark: 'key',
      },
    ],
    claims: [
      {
        text: 'Only a.ts imports y.',
        provenance: { kind: 'inferred' },
        verdict: 'true',
        evidence: 'grep -r y',
        finding: null,
      },
    ],
    ...over,
  };
}

function pack(over: Partial<ReviewPack> = {}): ReviewPack {
  return {
    schema: REVIEW_PACK_SCHEMA,
    prNumber: 7,
    headSha: HEAD,
    headline: 'The module imports y.',
    summary: 'The change is one import. **Read the second idea first.**',
    estimatedMinutes: 4,
    order: [],
    witnessed: true,
    fake: 'nothing',
    ideas: [idea()],
    ...over,
  };
}

const record = (p: ReviewPack): ReviewPackRecord => ({ pack: p, writtenAt: '2026-09-01T13:10:00Z' });

/** Where each of these appears, so the order can be asserted as an order. */
function positions(html: string, needles: string[]): number[] {
  return needles.map((needle) => {
    const at = html.indexOf(needle);
    assert.notEqual(at, -1, `expected the companion to contain ${JSON.stringify(needle)}`);
    return at;
  });
}

test('the companion is one self-contained file that draws the page in the spec’s order', () => {
  const wrong = idea({
    id: 'idea_two',
    title: 'The constant is still read',
    claim: 'Nothing reads the deleted constant.',
    cue: 'A false claim sits here.',
    attention: 'decide',
    claims: [
      {
        text: 'Nothing reads the deleted constant.',
        provenance: { kind: 'inferred' },
        verdict: 'false',
        evidence: 'src/b.ts still reads it',
        finding: {
          headline: 'The deleted constant is still read.',
          body: 'The build breaks. **Blocking; the author’s call.**',
          step: 1,
          counter: {
            range: { path: 'src/b.ts', start: 2, end: 2 },
            code: ['const two = old;'],
            caption: 'the surviving reader',
          },
        },
      },
    ],
  });
  const html = renderReviewPackCompanion(record(pack({ ideas: [idea(), wrong], order: ['idea_two', 'idea_one'] })));

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Review pack · #7 · The module imports y\.<\/title>/);
  // No harness behind it: no script, and nothing to fetch.
  assert.equal(/<script/i.test(html), false, 'the companion runs no script');
  assert.equal(/<form|<input|Mark read|Ask again|Share this pack/.test(html), false, 'and takes no input');

  const order = positions(html, [
    'The module imports y.', // 1 the masthead
    'rp-gate', // 2 the gate, above the ideas
    'The 2 ideas', // 3 the ideas
    'The import lands here.', // 4 the walk
    'What the author claims', // 5 the claims
    'id="rp-finding-1"', // 6 the finding itself — the gate above only links to it
    'Where to spend the 4 minutes', // 7 where to spend the time
    'what in it is fake', // 8 the colophon
  ]);
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    'the page is drawn in the spec’s order',
  );

  // The numbers are the checker's reading order, and the false claim is drawn on
  // the row a reader who opens nothing still sees.
  assert.match(html, /numbered in the order the checker says to read them/);
  assert.match(html, />01<\/span><span class="rp-att rp-att-decide">Decide/);
  assert.match(html, /1 false claim/);
  // The two pieces of code that disagree, with their captions.
  assert.match(html, /the surviving reader/);
  assert.match(html, /<strong>Blocking; the author’s call\.<\/strong>/, 'the finding’s markdown is rendered');
});

test('an unwitnessed pack says so, and an unchecked one is drawn as itself', () => {
  const html = renderReviewPackCompanion(
    record(pack({ witnessed: false, fake: 'the diff is invented', ideas: [idea({ cue: null, attention: null })] })),
  );
  assert.match(html, /nobody witnessed this change/);
  assert.match(html, /Nobody witnessed this change/, 'and the colophon says it too');
  assert.match(html, /the diff is invented/);
  assert.match(html, /no cue — the checker has not written one/, 'a missing field is drawn as a gap');
  assert.match(html, /in document order — the checker has not ordered them/);
  assert.match(html, /no reading order to give yet/);
});

test('an idea lists the scenarios its tests cover, above its claims and never as prose', () => {
  const covered = renderReviewPackCompanion(
    record(pack({ ideas: [idea({ coverage: ['b is exported', 'a is left alone'] })] })),
  );
  assert.match(covered, /Covered by/);
  assert.match(covered, /<li>b is exported<\/li>/);
  // Above the claims, so the reader who has just read the code learns there
  // whether it is exercised. → docs/spec/31-review-packs.md#tests-are-never-an-idea
  assert.ok(covered.indexOf('Covered by') < covered.indexOf('What the author claims'));

  // Nothing at all where there is nothing to list: a heading over an empty list
  // reads as tests that were looked for and not found. A pack written before the
  // field existed reads it back undefined, and renders the same way.
  const bare = renderReviewPackCompanion(record(pack({ ideas: [idea({ coverage: undefined })] })));
  assert.doesNotMatch(bare, /Covered by/);
});

test('a pack stating a schema this build does not know is refused whole', () => {
  const html = renderReviewPackCompanion(record(pack({ schema: REVIEW_PACK_SCHEMA + 1 })));
  assert.match(html, /This pack cannot be shown/);
  assert.equal(html.includes('The module imports y.'), false, 'not even the parts it recognises');
});

test('every embedded line is escaped, and a cited pad entry is said to have stayed behind', () => {
  const html = renderReviewPackCompanion(
    record(
      pack({
        ideas: [
          idea({
            anchors: [
              {
                kind: 'region',
                range: { path: 'src/<x>.ts', start: 1, end: 1 },
                code: ['const html = "<script>alert(1)</script>";'],
                gist: 'Shown because <b>you need it</b>.',
                note: null,
                caption: null,
                mark: null,
              },
            ],
            claims: [
              {
                text: 'The witness said so.',
                provenance: { kind: 'witnessed', entryId: 'scr_abc123' },
                verdict: null,
                evidence: null,
                finding: null,
              },
            ],
          }),
        ],
      }),
    ),
  );
  assert.equal(html.includes('<script>alert(1)</script>'), false, 'embedded code cannot become markup');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Shown because &lt;b&gt;you need it&lt;\/b&gt;/);
  assert.match(html, /not in this PR/);
  assert.match(html, /scr_abc123/);
  assert.match(html, /stayed on the fleet that wrote it/);
});

test('the companion and the cockpit agree on the derivations neither can share', () => {
  // Two statements of one set of rules, for the reason `KNOWN_REVIEW_PACK_SCHEMA`
  // is: `web/src/` may name no server module but `src/wire.ts`, which carries no
  // runtime. So the agreement is asserted rather than compiled.
  assert.equal(KNOWN_REVIEW_PACK_SCHEMA, REVIEW_PACK_SCHEMA);
  const wrong = idea({
    id: 'idea_two',
    claims: [
      {
        text: 'Nothing reads it.',
        provenance: { kind: 'inferred' },
        verdict: 'false',
        evidence: 'it does',
        finding: null,
      },
      {
        text: 'A judgement.',
        provenance: { kind: 'inferred' },
        verdict: 'cant_tell',
        evidence: 'not decidable',
        finding: null,
      },
    ],
  });
  for (const p of [
    pack({ ideas: [idea(), wrong] }),
    pack({ ideas: [idea(), wrong], order: ['idea_two', 'idea_one'] }),
  ]) {
    const mine = numberIdeas(p);
    const theirs = webNumberIdeas(p);
    assert.equal(mine.by, theirs.by);
    assert.deepEqual(
      mine.ideas.map((e) => [e.idea.id, e.number]),
      theirs.ideas.map((e) => [e.idea.id, e.number]),
    );
    assert.deepEqual(
      falseClaims(p).map((f) => [f.idea.id, f.number, f.claimNumber]),
      webFalseClaims(p).map((f) => [f.idea.id, f.number, f.claimNumber]),
    );
    assert.deepEqual(packFacts(p), webPackFacts(p));
  }
});

test('the companion lives beside the document it renders', () => {
  assert.equal(reviewPackCompanionPath('alice@acme-api', 7), 'fleets/alice@acme-api/packs/pr-7.html');
});
