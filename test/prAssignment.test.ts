import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prAttentionStatus, type PrAttentionContext } from '../src/prAttention.js';
import { DEFAULT_COOLDOWN } from '../src/dispatcher/dispatchCooldown.js';
import { buildNeedsYou } from '../web/src/view/needsYou.js';
import type { AppState } from '../web/src/types.js';
import type { PullRequest, Task, TaskSummary } from '../src/types.js';

const { buildDemoState: buildDemoSeed } = await import('../web/src/demo/fixtures.js');

const NOW = '2026-07-26T12:00:00.000Z';

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'p7',
    number: 7,
    title: 'Add the widget',
    branch: 'feat/widget',
    ciStatus: 'passing',
    unresolvedComments: [],
    ...over,
  };
}

function ctx(over: Partial<PrAttentionContext> = {}): PrAttentionContext {
  return {
    openPrs: [],
    defaultBranch: 'main',
    watchLabel: '',
    tasks: [],
    proposals: [],
    recentDecisions: [],
    cooldown: DEFAULT_COOLDOWN,
    ci: { checks: [] },
    now: NOW,
    ...over,
  };
}

function task(over: Partial<Task> = {}): TaskSummary {
  return {
    id: 't1',
    kind: 'code',
    title: 'Work PR #7',
    status: 'running',
    branch: 'feat/widget',
    originRef: 'pr:7',
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as TaskSummary;
}

test('a pull request nobody tagged is still yours once somebody assigns it to you', () => {
  const watched = ctx({ watchLabel: 'lubbdubb-watch' });
  const plain = prAttentionStatus(pr(), watched);
  assert.equal(plain.status, 'unwatched');
  assert.equal(plain.assignedToYou, undefined);

  const mine = prAttentionStatus(pr({ viewerAssignment: 'assignee' }), watched);
  assert.equal(mine.status, 'you');
  assert.equal(mine.assignedToYou, 'assignee');
  // The assignment leads, and the watch tag's absence survives as the reason
  // nothing else is coming — an operator who reads only the first line still
  // knows what to do, and one who reads both knows why the fleet is silent.
  assert.equal(mine.reasons[0], 'assigned to you');
  assert.match(mine.reasons[1] ?? '', /not tagged/);
});

test('"waiting on review" is not the answer when the reviewer it means is you', () => {
  // Green, unapproved, nothing staffed: the `elsewhere` tail, which on an
  // unassigned PR is somebody else's obligation and on this one is the operator's.
  const theirs = prAttentionStatus(pr(), ctx());
  assert.equal(theirs.status, 'elsewhere');
  assert.deepEqual(theirs.reasons, ['waiting on review']);

  const mine = prAttentionStatus(pr({ viewerAssignment: 'reviewer-required' }), ctx());
  assert.equal(mine.status, 'you');
  assert.equal(mine.assignedToYou, 'reviewer-required');
  assert.deepEqual(mine.reasons, ['you are a required reviewer', 'waiting on review']);
});

test('an optional reviewer is told which of the two they are', () => {
  const verdict = prAttentionStatus(pr({ viewerAssignment: 'reviewer-optional' }), ctx());
  assert.deepEqual(verdict.reasons, ['you are an optional reviewer', 'waiting on review']);
});

test('an agent on the branch keeps the court, and the assignment rides as a reason', () => {
  const verdict = prAttentionStatus(pr({ viewerAssignment: 'assignee' }), ctx({ tasks: [task()] }));
  assert.equal(verdict.status, 'harness');
  // Not a row: raising one would ask the operator to do what an agent is doing.
  assert.equal(verdict.assignedToYou, undefined);
  assert.deepEqual(verdict.reasons, ['an agent is working this branch', 'assigned to you']);
});

test('a merged pull request assigned to you says nothing about the assignment', () => {
  const verdict = prAttentionStatus(pr({ viewerAssignment: 'assignee', merged: true, state: 'merged' }), ctx());
  assert.equal(verdict.status, 'done');
  assert.deepEqual(verdict.reasons, ['merged']);
  assert.equal(verdict.assignedToYou, undefined);
});

/** The demo snapshot, with its pull requests replaced by the ones a test names. */
function stateWithPrs(prs: AppState['world']['pullRequests']): AppState {
  const base = buildDemoSeed().state;
  const world = {
    ...base.world,
    issues: base.world.issues.map((i) => ({ ...i, appraisal: null })),
    pullRequests: prs,
  };
  return { ...base, world, escalations: [], humanTasks: [], proposals: [], recovery: [], decisions: [] };
}

test('an assigned pull request becomes a queue row, and a staffed one does not', () => {
  const base = buildDemoSeed().state;
  const sample = base.world.pullRequests[0];
  assert.ok(sample, 'the demo fixtures must carry a pull request');

  const assigned = {
    ...sample,
    number: 9101,
    attention: {
      status: 'you' as const,
      reasons: ['assigned to you', 'waiting on review'],
      assignedToYou: 'assignee' as const,
    },
  };
  const staffed = {
    ...sample,
    number: 9102,
    attention: { status: 'harness' as const, reasons: ['an agent is working this branch', 'assigned to you'] },
  };

  const rows = buildNeedsYou(stateWithPrs([assigned, staffed]));
  const mine = rows.filter((r) => r.kind === 'assigned');
  assert.equal(mine.length, 1);
  assert.equal(mine[0]?.id, 'assigned:pr:9101');
  assert.equal(mine[0]?.group, 'yours');
  assert.equal(mine[0]?.originRef, 'pr:9101');
  assert.match(mine[0]?.title ?? '', /assigned to you/);
  // No instant exists for "since when", and inventing one draws a fresh age on
  // every poll.
  assert.equal(mine[0]?.raisedAt, '');
});
