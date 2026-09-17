import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { buildHarness, seedProposedPlan } from './support/revealGate.js';
import type { GoalPrediction, PredictionMark, PredictionSlot } from '../src/types.js';

// → docs/spec/14-persistence.md#the-prediction-store-is-not-on-store

const SLOTS: readonly PredictionSlot[] = ['locus', 'cause', 'hard', 'surprise'];

const FOUR = { locus: 'the store', cause: 'the migration', hard: 'the schema', surprise: 'the ALTER' };

function marksOf(body: unknown): Record<PredictionSlot, PredictionMark | null> {
  return (body as { prediction: GoalPrediction }).prediction.planMarks;
}

// ------------------------------------------------------------ null is not a miss

test('an unmarked slot reads null, and nothing about an unmarked prediction reads as a miss', async () => {
  const { system, app, close } = await buildHarness(true);
  seedProposedPlan(system, 12);
  assert.equal((await app.inject({ method: 'POST', url: '/api/goals/12/prediction', payload: FOUR })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/goals/12/reveal' })).statusCode, 200);

  const read = await app.inject({ method: 'GET', url: '/api/goals/12/prediction' });
  assert.equal(read.statusCode, 200);
  const prediction = (read.json() as { prediction: GoalPrediction }).prediction;
  for (const slot of SLOTS) {
    assert.notEqual(prediction.slots[slot], null, `${slot} was filled, so there is something to mark`);
    assert.equal(prediction.planMarks[slot], null, `${slot} is not marked yet, which is a fourth value`);
    assert.notEqual(prediction.planMarks[slot], 'missed', `an unanswered ${slot} is never folded into a miss`);
  }
  assert.equal(prediction.planMarkedAt, null, 'and no moment-one stamp, because moment one has not happened');
  await close();
});

test('a column value the vocabulary does not spell reads as unmarked, never as a miss', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-junk-mark-'));
  const path = join(dir, 'junk.db');
  const first = new Store(path);
  const predictions = first.openPredictions();
  assert.ok(predictions.recordPrediction({ originRef: 'issue:12', author: 'operator', slots: FOUR }));
  predictions.recordReveal('issue:12');
  assert.ok(predictions.recordPlanMarks({ originRef: 'issue:12', marks: { cause: 'matched' } }).ok);
  first.close();

  const raw = new Database(path);
  raw
    .prepare(`UPDATE goal_predictions SET plan_mark_locus='MATCHED?', plan_mark_hard='' WHERE origin_ref='issue:12'`)
    .run();
  raw.close();

  const second = new Store(path);
  const standing = second.openPredictions().getPrediction('issue:12');
  assert.equal(standing?.planMarks.locus, null, 'a value the vocabulary does not spell is not a mark');
  assert.notEqual(standing?.planMarks.locus, 'missed');
  assert.equal(standing?.planMarks.hard, null, 'and neither is the empty string');
  assert.equal(standing?.planMarks.cause, 'matched', 'while a value it does spell is untouched');
  second.close();
});

// ------------------------------------------------------------ the refusals

test('a mark before the reveal is refused, and the refusal lives in the store', async () => {
  const { system, app, close } = await buildHarness(true);
  seedProposedPlan(system, 12);
  assert.equal((await app.inject({ method: 'POST', url: '/api/goals/12/prediction', payload: FOUR })).statusCode, 200);

  const early = await app.inject({
    method: 'POST',
    url: '/api/goals/12/prediction/marks',
    payload: { locus: 'matched' },
  });
  assert.equal(early.statusCode, 409);
  assert.match((early.json() as { error: string }).error, /not been revealed/);

  const direct = system.predictions.recordPlanMarks({ originRef: 'issue:12', marks: { locus: 'matched' } });
  assert.equal(direct.ok, false);
  assert.equal(
    direct.ok === false ? direct.reason : null,
    'not-revealed',
    'an invariant of the record, not a route check',
  );
  assert.equal(system.predictions.getPrediction('issue:12')?.planMarks.locus, null, 'and nothing was written');
  await close();
});

test('a goal with no prediction has nothing to mark', async () => {
  const { system, app, close } = await buildHarness(true);
  seedProposedPlan(system, 12);
  assert.equal((await app.inject({ method: 'POST', url: '/api/goals/12/reveal' })).statusCode, 200);

  const none = await app.inject({
    method: 'POST',
    url: '/api/goals/12/prediction/marks',
    payload: { locus: 'matched' },
  });
  assert.equal(none.statusCode, 404);
  const direct = system.predictions.recordPlanMarks({ originRef: 'issue:12', marks: { locus: 'matched' } });
  assert.equal(direct.ok === false ? direct.reason : null, 'no-prediction');
  await close();
});

test('a slot the operator skipped cannot be marked, but un-marking it is not a change', async () => {
  const { system, app, close } = await buildHarness(true);
  seedProposedPlan(system, 12);
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/goals/12/prediction', payload: { locus: 'the store' } })).statusCode,
    200,
  );
  assert.equal((await app.inject({ method: 'POST', url: '/api/goals/12/reveal' })).statusCode, 200);

  const skipped = await app.inject({
    method: 'POST',
    url: '/api/goals/12/prediction/marks',
    payload: { locus: 'matched', surprise: 'missed' },
  });
  assert.equal(skipped.statusCode, 409);
  assert.match((skipped.json() as { error: string }).error, /surprise/, 'the refusal names the slot');
  assert.equal(
    system.predictions.getPrediction('issue:12')?.planMarks.locus,
    null,
    'the write is one transaction, so nothing from a refused call lands',
  );

  const unmark = await app.inject({
    method: 'POST',
    url: '/api/goals/12/prediction/marks',
    payload: { locus: 'matched', surprise: null },
  });
  assert.equal(unmark.statusCode, 200, 'marking an empty slot null is asking for what is already true');
  assert.equal(marksOf(unmark.json()).locus, 'matched');
  assert.equal(marksOf(unmark.json()).surprise, null);
  await close();
});

// ------------------------------------------------------------ merging

test('marking merges over what stands: one slot at a time, un-marking, and correcting', async () => {
  const { system, app, close } = await buildHarness(true);
  seedProposedPlan(system, 12);
  assert.equal((await app.inject({ method: 'POST', url: '/api/goals/12/prediction', payload: FOUR })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/goals/12/reveal' })).statusCode, 200);

  const first = await app.inject({
    method: 'POST',
    url: '/api/goals/12/prediction/marks',
    payload: { locus: 'matched' },
  });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(marksOf(first.json()), { locus: 'matched', cause: null, hard: null, surprise: null });
  const stamped = (first.json() as { prediction: GoalPrediction }).prediction.planMarkedAt;
  assert.ok(stamped, 'moment one is stamped when it happens');

  const second = await app.inject({
    method: 'POST',
    url: '/api/goals/12/prediction/marks',
    payload: { cause: 'not-applicable' },
  });
  assert.equal(second.statusCode, 200);
  assert.deepEqual(
    marksOf(second.json()),
    { locus: 'matched', cause: 'not-applicable', hard: null, surprise: null },
    'a slot the call did not name is left exactly as it stood',
  );

  const corrected = await app.inject({
    method: 'POST',
    url: '/api/goals/12/prediction/marks',
    payload: { locus: 'missed' },
  });
  assert.equal(corrected.statusCode, 200, 'a mark is a judgement the operator may correct');
  assert.deepEqual(marksOf(corrected.json()), { locus: 'missed', cause: 'not-applicable', hard: null, surprise: null });

  const undone = await app.inject({
    method: 'POST',
    url: '/api/goals/12/prediction/marks',
    payload: { locus: null },
  });
  assert.equal(undone.statusCode, 200);
  assert.deepEqual(
    marksOf(undone.json()),
    { locus: null, cause: 'not-applicable', hard: null, surprise: null },
    'null un-marks the slot without touching its neighbours',
  );

  const read = await app.inject({ method: 'GET', url: '/api/goals/12/prediction' });
  assert.deepEqual((read.json() as { prediction: GoalPrediction }).prediction.planMarks, {
    locus: null,
    cause: 'not-applicable',
    hard: null,
    surprise: null,
  });
  await close();
});

// ------------------------------------------------------------ the seal and moment one

test('the reveal seals the prediction and opens the marks — two rules that must not swap', async () => {
  const { system, app, close } = await buildHarness(true);
  seedProposedPlan(system, 12);
  assert.equal((await app.inject({ method: 'POST', url: '/api/goals/12/prediction', payload: FOUR })).statusCode, 200);

  const beforeMark = await app.inject({
    method: 'POST',
    url: '/api/goals/12/prediction/marks',
    payload: { hard: 'matched' },
  });
  assert.equal(beforeMark.statusCode, 409, 'before the reveal: marks are refused');

  assert.equal((await app.inject({ method: 'POST', url: '/api/goals/12/reveal' })).statusCode, 200);

  const late = await app.inject({ method: 'POST', url: '/api/goals/12/prediction', payload: { locus: 'now I know' } });
  assert.equal(late.statusCode, 409, 'after the reveal: a prediction is still refused — the seal is permanent');
  assert.match((late.json() as { error: string }).error, /has been revealed/);

  const afterMark = await app.inject({
    method: 'POST',
    url: '/api/goals/12/prediction/marks',
    payload: { hard: 'matched' },
  });
  assert.equal(afterMark.statusCode, 200, 'after the reveal: marks are what the gate opens onto');
  assert.equal(marksOf(afterMark.json()).hard, 'matched');
  assert.equal(
    system.predictions.getPrediction('issue:12')?.slots.locus,
    'the store',
    'and the sealed prediction itself never moved',
  );
  await close();
});
