import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { Job, WorldSnapshot } from '../src/types.js';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { buildStateSnapshot } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { Store } from '../src/store/store.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

// The "Up next" queue (issue #69): the dispatcher's ordered pickup plan with the
// headroom cut — above-cut candidates dispatch this cycle, below-cut ones wait
// for a free slot, and neither changes which actions are emitted.

function ctx(world: Partial<WorldSnapshot>, over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: 'now', pullRequests: [], issues: [], ...world },
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: [],
    steeringPriorities: [],
    agentHeadroom: 3,
    ...over,
  };
}

const issue = (number: number, labels: string[] = []) => ({
  id: `i${number}`,
  number,
  title: `Issue ${number}`,
  body: 'b',
  labels,
  state: 'open' as const,
  linkedPrNumber: null,
});

test('upcoming lists every candidate in rank order with the headroom cut', async () => {
  const d = new RuleDispatcher();
  const result = await d.decide(ctx({ issues: [issue(101), issue(102), issue(103)] }, { agentHeadroom: 1 }));

  const dispatched = result.actions.filter((a) => a.type === 'dispatch_code_agent');
  assert.equal(dispatched.length, 1, 'the cut still limits what is dispatched');

  assert.ok(result.upcoming, 'the rule dispatcher reports its plan');
  assert.deepEqual(
    result.upcoming.map((q) => [q.origin, q.status]),
    [
      ['issue:101', 'dispatching'],
      ['issue:102', 'waiting'],
      ['issue:103', 'waiting'],
    ],
    'above-cut items dispatch; the rest wait on a free slot',
  );
});

test('upcoming items carry rule, title, kind and branch for the cockpit', async () => {
  const d = new RuleDispatcher();
  const result = await d.decide(ctx({ issues: [issue(7)] }, { agentHeadroom: 0 }));
  assert.equal(result.actions[0]?.type, 'no_op', 'nothing dispatches at zero headroom');
  const item = result.upcoming?.[0];
  assert.ok(item);
  assert.equal(item.rule, 'issue-pickup');
  assert.equal(item.title, 'Resolve issue #7');
  assert.equal(item.kind, 'code');
  assert.equal(item.branch, 'issue/7');
  assert.equal(item.status, 'waiting');
  assert.ok(item.reason.length > 0);
});

test('label-encoded priority orders the queue', async () => {
  const d = new RuleDispatcher({ priorityLabels: { hot: 5 }, defaultPriority: 1 });
  const result = await d.decide(ctx({ issues: [issue(101), issue(102, ['hot'])] }, { agentHeadroom: 1 }));
  assert.deepEqual(
    result.upcoming?.map((q) => q.origin),
    ['issue:102', 'issue:101'],
    'the hot issue outranks the older one',
  );
  assert.equal(result.upcoming?.[0]?.status, 'dispatching');
});

test('cross-PR sort: failing CI outranks a review comment for scarce headroom', async () => {
  const d = new RuleDispatcher();
  const result = await d.decide(
    ctx(
      {
        pullRequests: [
          {
            id: 'a',
            number: 1,
            title: 'commented',
            branch: 'a',
            ciStatus: 'passing',
            unresolvedComments: [{ id: 'c1', author: 'bob', body: 'nit', handled: false }],
          },
          { id: 'b', number: 2, title: 'red', branch: 'b', ciStatus: 'failing', unresolvedComments: [] },
        ],
      },
      { agentHeadroom: 1 },
    ),
  );
  const dispatched = result.actions.filter((a) => a.type === 'dispatch_code_agent');
  assert.equal(dispatched.length, 1);
  assert.equal((dispatched[0] as { originRef: string }).originRef, 'pr:2:ci', 'the CI fix wins the slot');
  assert.deepEqual(
    result.upcoming?.map((q) => [q.origin, q.status]),
    [
      ['pr:2:ci', 'dispatching'],
      ['pr:1:comments', 'waiting'],
    ],
  );
});

test('a cooling-down origin shows in the queue as cooldown and is not dispatched', async () => {
  const d = new RuleDispatcher();
  const result = await d.decide(
    ctx(
      {
        takenAt: '2026-07-21T00:00:30Z',
        pullRequests: [
          {
            id: 'p',
            number: 42,
            title: 'X',
            branch: 'feat',
            baseBranch: 'main',
            ciStatus: 'passing',
            unresolvedComments: [],
            mergeable: false,
            mergeableState: 'dirty',
          },
        ],
      },
      {
        recentDecisions: [
          {
            id: 'd1',
            cycleId: 'c',
            outcome: 'executed',
            detail: '',
            rule: null,
            createdAt: '2026-07-21T00:00:00Z',
            action: { type: 'dispatch_code_agent', reason: 'r', originRef: 'pr:42:mergeable' },
          },
        ],
      },
    ),
  );
  assert.ok(!result.actions.some((a) => a.type.startsWith('dispatch_')), 'still no re-dispatch during cooldown');
  assert.deepEqual(
    result.upcoming?.map((q) => [q.origin, q.status]),
    [['pr:42:mergeable', 'cooldown']],
  );
});

test('an origin with an active task never enters the queue', async () => {
  const d = new RuleDispatcher();
  const result = await d.decide(
    ctx(
      { issues: [issue(5)] },
      {
        tasks: [
          {
            id: 't1',
            kind: 'code',
            title: 'x',
            prompt: 'x',
            branch: 'issue/5',
            originRef: 'issue:5',
            originTitle: null,
            originSummary: null,
            dispatchReason: null,
            status: 'running',
            agentId: 'ag1',
            createdAt: 'n',
            updatedAt: 'n',
          },
        ],
      },
    ),
  );
  assert.deepEqual(result.upcoming, [], 'staffed work is not "up next"');
});

// --------------------------------------------------------------------------
// Operator priority overrides (issue #128): re-order the queue by origin.
// --------------------------------------------------------------------------

const queuedJob = (id: string): Job => ({
  id,
  title: `Job ${id}`,
  prompt: 'do it',
  kind: 'code',
  branch: `job/${id}`,
  status: 'queued',
  taskId: null,
  createdAt: 'n',
  updatedAt: 'n',
});

test('an operator override jumps a world item ahead of the natural ranking', async () => {
  const d = new RuleDispatcher();
  const result = await d.decide(
    ctx(
      { issues: [issue(101), issue(102), issue(103)] },
      { agentHeadroom: 1, priorityOverrides: [{ origin: 'issue:103', rank: 0 }] },
    ),
  );
  // #103 is pinned to the top, so it takes the single slot the natural ranking
  // would have given #101.
  assert.deepEqual(
    result.upcoming?.map((q) => [q.origin, q.status]),
    [
      ['issue:103', 'dispatching'],
      ['issue:101', 'waiting'],
      ['issue:102', 'waiting'],
    ],
  );
  const dispatched = result.actions.filter((a) => a.type === 'dispatch_code_agent');
  assert.equal((dispatched[0] as { originRef: string }).originRef, 'issue:103', 'the pinned issue wins the slot');
});

test('rule-0 jobs stay first whatever the override', async () => {
  const d = new RuleDispatcher();
  const result = await d.decide(
    ctx(
      { issues: [issue(5)] },
      { agentHeadroom: 2, queuedJobs: [queuedJob('j1')], priorityOverrides: [{ origin: 'issue:5', rank: 0 }] },
    ),
  );
  // The override cannot outrank a queued job: a manual request always takes the
  // next free slot.
  assert.deepEqual(
    result.upcoming?.map((q) => q.origin),
    ['job:j1', 'issue:5'],
  );
});

test('an override re-orders a held item but never un-holds it', async () => {
  const d = new RuleDispatcher();
  const result = await d.decide(
    ctx(
      {
        takenAt: '2026-07-21T00:00:30Z',
        issues: [issue(5)],
        pullRequests: [
          {
            id: 'p',
            number: 42,
            title: 'X',
            branch: 'feat',
            baseBranch: 'main',
            ciStatus: 'passing',
            unresolvedComments: [],
            mergeable: false,
            mergeableState: 'dirty',
          },
        ],
      },
      {
        agentHeadroom: 1,
        // Pin the cooling-down PR to the very top.
        priorityOverrides: [{ origin: 'pr:42:mergeable', rank: 0 }],
        recentDecisions: [
          {
            id: 'd1',
            cycleId: 'c',
            outcome: 'executed',
            detail: '',
            rule: null,
            createdAt: '2026-07-21T00:00:00Z',
            action: { type: 'dispatch_code_agent', reason: 'r', originRef: 'pr:42:mergeable' },
          },
        ],
      },
    ),
  );
  // The held PR sits at the top (the override re-ordered it) but stays `cooldown`
  // and claims no slot, so the free headroom still goes to the fresh issue.
  assert.deepEqual(
    result.upcoming?.map((q) => [q.origin, q.status]),
    [
      ['pr:42:mergeable', 'cooldown'],
      ['issue:5', 'dispatching'],
    ],
  );
});

// --------------------------------------------------------------------------
// Snapshot plumbing: the harness caches the last cycle's plan for /api/state
// --------------------------------------------------------------------------

function testConfig(over: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    dispatcher: 'rule',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    ...over,
    // Pinned off: all four default **on** now, and this file is about the queue —
    // a planner ahead of each pickup would change every origin these assertions
    // read. Each has its own tests.
    planning: { enabled: false } as never,
    assessment: { enabled: false } as never,
    assay: { enabled: false } as never,
    retrospective: { enabled: false } as never,
  });
}

test('buildStateSnapshot ships the last cycle plan as upcoming', async () => {
  // Paused → zero headroom → the whole plan sits below the cut, and nothing
  // dispatches (so the test never touches git worktrees).
  const system = buildSystem(testConfig({ startPaused: true }), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
  });
  system.connector.inject({ kind: 'new_issue', number: 7101, title: 'A' });
  system.connector.inject({ kind: 'new_issue', number: 7102, title: 'B' });

  const before = await buildStateSnapshot(system);
  assert.equal(before.upcoming, null, 'no plan before the first cycle');

  const report = await system.harness.runCycle('manual');
  const snap = await buildStateSnapshot(system);
  assert.ok(snap.upcoming, 'the plan from the last pulse is exposed');
  assert.equal(snap.upcoming.cycleId, report.cycleId);
  assert.deepEqual(
    snap.upcoming.items.map((q) => [q.origin, q.status]),
    [
      ['issue:7101', 'waiting'],
      ['issue:7102', 'waiting'],
    ],
  );
  system.store.close();
});

test('a priority override holds after the next pulse and after a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const dbPath = join(dir, 'db.sqlite');
  const cfg = () =>
    loadConfig({
      labelPrefix: '',
      dbPath,
      dispatcher: 'rule',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 3,
      // Paused → zero headroom → everything waits below the cut, so the test
      // never spawns an agent or touches a git worktree.
      startPaused: true,
      // Pinned off, as in this file's other config: they default on, and each
      // would add a queue item in front of the two pickups under test.
      planning: { enabled: false } as never,
      assessment: { enabled: false } as never,
      assay: { enabled: false } as never,
      retrospective: { enabled: false } as never,
    });

  const system = buildSystem(cfg(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  system.connector.inject({ kind: 'new_issue', number: 8101, title: 'A' });
  system.connector.inject({ kind: 'new_issue', number: 8102, title: 'B' });
  await system.harness.runCycle('manual');
  // Natural order is by issue number: 8101 then 8102.
  let snap = await buildStateSnapshot(system);
  assert.deepEqual(
    snap.upcoming!.items.map((q) => q.origin),
    ['issue:8101', 'issue:8102'],
  );

  // Operator says "do #8102 next".
  system.store.setPriorityOverrides(['issue:8102']);
  await system.harness.runCycle('manual');
  snap = await buildStateSnapshot(system);
  assert.deepEqual(
    snap.upcoming!.items.map((q) => q.origin),
    ['issue:8102', 'issue:8101'],
    'the override holds after the pulse',
  );
  system.store.close();

  // Restart: a fresh system on the same DB file (the fake world survives too).
  const restarted = buildSystem(cfg(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  await restarted.harness.runCycle('manual');
  snap = await buildStateSnapshot(restarted);
  assert.deepEqual(
    snap.upcoming!.items.map((q) => q.origin),
    ['issue:8102', 'issue:8101'],
    'the override survives a restart',
  );
  restarted.store.close();
});

// --------------------------------------------------------------------------
// Store: persistence, replace-all semantics, and stale-override pruning.
// --------------------------------------------------------------------------

test('setPriorityOverrides replaces the whole set and ranks by position', () => {
  const store = new Store(':memory:');
  store.setPriorityOverrides(['issue:1', 'pr:2:ci', 'issue:3']);
  assert.deepEqual(store.listPriorityOverrides(), [
    { origin: 'issue:1', rank: 0 },
    { origin: 'pr:2:ci', rank: 1 },
    { origin: 'issue:3', rank: 2 },
  ]);
  // Replace-all: a re-order that drops an origin clears its override.
  store.setPriorityOverrides(['issue:3']);
  assert.deepEqual(store.listPriorityOverrides(), [{ origin: 'issue:3', rank: 0 }]);
  // An empty list clears every override.
  store.setPriorityOverrides([]);
  assert.deepEqual(store.listPriorityOverrides(), []);
  store.close();
});

test('a stale override is pruned once its origin stops being tracked', () => {
  let t = Date.parse('2026-07-01T00:00:00Z');
  const store = new Store(':memory:', () => new Date(t).toISOString());
  store.setPriorityOverrides(['issue:1', 'issue:2']);

  // Both tracked this pulse — nothing pruned.
  store.reconcilePriorityOverrides(['issue:1', 'issue:2'], 1000);
  t += 500;
  // #1 stops being tracked, but only 500ms < the 1000ms TTL: it survives.
  store.reconcilePriorityOverrides(['issue:2'], 1000);
  assert.deepEqual(
    store.listPriorityOverrides().map((o) => o.origin),
    ['issue:1', 'issue:2'],
  );

  t += 2000;
  // #1 now untracked for 2500ms > TTL → pruned; #2 refreshed → kept.
  store.reconcilePriorityOverrides(['issue:2'], 1000);
  assert.deepEqual(
    store.listPriorityOverrides().map((o) => o.origin),
    ['issue:2'],
  );
  store.close();
});

test('a zero TTL disables pruning entirely', () => {
  let t = Date.parse('2026-07-01T00:00:00Z');
  const store = new Store(':memory:', () => new Date(t).toISOString());
  store.setPriorityOverrides(['issue:1']);
  t += 10_000_000;
  store.reconcilePriorityOverrides([], 0);
  assert.deepEqual(
    store.listPriorityOverrides().map((o) => o.origin),
    ['issue:1'],
    'nothing is pruned when the TTL is disabled',
  );
  store.close();
});
