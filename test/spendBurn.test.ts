import { test } from 'node:test';
import assert from 'node:assert/strict';
import { burnPass, validateBurnPolicy, DEFAULT_BURN, type BurnPolicy } from '../src/insights/spendBurn.js';
import type { Agent, HumanTask, Task } from '../src/types.js';

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
    steps: null,
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

function fleet(liveCost: number | null, over: Partial<Task> = { rule: 'pr-ci-failing', profile: 'standard' }) {
  const settled = [1, 2, 2, 2, 3].map((cost, i) => agent(`s${i}`, { costUsd: cost }));
  const live = agent('live', { status: 'running', costUsd: liveCost, endedAt: null });
  return {
    agents: [...settled, live],
    tasks: [...settled.map((a) => task(a.id, over)), task('live', over)],
  };
}

const POLICY: BurnPolicy = {
  ...DEFAULT_BURN,
  multiple: 4,
  minimumRuns: 5,
  floorUsd: 1,
  ceilingUsd: null,
  ceilingMinutes: null,
};

test('a live run far past its own kind of work is filed, and one merely above the median is not', () => {
  const over = burnPass({ policy: POLICY, ...fleet(9), existing: [], now: T });
  assert.equal(over.length, 1, 'nine dollars against a two-dollar median is four and a half times over');
  const step = over[0];
  assert.ok(step && step.kind === 'file');
  assert.equal(step.agentId, 'live');
  assert.match(step.detail, /4\.5×/, 'the notice says how far past it is');
  assert.match(step.detail, /\$2\.00 median of the 5 settled/, 'and what it is being compared against');
  assert.doesNotMatch(step.title, /\d/, 'no figure in the title — it is the dedup key, and must be stable per pulse');

  const under = burnPass({ policy: POLICY, ...fleet(7), existing: [], now: T });
  assert.deepEqual(under, [], 'three and a half times over is inside the multiple');
});

test('a multiple of almost nothing is not an alarm', () => {
  const cheap = { rule: 'issue-retro', profile: 'fast' };
  const settled = [0.02, 0.03, 0.03, 0.03, 0.04].map((cost, i) => agent(`s${i}`, { costUsd: cost }));
  const live = agent('live', { status: 'running', costUsd: 0.6, endedAt: null });
  const steps = burnPass({
    policy: POLICY,
    agents: [...settled, live],
    tasks: [...settled.map((a) => task(a.id, cheap)), task('live', cheap)],
    existing: [],
    now: T,
  });
  assert.deepEqual(steps, [], 'twenty times the median, and still under the dollar floor');
});

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
    now: T,
  });
  assert.deepEqual(steps, [], 'twelve dollars is ordinary for a deep run and twelve times a fast one');
});

test('a bucket without enough settled runs is silent, not guessed at', () => {
  const settled = [1, 2, 2].map((cost, i) => agent(`s${i}`, { costUsd: cost }));
  const live = agent('live', { status: 'running', costUsd: 500, endedAt: null });
  const steps = burnPass({
    policy: POLICY,
    agents: [...settled, live],
    tasks: [...settled.map((a) => task(a.id, { rule: 'issue-plan' })), task('live', { rule: 'issue-plan' })],
    existing: [],
    now: T,
  });
  assert.deepEqual(steps, [], 'three runs is not a baseline, however extreme the live one looks');
});

test('the flat ceiling fires with no bucket behind it, and says that is what it did', () => {
  const live = agent('live', { status: 'running', costUsd: 40, endedAt: null });
  const steps = burnPass({
    policy: { ...POLICY, ceilingUsd: 25 },
    agents: [live],
    tasks: [task('live', { rule: 'issue-plan' })],
    existing: [],
    now: T,
  });
  const step = steps[0];
  assert.ok(step && step.kind === 'file');
  assert.match(step.detail, /per-run spend ceiling/);
  assert.match(step.detail, /flat limit, not a comparison/, 'it does not claim the run is unusual');
});

test('a run that reports no spend can never trip the spend arm', () => {
  const steps = burnPass({ policy: { ...POLICY, ceilingUsd: 0.01 }, ...fleet(null), existing: [], now: T });
  assert.deepEqual(steps, [], 'no reading is not a reading of zero, and not one of everything either');
});

test('the notice settles itself when the run ends, naming what it finally cost', () => {
  const ended = agent('live', { status: 'failed', costUsd: 31.5 });
  const steps = burnPass({
    policy: POLICY,
    agents: [ended],
    tasks: [task('live', { rule: 'pr-ci-failing' })],
    existing: [humanTask({ agentId: 'live' })],
    now: T,
  });
  assert.deepEqual(steps, [
    {
      kind: 'settle',
      taskId: 'ht_1',
      status: 'done',
      resolution: 'the run ended failed having spent $31.50 and run for 0 minutes',
    },
  ]);
});

test('a notice the operator has already settled is not re-filed while the run continues', () => {
  const steps = burnPass({
    policy: POLICY,
    ...fleet(9),
    existing: [humanTask({ agentId: 'live', status: 'done', resolvedAt: T })],
    now: T,
  });
  assert.deepEqual(steps, []);
});

test('the watch turned off files nothing and still settles what is standing', () => {
  const ended = agent('live', { status: 'done', costUsd: 3 });
  const other = agent('hot', { status: 'running', costUsd: 90, endedAt: null });
  const steps = burnPass({
    policy: { ...POLICY, enabled: false },
    agents: [ended, other],
    tasks: [task('live'), task('hot')],
    existing: [humanTask({ agentId: 'live' })],
    now: T,
  });
  assert.equal(steps.length, 1);
  assert.equal(steps[0]?.kind, 'settle');
});

test('a policy that would file constantly is refused at load, naming the key', () => {
  assert.throws(() => validateBurnPolicy({ ...POLICY, multiple: 1 }), /spendBurn\.multiple/);
  assert.throws(() => validateBurnPolicy({ ...POLICY, minimumRuns: 0 }), /spendBurn\.minimumRuns/);
  assert.throws(() => validateBurnPolicy({ ...POLICY, floorUsd: -1 }), /spendBurn\.floorUsd/);
  assert.throws(() => validateBurnPolicy({ ...POLICY, ceilingUsd: 0 }), /spendBurn\.ceilingUsd/);
  assert.throws(() => validateBurnPolicy({ ...POLICY, floorMinutes: -1 }), /spendBurn\.floorMinutes/);
  assert.throws(() => validateBurnPolicy({ ...POLICY, ceilingMinutes: 0 }), /spendBurn\.ceilingMinutes/);
  assert.throws(() => validateBurnPolicy({ ...POLICY, floorSteps: -1 }), /spendBurn\.floorSteps/);
  assert.throws(() => validateBurnPolicy({ ...POLICY, ceilingSteps: 0 }), /spendBurn\.ceilingSteps/);
  validateBurnPolicy(DEFAULT_BURN);
});

const LATER = '2026-08-04T10:35:00.000Z';

test('a run going far longer than its kind of work is flagged, on a clock nothing else reads', () => {
  const settled = [10, 12, 12, 13, 15].map((mins, i) =>
    agent(`s${i}`, { startedAt: T, endedAt: new Date(Date.parse(T) + mins * 60_000).toISOString() }),
  );
  const live = agent('live', { status: 'running', costUsd: null, steps: null, startedAt: T, endedAt: null });
  const steps = burnPass({
    policy: POLICY,
    agents: [...settled, live],
    tasks: [...settled.map((a) => task(a.id, { rule: 'pr-ci-failing' })), task('live', { rule: 'pr-ci-failing' })],
    existing: [],
    now: LATER,
  });
  const step = steps[0];
  assert.ok(step && step.kind === 'file', 'ninety-five minutes against a twelve-minute median');
  assert.match(step.detail, /95 minutes/);
  assert.match(step.detail, /12-minute median of the 5 settled/);
});

test('the runtime ceiling fires with no history at all — the young deployment the money arms cannot serve', () => {
  const live = agent('live', { status: 'running', costUsd: null, steps: null, startedAt: T, endedAt: null });
  const steps = burnPass({
    policy: { ...DEFAULT_BURN, ceilingMinutes: 60 },
    agents: [live],
    tasks: [task('live', { rule: 'issue-plan' })],
    existing: [],
    now: LATER,
  });
  const step = steps[0];
  assert.ok(step && step.kind === 'file');
  assert.match(step.detail, /per-run runtime ceiling/);
  assert.match(step.detail, /flat limit, not a comparison/);
});

test('a cheap run looping for hours is caught on steps, where its spend never would be', () => {
  const settled = [20, 25, 25, 30, 35].map((n, i) => agent(`s${i}`, { costUsd: 0.05, steps: n }));
  const live = agent('live', { status: 'running', costUsd: 0.4, steps: 400, endedAt: null });
  const steps = burnPass({
    policy: { ...POLICY, ceilingMinutes: null },
    agents: [...settled, live],
    tasks: [...settled.map((a) => task(a.id, { rule: 'issue-fix' })), task('live', { rule: 'issue-fix' })],
    existing: [],
    now: T,
  });
  const step = steps[0];
  assert.ok(step && step.kind === 'file', 'forty cents is under the dollar floor; four hundred steps is not');
  assert.match(step.detail, /400 steps/);
  assert.match(step.detail, /25-step median/);
});

test('a run that has taken no measured step is not read as a run that took none', () => {
  const settled = [20, 25, 25, 30, 35].map((n, i) => agent(`s${i}`, { steps: n }));
  const live = agent('live', { status: 'running', costUsd: null, steps: null, endedAt: null });
  const steps = burnPass({
    policy: { ...POLICY, ceilingSteps: 1, ceilingMinutes: null },
    agents: [...settled, live],
    tasks: [...settled.map((a) => task(a.id, { rule: 'issue-fix' })), task('live', { rule: 'issue-fix' })],
    existing: [],
    now: T,
  });
  assert.deepEqual(steps, [], 'unmeasured is not zero and not everything — the mock runtime counts no steps');
});

test('one title covers every axis, so a run that trips a second one does not file a second notice', () => {
  const live = agent('live', { status: 'running', costUsd: 90, steps: 900, startedAt: T, endedAt: null });
  const both = burnPass({
    policy: { ...DEFAULT_BURN, ceilingUsd: 25, ceilingSteps: 100, ceilingMinutes: 60 },
    agents: [live],
    tasks: [task('live', { rule: 'issue-plan' })],
    existing: [],
    now: LATER,
  });
  assert.equal(both.length, 1, 'three axes past their ceiling is still one agent and one notice');
  const step = both[0];
  assert.ok(step && step.kind === 'file');
  assert.doesNotMatch(step.title, /\d/, 'the title is the dedup key and carries no figure');
  assert.match(step.detail, /900 steps and 95 minutes/, 'the axes it did not lead on are still reported');
});

test('a notice names the rung above the run, and says nothing when there is none', () => {
  const live = agent('live', { status: 'running', startedAt: T, endedAt: null });
  const call = (profile: string | null) =>
    burnPass({
      policy: { ...DEFAULT_BURN, ceilingMinutes: 60 },
      agents: [live],
      tasks: [task('live', { rule: 'issue-plan', profile })],
      existing: [],
      now: LATER,
      profiles: ['fast', 'standard', 'deep'],
    })[0];

  const liftable = call('fast');
  assert.ok(liftable && liftable.kind === 'file');
  assert.match(liftable.detail, /\*\*standard\*\* sits above it/);

  const deepest = call('deep');
  assert.ok(deepest && deepest.kind === 'file');
  assert.doesNotMatch(deepest.detail, /sits above it/, 'there is no rung above the deepest profile');
});

test('a run parked on a person is not judged on a clock it does not control', () => {
  const parked = agent('live', { status: 'waiting', costUsd: null, steps: null, startedAt: T, endedAt: null });
  const policy = { ...DEFAULT_BURN, ceilingMinutes: 60 };
  const held = burnPass({
    policy,
    agents: [parked],
    tasks: [task('live', { rule: 'issue-plan' })],
    existing: [],
    now: LATER,
  });
  assert.deepEqual(held, [], 'an escalation is already a row; the hours behind it are not a runaway');

  const running = burnPass({
    policy,
    agents: [{ ...parked, status: 'running' }],
    tasks: [task('live', { rule: 'issue-plan' })],
    existing: [],
    now: LATER,
  });
  assert.equal(running.length, 1, 'the same run, working rather than parked, is');
});
