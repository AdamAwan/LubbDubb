import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReviewPackCompanion, reviewPackCompanionPath } from '../src/reviewPacks/companion.js';
import {
  anchorWeight,
  codeBlockLines,
  falseClaims,
  numberIdeas,
  packFacts,
  plainSummary,
  splitBody,
  testScenarios,
} from '../src/reviewPacks/derive.js';
import { REVIEW_PACK_SCHEMA } from '../src/store/reviewPacks.js';
import type { ReviewAnchor, ReviewIdea, ReviewPack, ReviewPackRecord } from '../src/types.js';
import {
  anchorWeight as webAnchorWeight,
  codeBlockLines as webCodeBlockLines,
  falseClaims as webFalseClaims,
  numberIdeas as webNumberIdeas,
  packFacts as webPackFacts,
  plainSummary as webPlainSummary,
  splitBody as webSplitBody,
  testScenarios as webTestScenarios,
  KNOWN_REVIEW_PACK_SCHEMA,
} from '../web/src/view/reviewPack.js';

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

const render = (p: ReviewPack): string => renderReviewPackCompanion(record(p));

function contains(html: string, needle: string): void {
  assert.equal(html.includes(needle), true, `expected the companion to contain ${JSON.stringify(needle)}`);
}

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
  assert.equal(/<script/i.test(html), false, 'the companion runs no script');
  assert.equal(/<form|<input|Mark read|Ask again|Share this pack/.test(html), false, 'and takes no input');

  const order = positions(html, [
    'The module imports y.',
    'rp-gate',
    'The 2 ideas',
    'The import lands here.',
    'What the author claims',
    'id="rp-finding-1"',
    'Where to spend the 4 minutes',
    'what in it is fake',
  ]);
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    'the page is drawn in the spec’s order',
  );

  assert.match(html, /numbered in the order the checker says to read them/);
  assert.match(html, />01<\/span><span class="rp-att rp-att-decide">Decide/);
  assert.match(html, /1 false claim/);
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
  assert.ok(covered.indexOf('Covered by') < covered.indexOf('What the author claims'));

  const bare = renderReviewPackCompanion(record(pack({ ideas: [idea({ coverage: undefined })] })));
  assert.doesNotMatch(bare, /Covered by/);
});

test('the diff marker is a column of its own, and is dropped where every line carries the same one', () => {
  const mixed = codeBlockLines([' const a = 1;', '-const b = 2;', '+const b = 3;'], true);
  assert.equal(mixed.gutter, true);
  assert.deepEqual(mixed.lines, [
    { marker: ' ', text: 'const a = 1;' },
    { marker: '-', text: 'const b = 2;' },
    { marker: '+', text: 'const b = 3;' },
  ]);

  const added_ = codeBlockLines(['+const a = 1;', '+const b = 2;'], true);
  assert.equal(added_.gutter, false);
  assert.deepEqual(
    added_.lines.map((l) => l.text),
    ['const a = 1;', 'const b = 2;'],
  );

  assert.deepEqual(codeBlockLines(['const a = 1;'], false), {
    gutter: false,
    lines: [{ marker: null, text: 'const a = 1;' }],
  });

  const html = renderReviewPackCompanion(
    record(
      pack({
        ideas: [
          idea({
            anchors: [
              {
                kind: 'hunk',
                range: { path: 'src/a.ts', start: 1, end: 3 },
                code: [' const a = 1;', '-const b = 2;', '+const b = 3;'],
                gist: 'Here.',
                note: null,
                caption: null,
                mark: null,
              },
            ],
          }),
        ],
      }),
    ),
  );
  assert.match(html, /<span class="rp-m" aria-hidden="true">\+<\/span><span class="rp-t">/);
  assert.doesNotMatch(html, /<span class="rp-t">\+/, 'the marker is never the first character of the code');
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
  assert.match(html, /This file is not in the pull request/);
  assert.match(html, /scr_abc123/);
  assert.match(html, /stayed on the fleet that wrote it/);
});

const WEIGHTS: [string, ReviewAnchor, 'key' | 'normal' | 'minor'][] = [
  [
    'an import block is mechanical',
    hunk({ code: ['+import { a } from "./a.js";', '+import { b } from "./b.js";', ' const x = 1;'] }),
    'minor',
  ],
  ['a one-line type import is mechanical', hunk({ code: ['+  PullRequest,'] }), 'minor'],
  ['two short changed lines are mechanical', hunk({ code: ['-  const n = 1;', '+  const n = 2;'] }), 'minor'],
  ['one enormous line is not', hunk({ code: [`+  doc: '${'a prompt that runs on and on. '.repeat(12)}',`] }), 'normal'],
  ['a real change is not', hunk({ code: ['+  if (a) return b;', '+  if (c) return d;', '+  return e;'] }), 'normal'],
  ['the author’s own mark wins over every rule', hunk({ code: ['+import { a } from "./a.js";'], mark: 'key' }), 'key'],
  [
    'a region is never mechanical — somebody put it there on purpose',
    { ...hunk({ code: ['const x = 1;'] }), kind: 'region' },
    'normal',
  ],
  [
    'a hunk that reworded a doc comment is mechanical, however long it is',
    hunk({
      range: { path: 'src/Consumer.cs', start: 4, end: 12 },
      code: [
        '-    /// Resolves the workflow of a target that was just unmatched by the system,',
        '-    /// which is the only case the projector raised it for.',
        '+    /// Resolves the workflow of a target whose binding changed, which now covers',
        '+    /// a first bind as well as an unmatch or a rematch.',
      ],
    }),
    'minor',
  ],
  [
    'a Markdown heading is the text, not a comment about it',
    hunk({
      range: { path: 'docs/projector.md', start: 40, end: 44 },
      code: [
        '-# The trigger is an unmatch',
        '+# The trigger is any binding change',
        '+Every Matched, Rematched or Unmatched raises it, ordered against the newest binding.',
      ],
    }),
    'normal',
  ],
];

function hunk(over: Partial<ReviewAnchor> = {}): ReviewAnchor {
  return {
    kind: 'hunk',
    range: { path: 'src/a.ts', start: 1, end: 4 },
    code: ['+const x = 1;'],
    gist: 'A stop.',
    note: null,
    caption: null,
    mark: null,
    ...over,
  } as ReviewAnchor;
}

test('how hard to look at one stop is derived from the code, and the author’s mark wins', () => {
  for (const [what, anchor, want] of WEIGHTS) assert.equal(anchorWeight(anchor), want, what);
});

test('a mechanical stop is drawn quiet, with its code folded rather than dropped', () => {
  const html = render(
    pack({
      ideas: [
        idea({
          anchors: [
            hunk({ code: ['+import { b } from "./b.js";'], gist: 'The import lands here.' }),
            hunk({ code: ['+  if (a) return b;', '+  if (c) return d;', '+  return e;'], gist: 'The logic.' }),
          ],
        }),
      ],
    }),
  );
  contains(html, 'rp-w-minor');
  contains(html, 'mechanical');
  contains(html, 'show the 1 line');
  contains(html, 'b.js');
  contains(html, 'rp-w-normal');
});

test('the contents rail names every idea and every stop, and marks where the time goes', () => {
  const html = render(pack({ ideas: [idea({ title: 'The first idea' })] }));
  contains(html, 'class="rp-rail"');
  contains(html, 'href="#rp-i1"');
  contains(html, 'href="#rp-s1-1"');
  contains(html, 'id="rp-i1"');
  contains(html, 'id="rp-s1-1"');
  contains(html, 'rp-c-key');
});

test('the companion and the cockpit agree on the derivations neither can share', () => {
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
    for (const [code, diff] of [
      [[' a', '-b', '+c'], true],
      [['+a', '+b'], true],
      [['a', 'b'], false],
      [[], true],
    ] as [string[], boolean][]) {
      assert.deepEqual(codeBlockLines(code, diff), webCodeBlockLines(code, diff));
    }
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
    for (const [what, anchor] of WEIGHTS) assert.equal(anchorWeight(anchor), webAnchorWeight(anchor), what);
    assert.equal(plainSummary(p.summary), webPlainSummary(p.summary));
    assert.deepEqual(splitBody('One.\n\nTwo.'), webSplitBody('One.\n\nTwo.'));
    const testCode = ['+        public async Task A_B()', '+        public async Task C_D()'];
    assert.deepEqual(testScenarios('Tests/XTests.cs', testCode), webTestScenarios('Tests/XTests.cs', testCode));
  }
});

test('the author’s emphasis is flattened, so a bullet reads as a sentence', () => {
  assert.equal(
    plainSummary('- **A first `Matched`** now raises it, in **both** places.'),
    '- A first `Matched` now raises it, in both places.',
  );
  assert.equal(plainSummary('__Only__ that consumer moved.'), 'Only that consumer moved.');
  assert.equal(plainSummary('nothing to flatten'), 'nothing to flatten');
  assert.equal(plainSummary('a * b * c'), 'a * b * c', 'a stray asterisk is not emphasis');
});

test('a finding leads with its first paragraph, and the argument is what follows', () => {
  const split = splitBody('The claim is wrong.\n\n| a | b |\n|---|---|\n\nAnd the rest.');
  assert.equal(split.lead, 'The claim is wrong.');
  assert.match(split.rest, /^\| a \| b \|/);
  assert.deepEqual(splitBody('One paragraph only.'), { lead: 'One paragraph only.', rest: '' });
});

test('a test file is drawn as the cases it covers, not as a wall of code', () => {
  const cs = testScenarios('Tests/LocalDb.Tests/ReconciliationFirstBindTests.cs', [
    '+        [Fact]',
    '+        public async Task FirstBind_RaisesWorkflowResolve()',
    '+        {',
    '+        }',
    '+        public async Task Unmatch_KeepsTheOldGuard()',
  ]);
  assert.deepEqual(cs, ['First bind raises workflow resolve', 'Unmatch keeps the old guard']);

  const ts = testScenarios('test/reviewPackPage.test.ts', [
    "+test('a mechanical stop is folded', () => {",
    "+it('draws the rail', () => {",
  ]);
  assert.deepEqual(ts, ['a mechanical stop is folded', 'draws the rail']);

  assert.deepEqual(testScenarios('src/a.ts', ['+public async Task Whatever()']), [], 'only a test file');
  assert.deepEqual(
    testScenarios('test/a.test.ts', ["+it('only one case', () => {"]),
    [],
    'one name is a code block, not a list',
  );
});

test('the companion lives beside the document it renders', () => {
  assert.equal(reviewPackCompanionPath('alice@acme-api', 7), 'fleets/alice@acme-api/packs/pr-7.html');
});
