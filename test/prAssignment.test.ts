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

test('the clause names the person who asked, and reads without one when nobody is reported', () => {
  const named = (over: Partial<PullRequest>) => prAttentionStatus(pr(over), ctx()).reasons[0];

  assert.equal(named({ viewerAssignment: 'reviewer-optional' }), 'you have been marked as a reviewer');
  assert.equal(
    named({ viewerAssignment: 'reviewer-optional', author: 'Priya Raman' }),
    'Priya Raman marked you as a reviewer',
  );
  // Required and optional say the same sentence on purpose: the distinction is
  // `assignedToYou`, a field, so no rewording can silently drop it.
  assert.equal(
    named({ viewerAssignment: 'reviewer-required', author: 'Priya Raman' }),
    'Priya Raman marked you as a reviewer',
  );
  assert.equal(
    named({ viewerAssignment: 'assignee', author: 'Priya Raman' }),
    'Priya Raman assigned this pull request to you',
  );
  // Whitespace is not a name: an author the provider padded rather than reported
  // must not put a sentence with a hole in it on the rail.
  assert.equal(named({ viewerAssignment: 'assignee', author: '  ' }), 'assigned to you');
});

test("your own approval ends the assignment, and the provider's silence does not", () => {
  const asked = pr({ viewerAssignment: 'reviewer-required', author: 'Priya Raman' });

  const open = prAttentionStatus(asked, ctx());
  assert.equal(open.assignedToYou, 'reviewer-required');

  const answered = prAttentionStatus({ ...asked, viewerApproved: true }, ctx());
  // Demoted to a reason, exactly as an agent on the branch demotes it: the court
  // is the arm's own again and no row is raised.
  assert.equal(answered.status, 'elsewhere');
  assert.equal(answered.assignedToYou, undefined);
  assert.deepEqual(answered.reasons, [
    'waiting on review',
    'Priya Raman marked you as a reviewer — you have approved it',
  ]);

  // Somebody *else* approving is not an answer to the review this operator was
  // asked for, and neither is a provider that reports no vote at all.
  const theirs = prAttentionStatus({ ...asked, approved: true }, ctx());
  assert.equal(theirs.assignedToYou, 'reviewer-required');
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
  assert.deepEqual(mine.reasons, ['you have been marked as a reviewer', 'waiting on review']);
});

test('an optional reviewer is told which of the two they are', () => {
  const verdict = prAttentionStatus(pr({ viewerAssignment: 'reviewer-optional' }), ctx());
  // Not in the sentence — in the field, which is what the rail draws it from.
  assert.equal(verdict.assignedToYou, 'reviewer-optional');
  assert.deepEqual(verdict.reasons, ['you have been marked as a reviewer', 'waiting on review']);
});

test('an assigned pull request says how long it has been waiting on you', () => {
  const WAITING_SINCE = '2026-07-20T09:00:00.000Z';
  const waits = new Map([[7, WAITING_SINCE]]);

  // The arm that already carried the age: `waiting on review`, about the operator
  // now rather than about somebody else.
  const reviewing = prAttentionStatus(pr({ viewerAssignment: 'reviewer-required' }), ctx({ reviewWaits: waits }));
  assert.equal(reviewing.reviewWaitingSince, WAITING_SINCE);

  // The one the rail shows most, and the one that carried no age at all: an
  // assigned pull request nobody tagged never reaches the `waiting on review` arm.
  const untagged = prAttentionStatus(
    pr({ viewerAssignment: 'reviewer-required' }),
    ctx({ watchLabel: 'lubbdubb-watch', reviewWaits: waits }),
  );
  assert.equal(untagged.status, 'you');
  assert.equal(untagged.reviewWaitingSince, WAITING_SINCE);

  // Unassigned, the same untagged pull request is nobody's wait to draw: the arm
  // is `unwatched` and the clock is about a reviewer who is not the operator.
  const theirs = prAttentionStatus(pr(), ctx({ watchLabel: 'lubbdubb-watch', reviewWaits: waits }));
  assert.equal(theirs.reviewWaitingSince, undefined);

  // A clock that is not running draws no age — a reviewer cannot be late for work
  // that is not ready, and the watermark is deleted the moment it stops waiting.
  const notReady = prAttentionStatus(pr({ viewerAssignment: 'reviewer-required' }), ctx());
  assert.equal(notReady.reviewWaitingSince, undefined);
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
  // Who asked, and what about — and not the arm's own reason, which on this row
  // is either the operator's own obligation said back to them or the fleet's
  // silence explained. Both still stand on the pull request row.
  assert.match(
    mine[0]?.title ?? '',
    /^Priya Raman marked you as a reviewer on “Retry the reconciliation sweep on a 429”/,
  );
  assert.doesNotMatch(mine[0]?.title ?? '', /waiting on review/);
  // Which kind of reviewer is the metadata line's, off the field.
  assert.equal(mine[0]?.note, 'Optional reviewer');
  // How long it has been waiting on the operator — the review-wait watermark, not
  // an invented "when it became yours", which no provider reports and which
  // stamping "now" for would refresh on every poll.
  assert.equal(mine[0]?.raisedAt, '2026-07-20T09:00:00.000Z');
});

/**
 * **The card goes to the pull request; the ask is the control beside it.** The row
 * carried a `<Ref>` to the PR beside a body that opened a summary of it, which put
 * a stop on the road between the operator and the one thing a colleague is waiting
 * on. Both destinations are decided here rather than in the rail, for
 * `NeedDestination`'s reason: only the derivation can tell a ref that has a page
 * from one that merely looks like it does.
 * → docs/spec/17-cockpit.md#the-queue-rail--needs-you
 */
test('an assigned row opens the pull request, and carries the ask as its second destination', () => {
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

  const row = buildNeedsYou(stateWithPrs([assigned])).find((r) => r.kind === 'assigned');
  assert.equal(row?.opens, 'pr', 'the body opens the pull request the person put on you');
  assert.ok(row?.details !== undefined, 'and the bar carries what the body used to open');
  assert.ok(
    row?.details === 'goal' || row?.details === 'ask',
    'which is the ask read in context: the goal’s page where there is one, the ask panel otherwise',
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
