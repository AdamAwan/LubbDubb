import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import { expeditedOrigins } from '../src/dispatcher/goalPriority.js';
import type { Issue, Plan, PlanPart, PullRequest, WorldSnapshot } from '../src/types.js';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { pastTheFunnel } from './support/plans.js';

// Marking a goal a priority: everything the harness dispatches under it ranks
// ahead of the natural cross-rule order, and nothing about what may run changes.

function ctx(world: Partial<WorldSnapshot>, over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: 'now', pullRequests: [], issues: [], ...world },
    plans: [],
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    // The funnel has failed open on every issue in these worlds, as in upNext.test.ts.
    recentDecisions: (world.issues ?? []).flatMap((i) => pastTheFunnel(i.number)),
    agentHeadroom: 3,
    ...over,
  };
}

const issue = (number: number, over: Partial<Issue> = {}): Issue => ({
  id: `i${number}`,
  number,
  title: `Issue ${number}`,
  body: 'b',
  labels: [],
  state: 'open',
  linkedPrNumber: null,
  ...over,
});

const pr = (number: number, branch: string, over: Partial<PullRequest> = {}): PullRequest => ({
  id: `p${number}`,
  number,
  title: `PR ${number}`,
  branch,
  ciStatus: 'failing',
  unresolvedComments: [],
  ...over,
});

// -- the expansion -----------------------------------------------------------

const emptyWorld = { openPrs: [], issues: [], plans: [], parts: [] };

test('a flagged goal covers its whole origin subtree', () => {
  const covers = expeditedOrigins([{ originRef: 'issue:12', since: 'now' }], emptyWorld);
  for (const origin of [
    'issue:12',
    'issue:12:plan',
    'issue:12:assay',
    'issue:12:assess',
    'issue:12:retro',
    'issue:12:part:signer',
    'issue:12:validate:login',
  ])
    assert.equal(covers(origin), true, `${origin} is this goal's work`);
});

test('the subtree stops at the goal it names', () => {
  // A bare `startsWith('issue:1')` matches `issue:19:plan`, which would hand
  // another goal's whole funnel the priority — the reason this asks
  // `issueOriginRole` rather than testing a prefix.
  const covers = expeditedOrigins([{ originRef: 'issue:1', since: 'now' }], emptyWorld);
  assert.equal(covers('issue:19'), false);
  assert.equal(covers('issue:19:plan'), false);
  assert.equal(covers('issue:1:part:a'), true);
});

test('an unflagged goal, a job and a ticketless PR all answer false', () => {
  const covers = expeditedOrigins([{ originRef: 'issue:12', since: 'now' }], emptyWorld);
  assert.equal(covers('issue:13'), false);
  assert.equal(covers('job:abc'), false);
  assert.equal(covers('pr:99:ci'), false);
});

test('the pull requests a flagged goal opened are covered, by all three readings', () => {
  const covers = expeditedOrigins([{ originRef: 'issue:12', since: 'now' }], {
    openPrs: [
      pr(50, 'issue/12'), // the pickup branch
      pr(51, 'issue/12/signer'), // a part's branch
      pr(52, 'issue/120'), // a different goal whose number starts the same
      pr(53, 'hand-cut'), // linked to the issue but off-convention
      pr(54, 'also-hand-cut'), // a part's own explicit branch
    ],
    issues: [issue(12, { linkedPrNumber: 53 })],
    plans: [{ id: 'pl1', originRef: 'issue:12' } as Plan],
    parts: [{ planId: 'pl1', slug: 'signer', prNumber: 54 } as PlanPart],
  });
  assert.equal(covers('pr:50:ci'), true);
  assert.equal(covers('pr:51:comments'), true);
  assert.equal(covers('pr:52:ci'), false, 'issue/120 is goal 120, not goal 12');
  assert.equal(covers('pr:53:ci'), true, 'the linked PR counts however its branch is named');
  assert.equal(covers('pr:54:ci-gate'), true, "a part's own PR counts off the part row");
});

test('a part of an unflagged plan is not covered by another goal being flagged', () => {
  const covers = expeditedOrigins([{ originRef: 'issue:12', since: 'now' }], {
    openPrs: [pr(60, 'hand-cut')],
    issues: [],
    plans: [{ id: 'pl2', originRef: 'issue:13' } as Plan],
    parts: [{ planId: 'pl2', slug: 'other', prNumber: 60 } as PlanPart],
  });
  assert.equal(covers('pr:60:ci'), false);
});

// -- the ranking -------------------------------------------------------------

test("a flagged goal's pickup jumps the natural cross-rule order", async () => {
  const d = new RuleDispatcher();
  // A red build outranks an issue pickup by pipeline position, so without the flag
  // `pr:1:ci` takes the only slot.
  const world = { pullRequests: [pr(1, 'unrelated')], issues: [issue(101)] };
  const natural = await d.decide(ctx(world, { agentHeadroom: 1 }));
  assert.deepEqual(
    natural.upcoming?.map((q) => q.origin),
    ['pr:1:ci', 'issue:101'],
  );

  const flagged = await d.decide(
    ctx(world, { agentHeadroom: 1, goalPriorities: [{ originRef: 'issue:101', since: 'now' }] }),
  );
  assert.deepEqual(
    flagged.upcoming?.map((q) => [q.origin, q.status]),
    [
      ['issue:101', 'dispatching'],
      ['pr:1:ci', 'waiting'],
    ],
    'the flagged goal takes the slot the red build would have had',
  );
  assert.equal(flagged.upcoming?.[0]?.expedited, true, 'and the row says why it is first');
  assert.equal(flagged.upcoming?.[1]?.expedited, undefined, 'while an unflagged row keeps its old shape');
});

test("a flagged goal's pull request is lifted with it", async () => {
  // The half a per-origin drag cannot express: the goal's own pickup is not queued
  // at all here — its PR is open — and the thing between it and the line is a red
  // build on an origin that never names the goal.
  const d = new RuleDispatcher();
  const result = await d.decide(
    ctx(
      { pullRequests: [pr(7, 'other'), pr(8, 'issue/55')], issues: [issue(55, { linkedPrNumber: 8 })] },
      { agentHeadroom: 1, goalPriorities: [{ originRef: 'issue:55', since: 'now' }] },
    ),
  );
  assert.deepEqual(
    result.upcoming?.map((q) => [q.origin, q.status]),
    [
      ['pr:8:ci', 'dispatching'],
      ['pr:7:ci', 'waiting'],
    ],
  );
});

test('a manual job still takes the next free slot ahead of a flagged goal', async () => {
  const d = new RuleDispatcher();
  const result = await d.decide(
    ctx(
      { issues: [issue(101)] },
      {
        agentHeadroom: 1,
        goalPriorities: [{ originRef: 'issue:101', since: 'now' }],
        queuedJobs: [
          {
            id: 'j1',
            title: 'Manual',
            prompt: 'do it',
            kind: 'code',
            status: 'queued',
            originRef: null,
            branch: null,
            taskId: null,
            createdAt: 'now',
            updatedAt: 'now',
          } as never,
        ],
      },
    ),
  );
  assert.equal(result.upcoming?.[0]?.rule, 'manual-job', 'a manual request is distinct work, not a re-prioritisation');
});

test('a flagged goal is still held by its cooldown', async () => {
  // The whole contract of the flag: it orders, and it un-holds nothing.
  const d = new RuleDispatcher();
  const result = await d.decide(
    ctx(
      { takenAt: '2026-07-21T00:00:30Z', issues: [issue(9)] },
      {
        goalPriorities: [{ originRef: 'issue:9', since: 'now' }],
        recentDecisions: [
          ...pastTheFunnel(9),
          {
            id: 'd1',
            cycleId: 'c',
            outcome: 'executed',
            detail: '',
            rule: null,
            admission: null,
            createdAt: '2026-07-21T00:00:00Z',
            action: { type: 'dispatch_code_agent', reason: 'r', originRef: 'issue:9' },
          },
        ],
      },
    ),
  );
  assert.deepEqual(
    result.upcoming?.map((q) => [q.origin, q.status]),
    [['issue:9', 'cooldown']],
    'flagged, first in the queue, and going nowhere until the cooldown lapses',
  );
  assert.ok(!result.actions.some((a) => a.type.startsWith('dispatch_')));
});

// -- the store and the route -------------------------------------------------

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-prio-'));
  return buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
}

test('the route flags a goal, clears it, and is idempotent both ways', async () => {
  const system = build();
  const { app } = await buildApp(system);
  try {
    const on = await app.inject({ method: 'POST', url: '/api/issues/4/priority', payload: { priority: true } });
    assert.equal(on.statusCode, 200);
    const [first] = system.store.listGoalPriorities();
    assert.equal(first?.originRef, 'issue:4');

    await app.inject({ method: 'POST', url: '/api/issues/4/priority', payload: { priority: true } });
    const [again] = system.store.listGoalPriorities();
    assert.equal(system.store.listGoalPriorities().length, 1, 'one row, however many times the button is clicked');
    assert.equal(again?.since, first?.since, 'and it still records when the operator decided');

    await app.inject({ method: 'POST', url: '/api/issues/4/priority', payload: { priority: false } });
    assert.deepEqual(system.store.listGoalPriorities(), []);
    await app.inject({ method: 'POST', url: '/api/issues/4/priority', payload: { priority: false } });
    assert.deepEqual(system.store.listGoalPriorities(), [], 'clearing what is already clear is not an error');

    const bad = await app.inject({ method: 'POST', url: '/api/issues/4/priority', payload: {} });
    assert.equal(bad.statusCode, 400, 'a body that names nothing asks for nothing');
  } finally {
    await app.close();
    system.store.close();
  }
});

test('a flag survives the pulse that prunes stale queue arrangements', () => {
  // The reason this is not reconciled like `priority_overrides`: a flagged goal
  // waiting on a human queues no origin at all, which is exactly when the flag
  // has to still be there when the wait ends.
  const system = build();
  try {
    system.store.setGoalPriority('issue:4', true);
    system.store.reconcilePriorityOverrides([], 1);
    assert.equal(system.store.listGoalPriorities().length, 1, 'the pruner has nothing to say about a flag');
  } finally {
    system.store.close();
  }
});

test('the snapshot ships the flag on the goal it was set against', () => {
  const system = build();
  try {
    system.store.setGoalPriority('issue:4', true);
    system.store.setWorldBaseline({
      takenAt: '2026-08-17T00:00:00Z',
      pullRequests: [],
      issues: [issue(4), issue(5)],
    });
    const state = buildStateSnapshot(system);
    const flagged = state.world.issues.find((i) => i.number === 4);
    const plain = state.world.issues.find((i) => i.number === 5);
    assert.ok(flagged?.priority, 'the chip has something to draw');
    assert.equal(plain?.priority, null, 'and every other goal reads as not flagged');
  } finally {
    system.store.close();
  }
});
