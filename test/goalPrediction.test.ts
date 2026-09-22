import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHarness, seedProposedPlan } from './support/revealGate.js';
import type { GoalPrediction, GoalReveal } from '../src/types.js';

test('a prediction needs one slot filled, and one is enough — every slot is skippable', async () => {
  const { system, app, close } = await buildHarness(true);
  seedProposedPlan(system, 12);

  const empty = await app.inject({ method: 'POST', url: '/api/goals/12/prediction', payload: {} });
  assert.equal(empty.statusCode, 400);
  assert.match((empty.json() as { error: string }).error, /at least one slot/);
  assert.equal(system.predictions.getPrediction('issue:12'), null);

  const one = await app.inject({
    method: 'POST',
    url: '/api/goals/12/prediction',
    payload: { split: 'the migration' },
  });
  assert.equal(one.statusCode, 200);
  const written = (one.json() as { prediction: GoalPrediction }).prediction;
  assert.deepEqual(written.slots, { locus: null, cause: null, split: 'the migration', avoid: null });
  assert.deepEqual(system.predictions.getPrediction('issue:12')?.id, written.id);
  await close();
});

test('a prediction is written once and is not re-openable', async () => {
  const { system, app, close } = await buildHarness(true);
  seedProposedPlan(system, 12);

  const first = await app.inject({ method: 'POST', url: '/api/goals/12/prediction', payload: { locus: 'the store' } });
  assert.equal(first.statusCode, 200);
  const second = await app.inject({ method: 'POST', url: '/api/goals/12/prediction', payload: { locus: 'the api' } });
  assert.equal(second.statusCode, 409);
  assert.match((second.json() as { error: string }).error, /recorded once/);
  assert.equal(system.predictions.getPrediction('issue:12')?.slots.locus, 'the store');

  assert.equal(
    system.predictions.recordPrediction({ originRef: 'issue:12', author: null, slots: { cause: 'again' } }),
    null,
    'the store refuses a second prediction itself, not only the route',
  );
  await close();
});

test('the reveal is the seal: a prediction typed after it is not one', async () => {
  const { system, app, close } = await buildHarness(true);
  seedProposedPlan(system, 12);

  const revealed = await app.inject({ method: 'POST', url: '/api/goals/12/reveal' });
  assert.equal(revealed.statusCode, 200);

  const late = await app.inject({ method: 'POST', url: '/api/goals/12/prediction', payload: { locus: 'the store' } });
  assert.equal(late.statusCode, 409);
  assert.match((late.json() as { error: string }).error, /has been revealed/);
  assert.equal(system.predictions.getPrediction('issue:12'), null);

  assert.equal(
    system.predictions.recordPrediction({ originRef: 'issue:12', author: null, slots: { locus: 'the store' } }),
    null,
    'the seal is an invariant of the record, not a check at the route',
  );
  assert.equal(system.predictions.getPrediction('issue:12'), null);
  await close();
});

test('the reveal row remembers whether the goal was predicted on', async () => {
  const { system, app, close } = await buildHarness(true);
  seedProposedPlan(system, 12);
  seedProposedPlan(system, 13);

  await app.inject({ method: 'POST', url: '/api/goals/12/prediction', payload: { avoid: 'the schema' } });
  const predicted = await app.inject({ method: 'POST', url: '/api/goals/12/reveal' });
  assert.equal((predicted.json() as { reveal: GoalReveal }).reveal.predicted, true);

  const declined = await app.inject({ method: 'POST', url: '/api/goals/13/reveal' });
  assert.equal((declined.json() as { reveal: GoalReveal }).reveal.predicted, false);

  const read = await app.inject({ method: 'GET', url: '/api/goals/12/prediction' });
  assert.equal(read.statusCode, 200);
  const both = read.json() as { prediction: GoalPrediction | null; reveal: GoalReveal | null };
  assert.equal(both.prediction?.slots.avoid, 'the schema');
  assert.ok(both.reveal);

  const never = await app.inject({ method: 'GET', url: '/api/goals/99/prediction' });
  assert.deepEqual(never.json(), { prediction: null, reveal: null }, 'never offered is not a decline');
  await close();
});
