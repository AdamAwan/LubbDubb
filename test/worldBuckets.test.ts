import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchBucket } from '../web/src/worldBuckets.js';
import { isWatched, watchLabelFor } from '../src/watchLabels.js';

const WATCH = watchLabelFor('lubbdubb');

test('the watch tag is the whole of the bucket', () => {
  assert.equal(watchBucket([WATCH], WATCH), 'watched');
  assert.equal(watchBucket(['bug'], WATCH), 'unwatched');
});

test('untagged is unwatched, for every kind of item', () => {
  assert.equal(watchBucket([], WATCH), 'unwatched');
  assert.equal(watchBucket(undefined, WATCH), 'unwatched');
});

test('the retired ignore tag is just another label now', () => {
  // It carries no watch tag, so it lands unworked by itself — which is why nothing
  // had to be migrated when the second tag went away.
  assert.equal(watchBucket(['lubbdubb-ignore'], WATCH), 'unwatched');
  assert.equal(watchBucket(['lubbdubb-ignore', WATCH], WATCH), 'watched');
});

test('an empty label turns the gate off, so nothing is ever unwatched', () => {
  const off = watchLabelFor('');
  // The tags an operator may still have on the item must not be read as gates.
  assert.equal(watchBucket(['lubbdubb-ignore', 'lubbdubb-watch'], off), 'watched');
  assert.equal(watchBucket([], off), 'watched');
});

test('the panel and the server gate never disagree', () => {
  for (const labels of [[], [WATCH], ['lubbdubb-ignore'], [WATCH, 'lubbdubb-ignore']]) {
    for (const label of [WATCH, '']) {
      assert.equal(
        watchBucket(labels, label) === 'watched',
        isWatched(labels, label),
        `${labels.join('+')} @ label=${label || '(off)'}`,
      );
    }
  }
});
