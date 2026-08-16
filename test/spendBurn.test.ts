import { test } from 'node:test';
import assert from 'node:assert/strict';
import { burnPass, validateBurnPolicy, DEFAULT_BURN, type BurnPolicy } from '../src/spendBurn.js';
import type { Agent, HumanTask, Task } from '../src/types.js';

/**
 * The live burn watch.
 *
 * What this has to get right is not the arithmetic but the three claims the
 * notice makes: that the run is being compared against *its own kind of work*
 * (rule and profile, never rule alone), that a bucket with nothing in it produces
 * silence rather than a guess, and that the row settles itself when the run ends.
 * Each of the gates below exists because without it the watch is on, files, and
 * is ignored — which is indistinguishable from not having it.
 */

const T = '2026-08-04T09:00:00.000Z';

function agent(id: string, over: Partial<Agent> = {}): Agent {
  return {
    id,
    taskId: `task_${id}`,
    status: 'done',
    cwd: `/wt/${id}`,
    pid: 1,
    waitingReason: null,
    sessionId: null,
    startedAt: T,
    endedAt: T,
    costUsd: 1,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: 3,
    note: null,
    notedAt: null,
    resumedAt: null,
    resumeAttempts: 0,
    ...over,
  };
}

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id: `task_${id}`,
    kind: 'code',
    title: `Task ${id}`,
    prompt: 'do it',
    branch: null,
    originRef: null,
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'done',
    agentId: id,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

function humanTask(over: Partial<HumanTask> = {}): HumanTask {
  return {
    id: 'ht_1',
    title: 'a standing notice',
    detail: null,
    originRef: null,
    partId: null,
    kind: 'burn',
    agentId: null,
    taskId: null,
    status: 'open',
    resolution: null,
    createdAt: T,
    updatedAt: T,
    resolvedAt: null,
    dismissedAt: null,
    ...over,
  };
}

/** Five settled `pr-ci-failing` runs on `standard`, median $2, and one live run to judge. */
function fleet(liveCost: number | null, over: Partial<Task> = { rule: 'pr-ci-failing', profile: 'standard' }) {
  const settled = [1, 2, 2, 2, 3].map((cost, i) => agent(`s${i}`, { costUsd: cost }));
  const live = agent('live', { status: 'running', costUsd: liveCost, endedAt: null });
  return {
    agents: [...settled, live],
    tasks: [...settled.map((a) => task(a.id, over)), task('live', over)],
  };
}

const POLICY: BurnPolicy = { ...DEFAULT_BURN, multiple: 4, minimumRuns: 5, floorUsd: 1, ceilingUsd: null };

test('a live run far past its own kind of work is filed, and one merely above the median is not', () => {
  const over = burnPass({ policy: POLICY, ...fleet(9), existing: [] });
  assert.equal(over.length, 1, 'nine dollars against a two-dollar median is four and a half times over');
  const step = over[0];
  assert.ok(step && step.kind === 'file');
  assert.equal(step.agentId, 'live');
  assert.match(step.detail, /4\.5×/, 'the notice says how far past it is');
  assert.match(step.detail, /\$2\.00 median of the 5 settled/, 'and what it is being compared against');
  assert.doesNotMatch(step.title, /\d/, 'no figure in the title — it is the dedup key, and must be stable per pulse');

  const under = burnPass({ policy: POLICY, ...fleet(7), existing: [] });
  assert.deepEqual(under, [], 'three and a half times over is inside the multiple');
});

/**
 * The gate that decides whether anyone keeps reading these. Four times the median
 * of a rule that costs pennies is still pennies, and a notice about it is the one
 * that teaches an operator to dismiss the next one unread.
 */
test('a multiple of almost nothing is not an alarm', () => {
  const cheap = { rule: 'issue-retro', profile: 'fast' };
  const settled = [0.02, 0.03, 0.03, 0.03, 0.04].map((cost, i) => agent(`s${i}`, { costUsd: cost }));
  const live = agent('live', { status: 'running', costUsd: 0.6, endedAt: null });
  const steps = burnPass({
    policy: POLICY,
    agents: [...settled, live],
    tasks: [...settled.map((a) => task(a.id, cheap)), task('live', cheap)],
    existing: [],
  });
  assert.deepEqual(steps, [], 'twenty times the median, and still under the dollar floor');
});

/**
 * The reason the bucket is keyed on both axes. A goal pinned to `deep` costs
 * several times the same rule on `fast` by design — a rule-only baseline would
 * flag every pinned run on the deployment and nothing else.
 */
test('a profile is not judged against another profile', () => {
  const cheap = [1, 1, 1, 1, 1].map((cost, i) => agent(`f${i}`, { costUsd: cost }));
  const deep = [8, 9, 9, 10, 11].map((cost, i) => agent(`d${i}`, { costUsd: cost }));
  const live = agent('live', { status: 'running', costUsd: 12, endedAt: null });
  const steps = burnPass({
    policy: POLICY,
    agents: [...cheap, ...deep, live],
    tasks: [
      ...cheap.map((a) => task(a.id, { rule: 'issue-pickup', profile: 'fast' })),
      ...deep.map((a) => task(a.id, { rule: 'issue-pickup', profile: 'deep' })),
      task('live', { rule: 'issue-pickup', profile: 'deep' }),
    ],
    existing: [],
  });
  assert.deepEqual(steps, [], 'twelve dollars is ordinary for a deep run and twelve times a fast one');
});

/** A median of four observations is not a median. Below the floor the bucket says nothing at all. */
test('a bucket without enough settled runs is silent, not guessed at', () => {
  const settled = [1, 2, 2].map((cost, i) => agent(`s${i}`, { costUsd: cost }));
  const live = agent('live', { status: 'running', costUsd: 500, endedAt: null });
  const steps = burnPass({
    policy: POLICY,
    agents: [...settled, live],
    tasks: [...settled.map((a) => task(a.id, { rule: 'issue-plan' })), task('live', { rule: 'issue-plan' })],
    existing: [],
  });
  assert.deepEqual(steps, [], 'three runs is not a baseline, however extreme the live one looks');
});

/** The arm for a deployment with no history at all, where the first runaway is also the first run. */
test('the flat ceiling fires with no bucket behind it, and says that is what it did', () => {
  const live = agent('live', { status: 'running', costUsd: 40, endedAt: null });
  const steps = burnPass({
    policy: { ...POLICY, ceilingUsd: 25 },
    agents: [live],
    tasks: [task('live', { rule: 'issue-plan' })],
    existing: [],
  });
  const step = steps[0];
  assert.ok(step && step.kind === 'file');
  assert.match(step.title, /past the per-run spend ceiling/);
  assert.match(step.detail, /flat limit, not a comparison/, 'it does not claim the run is unusual');
});

/**
 * PTY mode reports no usage at all, so `costUsd` stays null for its whole life.
 * Unmeasured is not free, and the watch must not read it as either free or
 * infinite.
 */
test('a run that reports no usage can never trip the watch', () => {
  const steps = burnPass({ policy: { ...POLICY, ceilingUsd: 0.01 }, ...fleet(null), existing: [] });
  assert.deepEqual(steps, [], 'no reading is not a reading of zero, and not one of everything either');
});

test('the notice settles itself when the run ends, naming what it finally cost', () => {
  const ended = agent('live', { status: 'failed', costUsd: 31.5 });
  const steps = burnPass({
    policy: POLICY,
    agents: [ended],
    tasks: [task('live', { rule: 'pr-ci-failing' })],
    existing: [humanTask({ agentId: 'live' })],
  });
  assert.deepEqual(steps, [
    { kind: 'settle', taskId: 'ht_1', status: 'done', resolution: 'the run ended failed having spent $31.50' },
  ]);
});

/** Answered once is answered. The row would only be refreshed, but the point is that it is not raised again. */
test('a notice the operator has already settled is not re-filed while the run continues', () => {
  const steps = burnPass({
    policy: POLICY,
    ...fleet(9),
    existing: [humanTask({ agentId: 'live', status: 'done', resolvedAt: T })],
  });
  assert.deepEqual(steps, []);
});

/** Turning the watch off must drain the bench, or a row about last Tuesday's run has no way left to close. */
test('the watch turned off files nothing and still settles what is standing', () => {
  const ended = agent('live', { status: 'done', costUsd: 3 });
  const other = agent('hot', { status: 'running', costUsd: 90, endedAt: null });
  const steps = burnPass({
    policy: { ...POLICY, enabled: false },
    agents: [ended, other],
    tasks: [task('live'), task('hot')],
    existing: [humanTask({ agentId: 'live' })],
  });
  assert.equal(steps.length, 1);
  assert.equal(steps[0]?.kind, 'settle');
});

test('a policy that would file constantly is refused at load, naming the key', () => {
  assert.throws(() => validateBurnPolicy({ ...POLICY, multiple: 1 }), /spendBurn\.multiple/);
  assert.throws(() => validateBurnPolicy({ ...POLICY, minimumRuns: 0 }), /spendBurn\.minimumRuns/);
  assert.throws(() => validateBurnPolicy({ ...POLICY, floorUsd: -1 }), /spendBurn\.floorUsd/);
  assert.throws(() => validateBurnPolicy({ ...POLICY, ceilingUsd: 0 }), /spendBurn\.ceilingUsd/);
  validateBurnPolicy(DEFAULT_BURN);
});
