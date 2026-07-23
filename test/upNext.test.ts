import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import type { WorldSnapshot } from '../src/types.js';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { buildStateSnapshot } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';

// The "Up next" queue (issue #69): the dispatcher's ordered pickup plan with the
// headroom cut — above-cut candidates dispatch this cycle, below-cut ones wait
// for a free slot, and neither changes which actions are emitted.

function ctx(world: Partial<WorldSnapshot>, over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: 'now', pullRequests: [], issues: [], stories: [], calendar: [], ...world },
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
      ['pr:1:comment:c1', 'waiting'],
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

test('the rule-8 story pickup appears below the cut instead of vanishing', async () => {
  const d = new RuleDispatcher();
  const result = await d.decide(
    ctx(
      {
        issues: [issue(9)],
        stories: [
          {
            id: 'hi',
            title: 'High',
            description: 'd',
            acceptanceCriteria: 'ac',
            wafPillars: ['x'],
            state: 'ready',
            priority: 9,
          },
        ],
      },
      { agentHeadroom: 1 },
    ),
  );
  // Headroom 1: the issue takes the slot; the story pickup queues behind it
  // (today it is silently dropped once headroom hits zero).
  assert.deepEqual(
    result.upcoming?.map((q) => [q.origin, q.status]),
    [
      ['issue:9', 'dispatching'],
      ['story:hi:work', 'waiting'],
    ],
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
// Snapshot plumbing: the harness caches the last cycle's plan for /api/state
// --------------------------------------------------------------------------

function testConfig(over: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    dbPath: ':memory:',
    dispatcher: 'rule',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    ...over,
  });
}

test('buildStateSnapshot ships the last cycle plan as upcoming', async () => {
  // Paused → zero headroom → the whole plan sits below the cut, and nothing
  // dispatches (so the test never touches git worktrees).
  const system = buildSystem(testConfig({ startPaused: true }), { backend: new FakePtyBackend() });
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
