import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWatchState, watchLabelsFor } from '../src/watchLabels.js';

const labels = { watchLabel: 'lubbdubb-watch', ignoreLabel: 'lubbdubb-ignore' };

test('watchLabelsFor derives the -watch/-ignore pair from the prefix', () => {
  assert.deepEqual(watchLabelsFor('lubbdubb'), { watchLabel: 'lubbdubb-watch', ignoreLabel: 'lubbdubb-ignore' });
  assert.deepEqual(watchLabelsFor('team'), { watchLabel: 'team-watch', ignoreLabel: 'team-ignore' });
});

test('resolveWatchState: ignore always wins', () => {
  assert.equal(resolveWatchState(['lubbdubb-ignore'], { ...labels, defaultWatched: true }), 'ignored');
  assert.equal(resolveWatchState(['lubbdubb-ignore'], { ...labels, defaultWatched: false }), 'ignored');
  // Both tags present → ignore wins over watch, for either default.
  assert.equal(
    resolveWatchState(['lubbdubb-watch', 'lubbdubb-ignore'], { ...labels, defaultWatched: false }),
    'ignored',
  );
});

test('resolveWatchState: an explicit watch tag wins over the default', () => {
  assert.equal(resolveWatchState(['lubbdubb-watch'], { ...labels, defaultWatched: false }), 'watched');
  assert.equal(resolveWatchState(['lubbdubb-watch'], { ...labels, defaultWatched: true }), 'watched');
});

test('resolveWatchState: no tag falls through to the type default', () => {
  // PR (opt-out) → watched; issue/story (opt-in) → ignored.
  assert.equal(resolveWatchState([], { ...labels, defaultWatched: true }), 'watched');
  assert.equal(resolveWatchState([], { ...labels, defaultWatched: false }), 'ignored');
  assert.equal(resolveWatchState(['bug'], { ...labels, defaultWatched: false }), 'ignored');
  assert.equal(resolveWatchState(undefined, { ...labels, defaultWatched: true }), 'watched');
});
