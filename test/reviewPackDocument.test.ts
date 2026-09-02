import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { REVIEW_PACK_SCHEMA } from '../src/store/reviewPacks.js';
import type {
  ReviewAnchor,
  ReviewAnchorMark,
  ReviewClaim,
  ReviewIdea,
  ReviewNote,
  ReviewPack,
  ReviewProvenance,
  ReviewRange,
  ReviewVerdict,
} from '../src/types.js';
import type { ReviewPackPayload } from '../src/wire.js';

/**
 * Review packs, stage 2: the pack document — one JSON document per (pull request,
 * head sha), stored as written and read as written, with a reviewer's marks held
 * beside it and keyed to the code rather than to the ideas.
 * → docs/spec/31-review-packs.md#where-it-lives
 */

/** A clock that ticks one second per read, so "newest written" is never a tie the test relies on rowid for. */
function tickingClock(): () => string {
  let t = Date.parse('2026-09-02T10:00:00.000Z');
  return () => new Date((t += 1000)).toISOString();
}

const STORE_HUNK: ReviewRange = { path: 'src/store/reviewPacks.ts', start: 1, end: 40 };
const SCHEMA_HUNK: ReviewRange = { path: 'src/store/schema.ts', start: 570, end: 600 };
const SPEC_HUNK: ReviewRange = { path: 'docs/spec/31-review-packs.md', start: 533, end: 560 };

/**
 * Every field the spec names, with every union member exercised at least once, so
 * a round-trip that drops or reshapes one is caught as a deep-equal miss rather
 * than a field a renderer would silently draw as a gap.
 */
function fullPack(headSha: string): ReviewPack {
  const witnessNote: ReviewNote = {
    by: 'witness',
    text: 'One document, not three tables: nothing queries inside it.',
    entryId: 'scr_abc123def4',
    at: '2026-09-01T14:02:00.000Z',
  };
  const authorNote: ReviewNote = { by: 'author', text: 'The head sha is duplicated as a column on purpose.' };
  const witnessed: ReviewProvenance = { kind: 'witnessed', entryId: 'scr_abc123def4' };
  const inferred: ReviewProvenance = { kind: 'inferred' };
  const disputed: ReviewProvenance = { kind: 'disputed', entryId: 'scr_zzz999yyy8' };
  const shown: ReviewVerdict = 'true';
  const key: ReviewAnchorMark = 'key';
  const claims: ReviewClaim[] = [
    {
      text: 'The pack is stored as one JSON column.',
      provenance: witnessed,
      verdict: shown,
      evidence: 'Read schema.ts.',
    },
    { text: 'Nothing outside src/store/ reads the row.', provenance: inferred, verdict: 'cant_tell', evidence: null },
    {
      text: 'Marks are keyed to the idea id.',
      provenance: disputed,
      verdict: 'false',
      evidence: 'review_marks has no idea column.',
    },
    { text: 'Not yet checked.', provenance: inferred, verdict: null, evidence: null },
  ];
  const anchors: ReviewAnchor[] = [
    {
      kind: 'hunk',
      range: STORE_HUNK,
      code: ['+export class ReviewPackStore {', '+  constructor(private readonly ctx: StoreContext) {}', '+}'],
      gist: 'The module that owns both tables.',
      note: witnessNote,
      caption: 'new module',
      mark: key,
    },
    {
      kind: 'hunk',
      range: SCHEMA_HUNK,
      code: ['+CREATE TABLE IF NOT EXISTS review_packs (', '+  pr_number  INTEGER NOT NULL,', '-old line'],
      gist: 'One row per pull request and head.',
      note: authorNote,
      caption: null,
      mark: 'disputed',
    },
    {
      kind: 'region',
      range: { path: 'src/store/scratch.ts', start: 14, end: 17 },
      code: ['export const SCRATCH_COLUMNS: ColumnMigrations = {', "  scratch_entries: { decision: 'TEXT' },", '};'],
      gist: 'Unchanged, shown because the pattern the new module copies lives here.',
      note: null,
      caption: 'existing code, unchanged',
      mark: null,
    },
    {
      kind: 'region',
      range: { path: 'src/store/store.ts', start: 260, end: 262 },
      code: ['      SCRATCH_COLUMNS,', '      REVIEW_PACK_COLUMNS,', '    ]) {'],
      gist: 'Should this have changed? Yes, and it did.',
      note: null,
      caption: null,
      mark: 'false',
    },
  ];
  const ideas: ReviewIdea[] = [
    {
      id: 'idea_7f3k2',
      claim: 'The pack is one document in one table, keyed on pull request and head.',
      title: 'The pack lives in one row and nothing looks inside it',
      cue: 'Read: the shape every later stage renders.',
      anchors,
      claims,
      attention: 'read',
    },
    {
      id: 'idea_q9m1z',
      claim: 'The spec section is rewritten to describe the tables as built.',
      title: 'The spec says what was built',
      cue: null,
      anchors: [
        {
          kind: 'hunk',
          range: SPEC_HUNK,
          code: ['-| _review_packs_ |', '+| `review_packs` |'],
          gist: 'The marker comes off.',
          note: null,
          caption: null,
          mark: null,
        },
      ],
      claims: [],
      attention: null,
    },
    {
      id: 'plumbing',
      claim: 'These hunks are semantically empty.',
      title: 'Formatting only',
      cue: 'Skim: a lockfile.',
      anchors: [],
      claims: [],
      attention: 'skim',
    },
  ];
  return {
    schema: REVIEW_PACK_SCHEMA,
    prNumber: 695,
    headSha,
    headline: 'The review pack gets a shape and a place to live.',
    summary: 'Two tables and the types they hold. **Nothing renders it yet.**',
    estimatedMinutes: 12,
    order: ['idea_7f3k2', 'idea_q9m1z', 'plumbing'],
    ideas,
    witnessed: true,
    fake: 'nothing',
  };
}

test('a full pack round-trips through review_packs unchanged', () => {
  const store = new Store(':memory:', tickingClock());
  const pack = fullPack('a1b2c3d');

  const written = store.recordReviewPack(pack);
  const current = store.getCurrentReviewPack(695);

  assert.ok(current);
  assert.deepEqual(current.pack, pack);
  assert.equal(current.writtenAt, written.writtenAt);
  assert.equal(store.getCurrentReviewPack(1), null);
  store.close();
});

test('a pack for a newer head becomes current and the older row is kept', () => {
  const store = new Store(':memory:', tickingClock());
  const first = fullPack('a1b2c3d');
  const second = { ...fullPack('e5f6a7b'), headline: 'Second head.' };

  store.recordReviewPack(first);
  store.recordReviewPack(second);

  assert.deepEqual(store.getCurrentReviewPack(695)?.pack, second);
  assert.deepEqual(
    store.listReviewPacks(695).map((r) => r.pack.headSha),
    ['e5f6a7b', 'a1b2c3d'],
    'newest first, and the older head is still there',
  );
});

test('asking again on the same head replaces the pack rather than duplicating it', () => {
  const store = new Store(':memory:', tickingClock());
  store.recordReviewPack(fullPack('a1b2c3d'));
  const rewritten = { ...fullPack('a1b2c3d'), headline: 'Rewritten from a fuller log.' };

  store.recordReviewPack(rewritten);

  assert.equal(store.listReviewPacks(695).length, 1);
  assert.equal(store.getCurrentReviewPack(695)?.pack.headline, 'Rewritten from a fuller log.');
});

test('a mark keyed to a hunk survives the pack being rewritten', () => {
  const store = new Store(':memory:', tickingClock());
  store.recordReviewPack(fullPack('a1b2c3d'));
  const idea = fullPack('a1b2c3d').ideas[0]!;
  const hunks = idea.anchors.filter((a) => a.kind === 'hunk').map((a) => a.range);

  store.markReviewIdeaRead({ prNumber: 695, headSha: 'a1b2c3d', hunks, read: true });
  store.overrideReviewAttention({ prNumber: 695, headSha: 'a1b2c3d', hunks: [STORE_HUNK], attention: 'decide' });

  // Rewritten on the same head, then again on a newer one: neither touches the marks.
  store.recordReviewPack({ ...fullPack('a1b2c3d'), headline: 'Rewritten.' });
  store.recordReviewPack(fullPack('e5f6a7b'));

  const marks = store.listReviewMarks(695);
  assert.deepEqual(
    marks.map((m) => [m.hunk, m.read, m.attention]),
    [
      [STORE_HUNK, true, 'decide'],
      [SCHEMA_HUNK, true, null],
    ],
    'one row per hunk, ordered by path',
  );
  // The mark says which head the reviewer was looking at, and never names an idea.
  assert.ok(marks.every((m) => m.headSha === 'a1b2c3d'));
  assert.ok(marks.every((m) => !('ideaId' in m)));
});

test('reading an idea and overriding its label are two columns on one row', () => {
  // Each write names only the column it is about, so the other keeps what it had —
  // a reviewer who marks an idea read does not lose the override they set on it.
  const store = new Store(':memory:', tickingClock());
  const hunks = [STORE_HUNK];

  store.overrideReviewAttention({ prNumber: 695, headSha: 'a1b2c3d', hunks, attention: 'skim' });
  store.markReviewIdeaRead({ prNumber: 695, headSha: 'a1b2c3d', hunks, read: true });
  assert.deepEqual(
    store.listReviewMarks(695).map((m) => [m.read, m.attention]),
    [[true, 'skim']],
  );

  store.markReviewIdeaRead({ prNumber: 695, headSha: 'a1b2c3d', hunks, read: false });
  store.overrideReviewAttention({ prNumber: 695, headSha: 'a1b2c3d', hunks, attention: null });
  assert.deepEqual(
    store.listReviewMarks(695).map((m) => [m.read, m.attention]),
    [[false, null]],
  );
});

test('a pack stating a schema this build does not write is refused, not stored', () => {
  const store = new Store(':memory:', tickingClock());
  assert.throws(
    () => store.recordReviewPack({ ...fullPack('a1b2c3d'), schema: REVIEW_PACK_SCHEMA + 1 }),
    /schema 2 is not the 1 this build writes/,
  );
  assert.equal(store.getCurrentReviewPack(695), null);
});

test('the wire payload is the record plus the marks, never a second declaration', () => {
  // `ReviewPackPayload extends ReviewPackRecord`: a record and the marks compose
  // into it with no translation, which is what "the wire type is the domain type
  // or extends it" buys — the cockpit reads the document the store wrote.
  const store = new Store(':memory:', tickingClock());
  const record = store.recordReviewPack(fullPack('a1b2c3d'));
  store.markReviewIdeaRead({ prNumber: 695, headSha: 'a1b2c3d', hunks: [SPEC_HUNK], read: true });

  const payload: ReviewPackPayload = { ...record, marks: store.listReviewMarks(695) };

  assert.equal(payload.pack.schema, REVIEW_PACK_SCHEMA);
  assert.equal(payload.marks.length, 1);
});
