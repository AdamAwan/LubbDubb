import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHarness, seedProposedPlan } from './support/revealGate.js';
import type { GoalPrediction } from '../src/types.js';

// → docs/spec/16-http-api.md

const FOUR = { locus: 'the store', cause: 'the migration', hard: 'the schema', surprise: 'the ALTER' };

async function predictedAndRevealed(): Promise<Awaited<ReturnType<typeof buildHarness>>> {
  const harness = await buildHarness(true);
  seedProposedPlan(harness.system, 12);
  assert.equal(
    (await harness.app.inject({ method: 'POST', url: '/api/goals/12/prediction', payload: FOUR })).statusCode,
    200,
  );
  assert.equal((await harness.app.inject({ method: 'POST', url: '/api/goals/12/reveal' })).statusCode, 200);
  return harness;
}

test('the second moment is its own route, and each moment leaves the other unanswered', async () => {
  const { app, close } = await predictedAndRevealed();

  const one = await app.inject({ method: 'POST', url: '/api/goals/12/prediction/marks', payload: { locus: 'missed' } });
  assert.equal(one.statusCode, 200);

  let read = (await app.inject({ method: 'GET', url: '/api/goals/12/prediction' })).json() as {
    prediction: GoalPrediction;
  };
  assert.equal(read.prediction.planMarks.locus, 'missed');
  assert.equal(read.prediction.outcomeMarks.locus, null, 'absent, not missed');
  assert.equal(read.prediction.outcomeMarkedAt, null);

  const two = await app.inject({
    method: 'POST',
    url: '/api/goals/12/prediction/outcome',
    payload: { locus: 'missed', cause: 'matched' },
  });
  assert.equal(two.statusCode, 200);

  read = (await app.inject({ method: 'GET', url: '/api/goals/12/prediction' })).json() as {
    prediction: GoalPrediction;
  };
  assert.equal(read.prediction.planMarks.locus, 'missed', 'moment one is untouched');
  assert.equal(read.prediction.planMarks.cause, null, 'and moment two did not answer it');
  assert.deepEqual(read.prediction.outcomeMarks, { locus: 'missed', cause: 'matched', hard: null, surprise: null });
  assert.ok(read.prediction.outcomeMarkedAt !== null);
  await close();
});

test('the second moment refuses a skipped slot and a goal with no prediction', async () => {
  const { system, app, close } = await buildHarness(true);
  seedProposedPlan(system, 12);
  seedProposedPlan(system, 13);
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/goals/12/prediction', payload: { locus: 'the store' } })).statusCode,
    200,
  );
  assert.equal((await app.inject({ method: 'POST', url: '/api/goals/12/reveal' })).statusCode, 200);

  const skipped = await app.inject({
    method: 'POST',
    url: '/api/goals/12/prediction/outcome',
    payload: { cause: 'matched' },
  });
  assert.equal(skipped.statusCode, 409);
  assert.match((skipped.json() as { error: string }).error, /cause/);

  const none = await app.inject({
    method: 'POST',
    url: '/api/goals/13/prediction/outcome',
    payload: { locus: 'matched' },
  });
  assert.equal(none.statusCode, 404);
  await close();
});

test('the route is not mounted with the gate off', async () => {
  const { app, close } = await buildHarness(false);
  const answer = await app.inject({
    method: 'POST',
    url: '/api/goals/12/prediction/outcome',
    payload: { locus: 'matched' },
  });
  assert.equal(answer.statusCode, 404);
  await close();
});

/**
 * The bench row asking for the second moment is filed and settled by
 * `DeliveryCloseOutDesk`, and nothing but a cycle wakes that desk. An answer that
 * leaves the row standing is an operator being asked, for minutes or for good, for
 * something they have already given — so the press carries the cycle.
 */
test('answering the second moment clears the bench row it was asked through, in the same press', async () => {
  const { system, app, close } = await predictedAndRevealed();
  const rows = (): number =>
    system.store.humanTasks.listHumanTasksOfKind('outcome').filter((t) => t.status === 'open').length;

  system.store.verdicts.recordDelivery({ originRef: 'issue:12', summary: 'it shipped', by: 'assessor' });

  // Moment one is what makes the goal owe moment two, so the row arrives on this
  // press too — behind the close-out, which the bench asks for first.
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/goals/12/prediction/marks', payload: { locus: 'matched' } }))
      .statusCode,
    200,
  );
  const closeOut = system.store.humanTasks.listHumanTasksOfKind('close_out')[0];
  assert.ok(closeOut, 'the close-out is filed first, and the second moment waits behind it');
  assert.equal(
    (await app.inject({ method: 'POST', url: `/api/human-tasks/${closeOut.id}/done`, payload: {} })).statusCode,
    200,
  );
  await system.harness.runCycle('manual');
  assert.equal(rows(), 1, 'and with the close-out dealt with, the second moment is the row');

  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/goals/12/prediction/outcome', payload: { locus: 'matched' } }))
      .statusCode,
    200,
  );
  assert.equal(rows(), 0, 'answered, so the row goes with the press rather than at some later pulse');
  await close();
});
