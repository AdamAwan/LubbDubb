import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchBucket } from '../web/src/worldBuckets.js';
import { resolveWatchState, watchLabelsFor } from '../src/watchLabels.js';

const LABELS = watchLabelsFor('lubbdubb');
const PR = { ...LABELS, defaultWatched: true };
const ISSUE = { ...LABELS, defaultWatched: false };

test('an explicit ignore tag wins over a watch tag', () => {
  const both = [LABELS.watchLabel, LABELS.ignoreLabel];
  assert.equal(watchBucket(both, PR), 'ignored');
  assert.equal(watchBucket(both, ISSUE), 'ignored');
});

test('a watch tag beats the type default', () => {
  assert.equal(watchBucket([LABELS.watchLabel], ISSUE), 'watched');
});

test('the untagged default is per kind — PRs opt-out, issues opt-in', () => {
  assert.equal(watchBucket([], PR), 'watched');
  assert.equal(watchBucket([], ISSUE), 'unwatched');
  assert.equal(watchBucket(undefined, PR), 'watched');
  assert.equal(watchBucket(undefined, ISSUE), 'unwatched');
});

test('unwatched is distinct from ignored — the split the panel exists to draw', () => {
  assert.equal(watchBucket([], ISSUE), 'unwatched');
  assert.equal(watchBucket([LABELS.ignoreLabel], ISSUE), 'ignored');
});

test('empty labels leave every item on its type default, so both extra tabs are empty', () => {
  const off = { ...watchLabelsFor(''), defaultWatched: false };
  // The tags an operator may still have on the item must not be read as gates.
  assert.equal(watchBucket(['lubbdubb-ignore', 'lubbdubb-watch'], off), 'unwatched');
  assert.equal(watchBucket([], { ...off, defaultWatched: true }), 'watched');
});

test('the precedence agrees with the server gate wherever the gate has an opinion', () => {
  // `resolveWatchState` is binary, so `unwatched` folds onto its `ignored` — but
  // the two must never disagree about *watched*, or the panel would file a row the
  // harness is working under a tab saying nothing will happen to it.
  for (const labels of [[], [LABELS.watchLabel], [LABELS.ignoreLabel], [LABELS.watchLabel, LABELS.ignoreLabel]]) {
    for (const defaultWatched of [true, false]) {
      const opts = { ...LABELS, defaultWatched };
      const gate = resolveWatchState(labels, opts);
      const bucket = watchBucket(labels, opts);
      assert.equal(bucket === 'watched', gate === 'watched', `${labels.join('+')} @ default=${defaultWatched}`);
    }
  }
});
