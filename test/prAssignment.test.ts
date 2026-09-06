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
  assert.equal(mine.reasons[0], 'assigned to you');
  assert.match(mine.reasons[1] ?? '', /not tagged/);
});

test('the clause names the person who asked, and reads without one when nobody is reported', () => {
  const named = (over: Partial<PullRequest>) => prAttentionStatus(pr(over), ctx()).reasons[0];

  assert.equal(named({ viewerAssignment: 'reviewer-optional' }), 'you have been marked as a reviewer');
  assert.equal(
    named({ viewerAssignment: 'reviewer-optional', author: 'Priya Raman' }),
    'Priya Raman marked you as a reviewer',
  );
  assert.equal(
    named({ viewerAssignment: 'reviewer-required', author: 'Priya Raman' }),
    'Priya Raman marked you as a reviewer',
  );
  assert.equal(
    named({ viewerAssignment: 'assignee', author: 'Priya Raman' }),
    'Priya Raman assigned this pull request to you',
  );
  assert.equal(named({ viewerAssignment: 'assignee', author: '  ' }), 'assigned to you');
});

test("your own approval ends the assignment, and the provider's silence does not", () => {
  const asked = pr({ viewerAssignment: 'reviewer-required', author: 'Priya Raman' });

  const open = prAttentionStatus(asked, ctx());
  assert.equal(open.assignedToYou, 'reviewer-required');

  const answered = prAttentionStatus({ ...asked, viewerApproved: true }, ctx());
  assert.equal(answered.status, 'elsewhere');
  assert.equal(answered.assignedToYou, undefined);
  assert.deepEqual(answered.reasons, [
    'waiting on review',
    'Priya Raman marked you as a reviewer — you have approved it',
  ]);

  const theirs = prAttentionStatus({ ...asked, approved: true }, ctx());
  assert.equal(theirs.assignedToYou, 'reviewer-required');
});

test('"waiting on review" is not the answer when the reviewer it means is you', () => {
  const theirs = prAttentionStatus(pr(), ctx());
  assert.equal(theirs.status, 'elsewhere');
  assert.deepEqual(theirs.reasons, ['waiting on review']);

  const mine = prAttentionStatus(pr({ viewerAssignment: 'reviewer-required' }), ctx());
  assert.equal(mine.status, 'you');
  assert.equal(mine.assignedToYou, 'reviewer-required');
  assert.deepEqual(mine.reasons, ['you have been marked as a reviewer', 'waiting on review']);
});

test('an optional reviewer is told which of the two they are', () => {
  const verdict = prAttentionStatus(pr({ viewerAssignment: 'reviewer-optional' }), ctx());
  assert.equal(verdict.assignedToYou, 'reviewer-optional');
  assert.deepEqual(verdict.reasons, ['you have been marked as a reviewer', 'waiting on review']);
});

test('an assigned pull request says how long it has been waiting on you', () => {
  const WAITING_SINCE = '2026-07-20T09:00:00.000Z';
  const waits = new Map([[7, WAITING_SINCE]]);

  const reviewing = prAttentionStatus(pr({ viewerAssignment: 'reviewer-required' }), ctx({ reviewWaits: waits }));
  assert.equal(reviewing.reviewWaitingSince, WAITING_SINCE);

  const untagged = prAttentionStatus(
    pr({ viewerAssignment: 'reviewer-required' }),
    ctx({ watchLabel: 'lubbdubb-watch', reviewWaits: waits }),
  );
  assert.equal(untagged.status, 'you');
  assert.equal(untagged.reviewWaitingSince, WAITING_SINCE);

  const theirs = prAttentionStatus(pr(), ctx({ watchLabel: 'lubbdubb-watch', reviewWaits: waits }));
  assert.equal(theirs.reviewWaitingSince, undefined);

  const notReady = prAttentionStatus(pr({ viewerAssignment: 'reviewer-required' }), ctx());
  assert.equal(notReady.reviewWaitingSince, undefined);
});

test('an agent on the branch keeps the court, and the assignment rides as a reason', () => {
  const verdict = prAttentionStatus(pr({ viewerAssignment: 'assignee' }), ctx({ tasks: [task()] }));
  assert.equal(verdict.status, 'harness');
  assert.equal(verdict.assignedToYou, undefined);
  assert.deepEqual(verdict.reasons, ['an agent is working this branch', 'assigned to you']);
});

test('a merged pull request assigned to you says nothing about the assignment', () => {
  const verdict = prAttentionStatus(pr({ viewerAssignment: 'assignee', merged: true, state: 'merged' }), ctx());
  assert.equal(verdict.status, 'done');
  assert.deepEqual(verdict.reasons, ['merged']);
  assert.equal(verdict.assignedToYou, undefined);
});

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
    title: 'Retry the reconciliation sweep on a 429',
    attention: {
      status: 'you' as const,
      reasons: ['Priya Raman marked you as a reviewer', 'waiting on review'],
      assignedToYou: 'reviewer-optional' as const,
      reviewWaitingSince: '2026-07-20T09:00:00.000Z',
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
  assert.match(
    mine[0]?.title ?? '',
    /^Priya Raman marked you as a reviewer on “Retry the reconciliation sweep on a 429”/,
  );
  assert.doesNotMatch(mine[0]?.title ?? '', /waiting on review/);
  assert.equal(mine[0]?.note, 'Optional reviewer');
  assert.equal(mine[0]?.raisedAt, '2026-07-20T09:00:00.000Z');
});

test('an assigned row opens the pull request on the provider, and carries the ask as its second destination', () => {
  const base = buildDemoSeed().state;
  const sample = base.world.pullRequests[0];
  assert.ok(sample, 'the demo fixtures must carry a pull request');
  const assigned = {
    ...sample,
    number: 9101,
    attention: {
      status: 'you' as const,
      reasons: ['Priya Raman marked you as a reviewer'],
      assignedToYou: 'reviewer-optional' as const,
    },
  };

  const state = stateWithPrs([assigned]);
  const row = buildNeedsYou({ ...state, refUrls: { 'pr:9101': 'https://example.test/pull/9101' } }).find(
    (r) => r.kind === 'assigned',
  );
  assert.equal(row?.opens, 'provider', 'the body opens the pull request the person put on you, where they wrote it');
  assert.ok(row?.details !== undefined, 'and the bar carries what the body used to open');
  assert.ok(
    row?.details === 'goal' || row?.details === 'ask',
    'which is the ask read in context: the goal’s page where there is one, the ask panel otherwise',
  );

  const unaddressed = buildNeedsYou({ ...state, refUrls: {} }).find((r) => r.kind === 'assigned');
  assert.ok(
    unaddressed?.opens === 'goal' || unaddressed?.opens === 'ask',
    'with no address for the pull request the card falls back to the ask',
  );
});

test('an assigned row with no clock running draws no age', () => {
  const base = buildDemoSeed().state;
  const sample = base.world.pullRequests[0];
  assert.ok(sample, 'the demo fixtures must carry a pull request');

  const rows = buildNeedsYou(
    stateWithPrs([
      {
        ...sample,
        number: 9103,
        attention: {
          status: 'you' as const,
          reasons: ['Priya Raman marked you as a reviewer', 'CI failing'],
          assignedToYou: 'reviewer-required' as const,
        },
      },
    ]),
  );
  assert.equal(rows.find((r) => r.kind === 'assigned')?.raisedAt, '');
});
