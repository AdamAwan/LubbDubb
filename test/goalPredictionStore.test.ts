import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';

// → docs/spec/14-persistence.md#the-prediction-store-is-not-on-store

function openStore(): Store {
  return new Store(':memory:');
}

test('a prediction is one per goal and is not re-openable', () => {
  const store = openStore();
  const predictions = store.openPredictions();

  const first = predictions.recordPrediction({
    originRef: 'issue:41',
    author: 'operator',
    slots: { locus: 'the store layer', hard: 'the migration' },
  });
  assert.ok(first);
  assert.equal(first.slots.locus, 'the store layer');
  assert.equal(first.slots.hard, 'the migration');

  // Every slot is individually skippable, and a skipped one is null rather than ''.
  assert.equal(first.slots.cause, null);
  assert.equal(first.slots.surprise, null);

  const second = predictions.recordPrediction({
    originRef: 'issue:41',
    author: 'operator',
    slots: { locus: 'somewhere else, now that I have read the plan' },
  });
  assert.equal(second, null, 'a second prediction on the same goal is refused, never merged');
  assert.equal(predictions.getPrediction('issue:41')?.slots.locus, 'the store layer');

  store.close();
});

test('a goal with no reveal row was never offered the gate, which is not a decline', () => {
  const store = openStore();
  const predictions = store.openPredictions();

  assert.equal(predictions.getReveal('issue:42'), null, 'never offered');

  const declined = predictions.recordReveal('issue:42');
  assert.equal(declined.predicted, false, 'revealed with no prediction standing is a decline');
  assert.ok(declined.revealedAt.length > 0);

  store.close();
});

test('the first press decides whether a goal was predicted on', () => {
  const store = openStore();
  const predictions = store.openPredictions();

  predictions.recordPrediction({ originRef: 'issue:43', author: null, slots: { cause: 'a stale cache' } });
  const first = predictions.recordReveal('issue:43');
  assert.equal(first.predicted, true);

  const again = predictions.recordReveal('issue:43');
  assert.deepEqual(again, first, 'a later read of an already-revealed plan cannot rewrite the record');

  store.close();
});
