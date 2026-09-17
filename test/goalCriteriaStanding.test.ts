import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criteriaStanding } from '../src/criteria/standing.js';

// → docs/spec/08-planning.md

const REVEAL = '2026-01-02T00:00:00.000Z';
const DISPATCH = '2026-01-03T00:00:00.000Z';

test('a version authored before the reveal is the independent one', () => {
  assert.equal(
    criteriaStanding({
      authoredAt: '2026-01-01T00:00:00.000Z',
      revealedAt: REVEAL,
      firstPartDispatchAt: DISPATCH,
    }),
    'pre-reveal',
  );
});

test('a version authored after the reveal and before any part dispatch is post-reveal', () => {
  assert.equal(
    criteriaStanding({
      authoredAt: '2026-01-02T12:00:00.000Z',
      revealedAt: REVEAL,
      firstPartDispatchAt: DISPATCH,
    }),
    'post-reveal',
  );
});

test('a version authored after the first part dispatch is drift', () => {
  assert.equal(
    criteriaStanding({
      authoredAt: '2026-01-04T00:00:00.000Z',
      revealedAt: REVEAL,
      firstPartDispatchAt: DISPATCH,
    }),
    'post-work',
  );
});

test('each boundary belongs to the side that has happened', () => {
  assert.equal(
    criteriaStanding({ authoredAt: REVEAL, revealedAt: REVEAL, firstPartDispatchAt: null }),
    'post-reveal',
    'authored at the instant of the reveal is authored after it',
  );
  assert.equal(
    criteriaStanding({ authoredAt: DISPATCH, revealedAt: REVEAL, firstPartDispatchAt: DISPATCH }),
    'post-work',
    'authored at the instant of the dispatch is drift',
  );
});

test('a goal that was never revealed reads pre-reveal, and dispatch still outranks it', () => {
  assert.equal(
    criteriaStanding({ authoredAt: '2026-06-01T00:00:00.000Z', revealedAt: null, firstPartDispatchAt: null }),
    'pre-reveal',
    'no reveal row spells never offered — post-reveal would be a reading with no timestamp behind it',
  );
  assert.equal(
    criteriaStanding({ authoredAt: '2026-06-01T00:00:00.000Z', revealedAt: null, firstPartDispatchAt: DISPATCH }),
    'post-work',
    'a part task is a recorded fact whether or not the gate was ever offered',
  );
});

test('dispatch outranks the reveal even for a version authored between them out of order', () => {
  assert.equal(
    criteriaStanding({ authoredAt: '2026-01-05T00:00:00.000Z', revealedAt: null, firstPartDispatchAt: DISPATCH }),
    'post-work',
  );
});
