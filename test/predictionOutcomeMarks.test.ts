import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import type { PredictionStore } from '../src/store/predictions.js';
import type { PredictionMark, PredictionSlot } from '../src/types.js';

// → docs/spec/14-persistence.md#moment-two--was-the-plan-right

/**
 * Moment two — "was the plan right?" — is a second record over the same slots, and
 * the whole point of it being second is that it disagrees with moment one. These
 * assertions are about the two never being read off one another.
 */

const SLOTS: readonly PredictionSlot[] = ['locus', 'cause', 'hard', 'surprise'];

function predicted(slots: Partial<Record<PredictionSlot, string>> = {}): {
  store: Store;
  predictions: PredictionStore;
} {
  const store = new Store(':memory:');
  const predictions = store.openPredictions();
  predictions.recordPrediction({
    originRef: 'issue:12',
    author: 'operator',
    slots: { locus: 'the store', cause: 'a missing index', hard: 'the migration', surprise: 'nothing', ...slots },
  });
  predictions.recordReveal('issue:12');
  return { store, predictions };
}

test('the two moments are independent: moment one answered leaves moment two absent, and never missed', () => {
  const { store, predictions } = predicted();
  assert.ok(predictions.recordPlanMarks({ originRef: 'issue:12', marks: { locus: 'matched', cause: 'missed' } }).ok);

  const standing = predictions.getPrediction('issue:12')!;
  assert.deepEqual(standing.planMarks, { locus: 'matched', cause: 'missed', hard: null, surprise: null });
  assert.deepEqual(
    standing.outcomeMarks,
    { locus: null, cause: null, hard: null, surprise: null },
    'an unanswered second moment is absent on every slot',
  );
  for (const slot of SLOTS)
    assert.notEqual(standing.outcomeMarks[slot], 'missed', 'a skipped moment two is never folded into a miss');
  assert.ok(standing.planMarkedAt !== null, 'moment one was answered');
  assert.equal(standing.outcomeMarkedAt, null, 'and moment two was not');
  store.close();
});

test('and the other way round: moment two answered leaves moment one absent, and never missed', () => {
  const { store, predictions } = predicted();
  assert.ok(predictions.recordOutcomeMarks({ originRef: 'issue:12', marks: { hard: 'matched' } }).ok);

  const standing = predictions.getPrediction('issue:12')!;
  assert.deepEqual(standing.outcomeMarks, { locus: null, cause: null, hard: 'matched', surprise: null });
  assert.deepEqual(standing.planMarks, { locus: null, cause: null, hard: null, surprise: null });
  for (const slot of SLOTS) assert.notEqual(standing.planMarks[slot], 'missed');
  assert.equal(standing.planMarkedAt, null);
  assert.ok(standing.outcomeMarkedAt !== null);
  store.close();
});

test('the four cross combinations round-trip distinctly, the operator-was-right row included', () => {
  const { store, predictions } = predicted();
  // Read as (did I predict the plan?, was the plan right?) per slot.
  const plan: Record<PredictionSlot, PredictionMark> = {
    locus: 'missed', // missed the plan, and the plan turned out wrong: the operator was right.
    cause: 'matched', // matched a plan that turned out wrong: both wrong together.
    hard: 'matched', // matched a plan that turned out right.
    surprise: 'missed', // missed a plan that turned out right.
  };
  const outcome: Record<PredictionSlot, PredictionMark> = {
    locus: 'missed',
    cause: 'missed',
    hard: 'matched',
    surprise: 'matched',
  };
  assert.ok(predictions.recordPlanMarks({ originRef: 'issue:12', marks: plan }).ok);
  assert.ok(predictions.recordOutcomeMarks({ originRef: 'issue:12', marks: outcome }).ok);

  const standing = predictions.getPrediction('issue:12')!;
  assert.deepEqual(standing.planMarks, plan);
  assert.deepEqual(standing.outcomeMarks, outcome);

  const pairs = SLOTS.map((slot) => `${standing.planMarks[slot]}/${standing.outcomeMarks[slot]}`);
  assert.equal(new Set(pairs).size, 4, 'all four combinations are distinguishable after a round trip');
  assert.equal(pairs[0], 'missed/missed', 'the operator having been right survives as its own pair');
  assert.equal(pairs[1], 'matched/missed', 'and is not confused with the fleet and the operator wrong together');
  store.close();
});

test('a slot the prediction skipped cannot be marked at moment two either', () => {
  const store = new Store(':memory:');
  const predictions = store.openPredictions();
  predictions.recordPrediction({ originRef: 'issue:12', author: null, slots: { locus: 'the store' } });
  predictions.recordReveal('issue:12');

  const refused = predictions.recordOutcomeMarks({ originRef: 'issue:12', marks: { cause: 'matched' } });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.reason, 'slot-skipped');
  assert.equal(refused.ok === false && refused.reason === 'slot-skipped' && refused.slot, 'cause');
  assert.equal(predictions.getPrediction('issue:12')!.outcomeMarkedAt, null, 'and the refusal wrote nothing');

  assert.ok(predictions.recordOutcomeMarks({ originRef: 'issue:12', marks: { locus: 'missed' } }).ok);
  store.close();
});

test('moment two is refused on a goal with no prediction, and on one that was never revealed', () => {
  const store = new Store(':memory:');
  const predictions = store.openPredictions();
  const none = predictions.recordOutcomeMarks({ originRef: 'issue:12', marks: { locus: 'matched' } });
  assert.equal(none.ok === false && none.reason, 'no-prediction');

  predictions.recordPrediction({ originRef: 'issue:12', author: null, slots: { locus: 'the store' } });
  const unseen = predictions.recordOutcomeMarks({ originRef: 'issue:12', marks: { locus: 'matched' } });
  assert.equal(
    unseen.ok === false && unseen.reason,
    'not-revealed',
    'both moments stand over the same population, so neither is answerable on a plan never shown',
  );
  store.close();
});

test('moment two is re-markable, and un-marking every slot takes the stamp back down', () => {
  const { store, predictions } = predicted();
  assert.ok(predictions.recordOutcomeMarks({ originRef: 'issue:12', marks: { locus: 'matched' } }).ok);
  assert.ok(predictions.recordOutcomeMarks({ originRef: 'issue:12', marks: { locus: 'missed' } }).ok);
  assert.equal(predictions.getPrediction('issue:12')!.outcomeMarks.locus, 'missed');
  assert.ok(predictions.getPrediction('issue:12')!.outcomeMarkedAt !== null);

  assert.ok(predictions.recordOutcomeMarks({ originRef: 'issue:12', marks: { locus: null } }).ok);
  assert.equal(
    predictions.getPrediction('issue:12')!.outcomeMarkedAt,
    null,
    'the stamp is derived from the marks, so an emptied moment reads as unanswered again',
  );
  store.close();
});

test('the owed list is moment one answered and moment two not, and it carries refs only', () => {
  const { store, predictions } = predicted();
  assert.deepEqual(predictions.listOutcomeOwed(), [], 'an unmarked goal owes nothing — it was never asked');

  assert.ok(predictions.recordPlanMarks({ originRef: 'issue:12', marks: { locus: 'matched' } }).ok);
  assert.deepEqual(predictions.listOutcomeOwed(), ['issue:12']);

  assert.ok(predictions.recordOutcomeMarks({ originRef: 'issue:12', marks: { locus: 'missed' } }).ok);
  assert.deepEqual(predictions.listOutcomeOwed(), [], 'answered, so no longer owed');
  store.close();
});
