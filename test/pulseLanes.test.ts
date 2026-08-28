import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig, type Config } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildReadPlan, hydrationMaxAgeMs, type ReadPlan } from '../src/world/readPlan.js';
import type { TaskSummary, WorldEvent, WorldSnapshot } from '../src/types.js';

/**
 * The **lane split** and the **adaptive cadence** — the two halves of running the
 * pulse near-real-time without spending the providers' budget on it.
 *
 * What these hold: the pulse hands the world read a plan saying which entities are
 * worth a per-entity fan-out; a cold entity is *slower*, never *absent*; and the
 * gap to the next timer cycle follows what the fleet is actually doing.
 * → `docs/spec/04-harness-cycle.md#hot-and-cold`
 */

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function testConfig(overrides: Partial<Config> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    // Every cycle here is one somebody asked for; nothing is the timer's doing.
    heartbeatIntervalMs: 999_999,
    idleHeartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    ...overrides,
  });
}

/**
 * A system whose worktrees are faked — mandatory for anything that dispatches a code
 * agent, or the test cuts a real branch in the checkout the suite is running in.
 */
function build(overrides: Partial<Config> = {}): System {
  return buildSystem(testConfig(overrides), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
}

/** Capture the plan the pulse hands the world read, by standing in front of it. */
function capturePlans(system: System): ReadPlan[] {
  const seen: ReadPlan[] = [];
  const connector = system.connector as { getState: (plan?: ReadPlan) => Promise<WorldSnapshot> };
  const original = connector.getState.bind(system.connector);
  connector.getState = async (plan?: ReadPlan): Promise<WorldSnapshot> => {
    if (plan !== undefined) seen.push(plan);
    return original(plan);
  };
  return seen;
}

function hotRefs(plan: ReadPlan): ReadonlySet<string> {
  assert.notEqual(plan.hot, 'all', 'the pulse classifies; only a read outside it says everything is hot');
  return plan.hot as ReadonlySet<string>;
}

// --------------------------------------------------------------------------
// The rule itself
// --------------------------------------------------------------------------

const lanes = { hotMaxAgeMs: 60_000, coldMaxAgeMs: 600_000 };

function world(over: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return { takenAt: '2026-01-01T00:00:00Z', pullRequests: [], closedPullRequests: [], issues: [], ...over };
}

function pr(over: Partial<WorldSnapshot['pullRequests'][number]> = {}): WorldSnapshot['pullRequests'][number] {
  return {
    id: 'pr_1',
    number: 1,
    title: 'A',
    branch: 'feat',
    baseBranch: 'main',
    ciStatus: 'passing',
    unresolvedComments: [],
    approved: false,
    state: 'open',
    labels: [],
    url: 'u',
    ...over,
  };
}

/** Only the fields the lane rule reads; the rest of a task row is beside the point. */
function task(over: Partial<TaskSummary>): TaskSummary {
  return {
    id: 't1',
    kind: 'code',
    title: 'work',
    branch: null,
    originRef: null,
    status: 'running',
    ...over,
  } as TaskSummary;
}

function event(ref: string, agoMs: number, now: number): WorldEvent {
  return {
    id: `we_${ref}`,
    kind: 'issue_opened',
    ref,
    summary: 's',
    createdAt: new Date(now - agoMs).toISOString(),
  };
}

test('a settled, unstaffed, untouched entity is the only kind that goes cold', () => {
  const now = Date.parse('2026-06-01T12:00:00Z');
  const plan = buildReadPlan({
    previous: world({
      pullRequests: [
        pr({ id: 'pr_1', number: 1, branch: 'quiet' }),
        pr({ id: 'pr_2', number: 2, branch: 'building', ciStatus: 'pending' }),
        pr({ id: 'pr_3', number: 3, branch: 'ready', approved: true }),
        pr({ id: 'pr_4', number: 4, branch: 'stale-base', mergeableState: 'behind' }),
        pr({ id: 'pr_5', number: 5, branch: 'staffed' }),
      ],
    }),
    tasks: [
      task({ id: 't1', branch: 'staffed', originRef: 'issue:20:part:auth' }),
      // A finished task staffs nothing, so it heats nothing.
      task({ id: 't2', status: 'done', originRef: 'issue:30' }),
    ],
    events: [event('issue:40', 60_000, now), event('issue:50', 60 * 60_000, now)],
    now,
    lanes,
  });

  const hot = hotRefs(plan);
  assert.deepEqual(
    [...hot].sort(),
    ['issue:20', 'issue:40', 'pr:2', 'pr:3', 'pr:4', 'pr:5'].sort(),
    'a build in flight, merge-readiness in flux, an open dispatch, and a recent transition',
  );
  assert.equal(hot.has('pr:1'), false, 'settled, unapproved, unstaffed, quiet');
  assert.equal(hot.has('issue:30'), false, 'a task that has finished holds nothing open');
  assert.equal(hot.has('issue:50'), false, 'an hour is outside the slow lane, so it has gone quiet');

  assert.equal(hydrationMaxAgeMs(plan, 'pr:2'), lanes.hotMaxAgeMs);
  assert.equal(hydrationMaxAgeMs(plan, 'pr:1'), lanes.coldMaxAgeMs);
  // A caller that knows nothing about the fleet reads on the hot lane's terms
  // rather than declaring anything cold.
  assert.equal(hydrationMaxAgeMs({ hot: 'all', ...lanes }, 'pr:1'), lanes.hotMaxAgeMs);
});

test('before the first real cycle everything is hot, because there is nothing to reuse', () => {
  const plan = buildReadPlan({ previous: null, tasks: [], events: [], now: Date.now(), lanes });
  assert.equal(plan.hot, 'all');
});

// --------------------------------------------------------------------------
// The pulse, at the buildSystem seam
// --------------------------------------------------------------------------

test('the pulse hands the read a lane per entity, and a cold one is still in the world', async () => {
  // Lanes small enough that "recently moved" ages out inside the test: the issue
  // this injects is hot for as long as the slow lane is, exactly as a real one is.
  const system = build({ hotReadMaxAgeMs: 20, coldReadMaxAgeMs: 60 });
  system.runtimeControl.apply({ paused: true });
  system.connector.inject({ kind: 'new_issue', number: 801, title: 'An old issue nobody has touched' });
  system.connector.inject({ kind: 'new_pr', number: 802, title: 'Building', branch: 'feat-802' });
  system.connector.inject({ kind: 'ci_failed', prNumber: 802 });
  system.connector.inject({ kind: 'ci_passed', prNumber: 802 });
  await system.harness.runCycle('manual');

  const plans = capturePlans(system);
  // Long enough that the transitions the first cycle recorded are outside the slow
  // lane's window — the issue has gone quiet.
  await tick(80);
  const report = await system.harness.runCycle('manual');

  assert.equal(plans.length, 1, 'one plan per world read');
  const hot = hotRefs(plans[0]!);
  assert.equal(hot.has('issue:801'), false, 'an issue nothing is happening to is on the slow lane');
  assert.equal(plans[0]!.hotMaxAgeMs, 20, 'the lanes are the operator’s numbers, not a constant');
  assert.equal(plans[0]!.coldMaxAgeMs, 60);
  assert.equal(hydrationMaxAgeMs(plans[0]!, 'issue:801'), 60);

  // The whole point of "cold is not invisible": the dispatcher reasons over the
  // whole world, so a cold entity is in every snapshot and in the baseline.
  const baseline = system.store.getWorldBaseline();
  assert.ok(
    baseline?.issues.some((i) => i.number === 801),
    'the cold issue is in the world the cycle decided against',
  );
  assert.ok(report.cycleId.startsWith('cyc_'));
  system.store.close();
});

test('an issue the fleet is working on is hot, and stays hot while its task is open', async () => {
  const system = build({ hotReadMaxAgeMs: 20, coldReadMaxAgeMs: 60 });
  system.connector.inject({ kind: 'new_issue', number: 811, title: 'Add login' });
  await system.harness.runCycle('manual');
  assert.equal(system.store.listTasks().length, 1, 'the issue is dispatched, so the fleet is on it');

  const plans = capturePlans(system);
  await tick(80);
  await system.harness.runCycle('manual');

  assert.equal(hotRefs(plans[0]!).has('issue:811'), true, 'an open dispatch keeps its origin on the fast lane');
  system.localCycles.stop();
  system.store.close();
});

// --------------------------------------------------------------------------
// The cadence
// --------------------------------------------------------------------------

test('the cadence follows the fleet: fast while it is working, slow while it is not', async () => {
  const system = build({ heartbeatIntervalMs: 30_000, idleHeartbeatIntervalMs: 300_000 });

  const idle = await system.harness.runCycle('manual');
  assert.equal(idle.nextIntervalMs, 300_000, 'nothing running, nothing queued, nothing building');

  system.connector.inject({ kind: 'new_issue', number: 821, title: 'Add login' });
  const busy = await system.harness.runCycle('manual');
  assert.equal(system.store.listAgentsByStatus('starting', 'running').length, 1);
  assert.equal(busy.nextIntervalMs, 30_000, 'an agent is running, so the pulse takes the fast interval');

  // And back: the agent ends, the work leaves the world, and the fleet drops to
  // the idle interval on the next cycle rather than staying fast for ever.
  for (const agent of system.store.listAgentsByStatus('starting', 'running')) system.agents.complete(agent.id);
  system.localCycles.stop();
  system.connector.inject({ kind: 'issue_state', number: 821, state: 'closed' });
  const settled = await system.harness.runCycle('manual');
  assert.equal(settled.nextIntervalMs, 300_000, 'nothing running and nothing left to run');
  system.store.close();
});

test('a build in flight is enough to keep the fleet on the fast interval', async () => {
  const system = build({ heartbeatIntervalMs: 30_000, idleHeartbeatIntervalMs: 300_000 });
  system.runtimeControl.apply({ paused: true });
  system.connector.inject({ kind: 'new_pr', number: 831, title: 'Building', branch: 'feat-831' });
  // The fake reports a PR with no verdict yet as `pending` — a check that will
  // settle with no token moving anywhere, which is the commonest thing an
  // idle-looking fleet is actually waiting for.
  const report = await system.harness.runCycle('manual');
  const built = system.store.getWorldBaseline()?.pullRequests.find((p) => p.number === 831);

  assert.equal(built?.ciStatus, 'pending');
  assert.equal(report.nextIntervalMs, 30_000);
  system.store.close();
});

test('an idle interval below the heartbeat is read as the heartbeat, not as a faster slow lane', async () => {
  const system = build({ heartbeatIntervalMs: 5_000, idleHeartbeatIntervalMs: 1_000 });
  const report = await system.harness.runCycle('manual');
  assert.equal(report.nextIntervalMs, 5_000);
  system.store.close();
});

test('a refusal reports the cadence as it stands, having changed nothing', async () => {
  const system = build({ heartbeatIntervalMs: 30_000, idleHeartbeatIntervalMs: 300_000 });
  const refused = await system.harness.runCycle('local');
  assert.equal(refused.cycleId, 'unbaselined');
  assert.equal(refused.nextIntervalMs, 30_000, 'a harness that has not cycled yet has not gone idle');
  system.store.close();
});
