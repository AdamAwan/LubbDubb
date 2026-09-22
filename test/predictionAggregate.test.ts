import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHarness, seedProposedPlan } from './support/revealGate.js';
import type { PredictionAggregate } from '../src/wire.js';

// → docs/spec/18-observability.md

type Harness = Awaited<ReturnType<typeof buildHarness>>;

/** The four slots, each carrying a string nothing but the record itself may ever repeat. */
const SLOT_SENTINELS = {
  locus: 'quokka-locus-sentinel',
  cause: 'quokka-cause-sentinel',
  split: 'quokka-split-sentinel',
  avoid: 'quokka-avoid-sentinel',
};

async function aggregate(harness: Harness): Promise<PredictionAggregate> {
  const res = await harness.app.inject({ method: 'GET', url: '/api/predictions/aggregate' });
  assert.equal(res.statusCode, 200);
  return (res.json() as { aggregate: PredictionAggregate }).aggregate;
}

async function predict(harness: Harness, number: number, slots: Record<string, string>): Promise<void> {
  const res = await harness.app.inject({ method: 'POST', url: `/api/goals/${number}/prediction`, payload: slots });
  assert.equal(res.statusCode, 200, res.body);
}

async function reveal(harness: Harness, number: number): Promise<void> {
  const res = await harness.app.inject({ method: 'POST', url: `/api/goals/${number}/reveal` });
  assert.equal(res.statusCode, 200, res.body);
}

async function mark(
  harness: Harness,
  number: number,
  moment: 'marks' | 'outcome',
  marks: Record<string, string>,
): Promise<void> {
  const res = await harness.app.inject({
    method: 'POST',
    url: `/api/goals/${number}/prediction/${moment}`,
    payload: marks,
  });
  assert.equal(res.statusCode, 200, res.body);
}

test('the aggregate tells predicted, declined and never offered apart', async () => {
  const harness = await buildHarness(true);
  for (const number of [1, 2, 3]) seedProposedPlan(harness.system, number);

  await predict(harness, 1, { locus: SLOT_SENTINELS.locus });
  await reveal(harness, 1);
  await reveal(harness, 2);
  // Goal 3 has a plan and no reveal row: the gate was never put to it.

  const read = await aggregate(harness);
  assert.equal(read.goals.offered, 2);
  assert.equal(read.goals.predicted, 1);
  assert.equal(read.goals.declined, 1);
  assert.equal(read.goals.notOffered, 1, 'a goal with no reveal row is never offered, and never a decline');
  await harness.close();
});

test('below the threshold every rate is absent and the counts behind it are not', async () => {
  const harness = await buildHarness(true);
  for (const number of [1, 2, 3, 4]) {
    seedProposedPlan(harness.system, number);
    await predict(harness, number, SLOT_SENTINELS);
    await reveal(harness, number);
    await mark(harness, number, 'marks', { locus: 'matched' });
  }

  const read = await aggregate(harness);
  assert.equal(read.threshold, 10, 'the default of the config key, not a literal in the panel');
  assert.equal(read.coverageRate, null);
  assert.equal(read.declineRate, null);
  assert.equal(read.goals.offered, 4, 'the count toward the threshold stands where the rate would be');
  assert.equal(read.goals.predicted, 4);
  assert.equal(read.goals.planMarked, 4);

  const locus = read.slots.find((slot) => slot.slot === 'locus');
  assert.ok(locus?.plan);
  assert.equal(locus.plan.matchRate, null);
  assert.equal(locus.plan.matched, 4, 'and the count it would be over is still there');
  assert.equal(locus.plan.judged, 4);
  await harness.close();
});

test('at the threshold the rates arrive, each beside the n it is over', async () => {
  const harness = await buildHarness(true);
  for (const number of Array.from({ length: 12 }, (_, i) => i + 1)) {
    seedProposedPlan(harness.system, number);
    if (number <= 10) await predict(harness, number, SLOT_SENTINELS);
    await reveal(harness, number);
    if (number <= 10) await mark(harness, number, 'marks', { locus: number <= 7 ? 'matched' : 'missed' });
  }

  const read = await aggregate(harness);
  assert.deepEqual(read.coverageRate, { rate: 10 / 12, n: 12 });
  assert.deepEqual(
    read.declineRate,
    { rate: 2 / 12, n: 12 },
    'the decline rate is a first-class figure beside coverage',
  );

  const locus = read.slots.find((slot) => slot.slot === 'locus');
  assert.deepEqual(locus?.plan?.matchRate, { rate: 0.7, n: 10 }, 'a slot rate stands on its own n');
  assert.equal(locus?.outcome, null, 'and moment two, unanswered on every one of them, is still absent');
  await harness.close();
});

test('a slot nobody marked is absent rather than nought per cent, and so is a slot nobody filled', async () => {
  const harness = await buildHarness(true);
  seedProposedPlan(harness.system, 1);
  await predict(harness, 1, { locus: SLOT_SENTINELS.locus, cause: SLOT_SENTINELS.cause });
  await reveal(harness, 1);
  await mark(harness, 1, 'marks', { locus: 'matched' });

  const read = await aggregate(harness);
  const slots = new Map(read.slots.map((slot) => [slot.slot, slot]));
  assert.deepEqual([...slots.keys()], ['locus', 'cause'], 'a slot no prediction filled has no row at all');
  assert.equal(slots.get('split'), undefined);
  assert.equal(slots.get('cause')?.plan, null, 'filled but unmarked: absent, not a nought');
  assert.equal(slots.get('cause')?.filled, 1);
  assert.ok(slots.get('locus')?.plan);
  await harness.close();
});

test('the two moments are counted separately, and an unanswered moment two is in neither column', async () => {
  const harness = await buildHarness(true);
  seedProposedPlan(harness.system, 1);
  seedProposedPlan(harness.system, 2);
  for (const number of [1, 2]) {
    await predict(harness, number, SLOT_SENTINELS);
    await reveal(harness, number);
    await mark(harness, number, 'marks', { locus: 'missed' });
  }
  await mark(harness, 1, 'outcome', { locus: 'missed' });

  const read = await aggregate(harness);
  assert.equal(read.goals.planMarked, 2);
  assert.equal(read.goals.outcomeMarked, 1);

  const locus = read.slots.find((slot) => slot.slot === 'locus');
  assert.equal(locus?.plan?.missed, 2);
  assert.equal(locus?.plan?.marked, 2);
  assert.equal(locus?.outcome?.missed, 1, 'the goal that skipped moment two is in neither of its columns');
  assert.equal(locus?.outcome?.marked, 1);
  await harness.close();
});

test('nothing in the aggregate payload is a word the operator wrote, or the author who wrote it', async () => {
  const harness = await buildHarness(true);
  seedProposedPlan(harness.system, 1);
  await predict(harness, 1, SLOT_SENTINELS);
  await reveal(harness, 1);
  await mark(harness, 1, 'marks', { locus: 'matched', cause: 'not-applicable' });
  await mark(harness, 1, 'outcome', { split: 'missed' });

  const res = await harness.app.inject({ method: 'GET', url: '/api/predictions/aggregate' });
  const body = res.body;
  for (const sentinel of Object.values(SLOT_SENTINELS)) {
    assert.ok(!body.includes(sentinel), `the aggregate carried ${sentinel}, which is prediction text`);
  }
  assert.ok(!body.includes('author'), 'the aggregate is keyed by slot and by goal, never by author');
  await harness.close();
});

test('criteria drift is a count on the aggregate, and it is never withheld', async () => {
  const harness = await buildHarness(true);
  seedProposedPlan(harness.system, 1);
  harness.system.store.goalCriteria.recordDrift({
    originRef: 'issue:1',
    criteriaId: 'crit_one',
    version: 2,
    author: null,
    reason: 'the goal moved',
  });

  const read = await aggregate(harness);
  assert.deepEqual(read.criteriaDrift, { records: 1, goals: 1 });
  await harness.close();
});

test('with the gate off the aggregate route is not mounted at all', async () => {
  const harness = await buildHarness(false);
  const res = await harness.app.inject({ method: 'GET', url: '/api/predictions/aggregate' });
  assert.equal(res.statusCode, 404);
  await harness.close();
});
