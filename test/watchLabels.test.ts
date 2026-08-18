import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWatched, watchLabelFor } from '../src/watchLabels.js';

test('watchLabelFor derives the one tag from the prefix', () => {
  assert.equal(watchLabelFor('lubbdubb'), 'lubbdubb-watch');
  assert.equal(watchLabelFor('team'), 'team-watch');
});

test('an empty prefix yields an empty label, which is the gate turned off', () => {
  assert.equal(watchLabelFor(''), '');
  assert.equal(isWatched([], ''), true);
  assert.equal(isWatched(undefined, ''), true);
});

test('isWatched: the tag, and nothing else', () => {
  assert.equal(isWatched(['lubbdubb-watch'], 'lubbdubb-watch'), true);
  assert.equal(isWatched(['lubbdubb-watch', 'bug'], 'lubbdubb-watch'), true);
  assert.equal(isWatched(['bug'], 'lubbdubb-watch'), false);
  assert.equal(isWatched([], 'lubbdubb-watch'), false);
  assert.equal(isWatched(undefined, 'lubbdubb-watch'), false, 'no labels at all is not watched');
});

test('the retired ignore tag decides nothing', () => {
  // It was the third state. An item carrying it simply has no watch tag, so it is
  // left alone by the same rule that leaves every untagged item alone.
  assert.equal(isWatched(['lubbdubb-ignore'], 'lubbdubb-watch'), false);
  assert.equal(isWatched(['lubbdubb-ignore', 'lubbdubb-watch'], 'lubbdubb-watch'), true);
});
