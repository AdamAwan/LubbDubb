import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeOutPass } from '../src/delivery/closeOut.js';
import { DeliveryCloseOutDesk } from '../src/delivery/closeOutDesk.js';
import { FakeWorldStore } from '../src/integrations/fake/fakeWorld.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store/store.js';
import type { HumanTask, Issue, IssueDelivery } from '../src/types.js';

/**
 * The step after the launch: the ticket a delivered goal leaves open.
 *
 * The property to hold on to while reading these: the obligation is a **row**,
 * not a reading of the tracker. The harness may settle it because it can see the
 * item, but a decline is the operator's and no world state overrides it — so
 * every question below is asked twice, once about what the world says and once
 * about what the row already said.
 */

function delivery(number: number, over: Partial<IssueDelivery> = {}): IssueDelivery {
  return {
    originRef: `issue:${number}`,
    summary: 'the docs landed with it',
    by: 'assessor',
    agentId: null,
    taskId: null,
    decidedAt: '2026-08-11T10:00:00.000Z',
    updatedAt: '2026-08-11T10:00:00.000Z',
    ...over,
  };
}

function issue(number: number, over: Partial<Issue> = {}): Issue {
  return {
    id: `issue_${number}`,
    number,
    title: `Goal ${number}`,
    body: '',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    ...over,
  };
}

function task(over: Partial<HumanTask> = {}): HumanTask {
  return {
    id: 'hum_1',
    title: 'Close issue #12 in the tracker',
    detail: null,
    originRef: 'issue:12',
    partId: null,
    kind: 'close_out',
    agentId: null,
    taskId: null,
    status: 'open',
    resolution: null,
    createdAt: '2026-08-11T10:00:00.000Z',
    updatedAt: '2026-08-11T10:00:00.000Z',
    resolvedAt: null,
    ...over,
  };
}

const pass = (over: Partial<Parameters<typeof closeOutPass>[0]> = {}) =>
  closeOutPass({ issues: [], deliveries: [], shortfalls: [], existing: [], ...over });

// -- filing -------------------------------------------------------------------

test('a delivered goal whose ticket is still open owes a close', () => {
  const steps = pass({ issues: [issue(12, { url: 'https://tracker/12' })], deliveries: [delivery(12)] });
  assert.equal(steps.length, 1);
  const step = steps[0]!;
  assert.equal(step.kind, 'file');
  assert.equal(step.kind === 'file' && step.originRef, 'issue:12');
  // The headline is the ask, not the goal's own title: a ticket renamed under
  // the row must not read as a second thing to do.
  assert.equal(step.kind === 'file' && step.title, 'Close issue #12 in the tracker');
  assert.match(step.kind === 'file' ? step.detail : '', /https:\/\/tracker\/12/);
});

test('nothing is owed when the tracker already stopped listing it open', () => {
  // The GitHub shape: a merged "Closes #12" took the issue with it, so the world
  // never carries it and no obligation was ever raised.
  assert.deepEqual(pass({ issues: [issue(9)], deliveries: [delivery(12)] }), []);
  // The Azure shape: the work item is still reported, in a closed state.
  assert.deepEqual(pass({ issues: [issue(12, { state: 'closed' })], deliveries: [delivery(12)] }), []);
});

test('a launch the assessor sent back owes nothing', () => {
  const steps = pass({
    issues: [issue(12)],
    deliveries: [delivery(12)],
    shortfalls: [
      {
        originRef: 'issue:12',
        cause: 'part',
        partSlug: null,
        summary: 'the migration never ran',
        by: 'assessor',
        agentId: null,
        taskId: null,
        decidedAt: '2026-08-11T11:00:00.000Z',
        updatedAt: '2026-08-11T11:00:00.000Z',
      },
    ],
  });
  assert.deepEqual(steps, []);
});

test('a pass over a world it has already acted on files nothing', () => {
  const steps = pass({ issues: [issue(12)], deliveries: [delivery(12)], existing: [task()] });
  assert.deepEqual(steps, []);
});

test('a settled row is never re-filed — a decline stays declined', () => {
  for (const status of ['done', 'declined'] as const) {
    const steps = pass({
      issues: [issue(12)],
      deliveries: [delivery(12)],
      existing: [task({ status, resolution: 'it stays open until the release goes out' })],
    });
    assert.deepEqual(steps, [], `${status} is a settlement, and the sweep does not re-open it`);
  }
});

// -- settling -----------------------------------------------------------------

test('the tracker closing the item settles the obligation, both ways it can look', () => {
  const closed = pass({ issues: [issue(12, { state: 'closed' })], deliveries: [delivery(12)], existing: [task()] });
  assert.deepEqual(closed, [
    { kind: 'settle', taskId: 'hum_1', status: 'done', resolution: 'the tracker shows it closed' },
  ]);

  // Gone from the open set is the same fact on a provider that reports open
  // issues only — and the note says what was observed rather than who did it.
  const gone = pass({ issues: [issue(9)], deliveries: [delivery(12)], existing: [task()] });
  assert.deepEqual(gone, [
    { kind: 'settle', taskId: 'hum_1', status: 'done', resolution: 'the tracker no longer lists it open' },
  ]);
});

test('an empty world settles nothing — a provider that read nothing is not a tracker that closed everything', () => {
  assert.deepEqual(pass({ issues: [], deliveries: [delivery(12)], existing: [task()] }), []);
});

test('clearing the delivery retracts the obligation rather than leaving it standing', () => {
  const steps = pass({ issues: [issue(12)], deliveries: [], existing: [task()] });
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.kind === 'settle' && steps[0]!.status, 'declined');
  // Declined rather than deleted, for the reason an amended plan declines the
  // human part it dropped: the row is the account of why it stopped being owed.
  assert.match(steps[0]!.kind === 'settle' ? steps[0]!.resolution : '', /back into production/);
});

// -- through the harness ------------------------------------------------------

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-closeout-'));
  return buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 0,
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
    },
  );
}

test('a pulse files the close-out, and the next one settles it once the ticket goes', async () => {
  const system = build();
  const world = new FakeWorldStore(system.store);
  world.mutate((w) => {
    // Two, so the world is never empty: a provider that read *nothing* is the one
    // case the gone-arm refuses to act on, and it must not be what this proves.
    w.issues.push(issue(12, { title: 'Ship the thing' }), issue(13));
  });
  system.store.recordDelivery({ originRef: 'issue:12', summary: 'PR #40 landed it', by: 'assessor' });

  await system.harness.runCycle('manual');
  const filed = system.store.listHumanTasksOfKind('close_out');
  assert.equal(filed.length, 1);
  assert.equal(filed[0]!.status, 'open');
  assert.equal(filed[0]!.originRef, 'issue:12');
  // Nobody asked for it — not an agent, not an operator. That null is the whole
  // of what "the harness filed this" means on the row.
  assert.equal(filed[0]!.agentId, null);
  // It blocks nothing: no part backs it.
  assert.equal(filed[0]!.partId, null);

  // A second pulse against the same world adds nothing and touches nothing.
  await system.harness.runCycle('manual');
  assert.deepEqual(
    system.store.listHumanTasksOfKind('close_out').map((t) => t.id),
    [filed[0]!.id],
  );
  assert.equal(system.store.getHumanTask(filed[0]!.id)!.updatedAt, filed[0]!.updatedAt);

  // Someone closes it in the tracker, and GitHub's issues provider stops
  // reporting it at all.
  world.mutate((w) => {
    w.issues = w.issues.filter((i) => i.number !== 12);
  });
  await system.harness.runCycle('manual');
  const settled = system.store.getHumanTask(filed[0]!.id)!;
  assert.equal(settled.status, 'done');
  assert.match(settled.resolution ?? '', /no longer lists it open/);
});

test('a database written before the sweep existed reads its rows as asks', () => {
  const store = new Store(':memory:');
  const { task: ask } = store.recordHumanTask({
    title: 'Rotate the deploy key',
    detail: null,
    originRef: 'issue:12',
    agentId: 'agent-1',
    taskId: 'task-1',
  });
  assert.equal(ask.kind, 'ask');
  // And the kind is what the sweep keys on, so an ask on the same origin is
  // neither found nor settled by it.
  assert.deepEqual(store.listHumanTasksOfKind('close_out'), []);
  new DeliveryCloseOutDesk(store).run({ issues: [] });
  assert.equal(store.getHumanTask(ask.id)!.status, 'open');
});
