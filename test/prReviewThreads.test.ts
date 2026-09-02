import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { DEFAULT_PLANNING } from '../src/plans/planning.js';
import { applyThreadReopens, threadComments } from '../src/prThreads.js';
import { buildReviewThreads } from '../src/integrations/github/sourceControl.js';
import type { GhReviewComment, GhReviewThread } from '../src/integrations/github/githubApi.js';
import type { PrReviewThread, PullRequest, WorldSnapshot } from '../src/types.js';

/**
 * Review threads, and the one thing an operator can do to one.
 *
 * The property the whole subsystem rests on: **the threads are the reading and
 * the comment list is a fold of them**. Every rule dispatches off
 * `unresolvedComments`, so a thread the cockpit draws as open and a comment list
 * that says it is handled would be a review the operator can see and the fleet
 * cannot. The provider builds one and derives the other, and the reopen moves the
 * thread — never the fold.
 * → `docs/spec/07-pull-requests.md#review-threads`
 */

function testConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-threads-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    planning: { ...DEFAULT_PLANNING },
    ...overrides,
  });
}

function build(): System {
  return buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    gitObserver: new FakeGitObserver(),
    errorMirror: () => {},
  });
}

function thread(overrides: Partial<PrReviewThread> = {}): PrReviewThread {
  return { id: 't1', author: 'bob', body: 'why this?', state: 'answered', replies: [], ...overrides };
}

function pr(threads: PrReviewThread[], overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'pr_7',
    number: 7,
    title: 'A change',
    branch: 'feature/x',
    ciStatus: 'passing',
    reviewThreads: threads,
    unresolvedComments: threadComments(threads),
    ...overrides,
  };
}

function world(prs: PullRequest[]): WorldSnapshot {
  return { takenAt: new Date().toISOString(), pullRequests: prs, closedPullRequests: [], issues: [] };
}

test('the provider keeps the conversation and where it hangs, not just the root', () => {
  const comments: GhReviewComment[] = [
    { id: 100, authorLogin: 'bob', body: 'why this?', inReplyToId: null, path: 'src/a.ts', line: 42 },
    { id: 101, authorLogin: 'lubbdubb-bot', body: 'because X', inReplyToId: 100 },
    { id: 102, authorLogin: 'bob', body: 'not convinced', inReplyToId: 100 },
  ];
  // Comment 101 is the one the harness recorded sending; 102 came back from the
  // reviewer. Attribution is that record, never the login on the message.
  const [built] = buildReviewThreads(comments, [], new Set(['101']));
  assert.equal(built!.id, '100');
  assert.equal(built!.path, 'src/a.ts');
  assert.equal(built!.line, 42);
  assert.deepEqual(
    built!.replies.map((r) => [r.author, r.ours]),
    [
      ['lubbdubb-bot', true],
      ['bob', false],
    ],
    'both replies survive, and the one the harness wrote is marked as ours',
  );
  // The reviewer spoke last, so the thread is still the fleet's to answer — the
  // same verdict the comment list carries, because it is a fold of this one.
  assert.equal(built!.state, 'open');
  assert.equal(threadComments([built!])[0]!.handled, false);
});

test('a thread the reviewer resolved is resolved, and one the fleet answered is answered', () => {
  const comments: GhReviewComment[] = [
    { id: 100, authorLogin: 'bob', body: 'rename', inReplyToId: null },
    { id: 101, authorLogin: 'lubbdubb-bot', body: 'done', inReplyToId: 100 },
    { id: 200, authorLogin: 'bob', body: 'and this', inReplyToId: null },
  ];
  const threads: GhReviewThread[] = [{ rootCommentId: 200, isResolved: true }];
  const states = Object.fromEntries(
    buildReviewThreads(comments, threads, new Set(['101'])).map((t) => [t.id, t.state]),
  );
  // Two words for what `handled` folded into one bit: the second is finished, the
  // first is waiting on a person who may yet come back.
  assert.deepEqual(states, { '100': 'answered', '200': 'resolved' });
});

test('a reopen puts the thread back to the fleet, comment list and all', () => {
  const before = world([pr([thread({ state: 'resolved' })])]);
  const after = applyThreadReopens(before, [{ prNumber: 7, threadId: 't1', reopenedAt: '2026-01-01T00:00:00.000Z' }]);
  const reopened = after.pullRequests[0]!;
  assert.equal(reopened.reviewThreads![0]!.state, 'reopened');
  assert.equal(reopened.reviewThreads![0]!.reopenedAt, '2026-01-01T00:00:00.000Z');
  // The half that makes it work: the rules read the comment list, so a reopen that
  // moved only the thread would be a mark the fleet never saw.
  assert.equal(reopened.unresolvedComments[0]!.handled, false);
  // And the reading it was laid over is untouched — it is the record of what the
  // provider said, which is what taking the ask back restores the thread to.
  assert.equal(before.pullRequests[0]!.reviewThreads![0]!.state, 'resolved');
});

test('a reopen naming a thread the reading does not carry changes nothing', () => {
  const before = world([pr([thread()])]);
  const after = applyThreadReopens(before, [{ prNumber: 7, threadId: 'gone', reopenedAt: 'now' }]);
  assert.equal(after, before, 'the same object, so nothing downstream re-renders for a mark that matched nothing');
});

test('a pull request whose provider reports no threads is left alone, never invented', () => {
  const silent = world([{ ...pr([]), reviewThreads: undefined, unresolvedComments: [] }]);
  const after = applyThreadReopens(silent, [{ prNumber: 7, threadId: 't1', reopenedAt: 'now' }]);
  assert.equal(after.pullRequests[0]!.reviewThreads, undefined);
});

test('the cockpit sees a reopen on the next read, without waiting for a pulse', async () => {
  const system = build();
  system.store.setWorldBaseline(world([pr([thread({ state: 'resolved' })])]));
  const { app } = await buildApp(system);

  const done = await app.inject({
    method: 'POST',
    url: '/api/prs/7/threads/t1/reopen',
    payload: { reopened: true },
  });
  assert.equal(done.statusCode, 200);

  // No cycle has run: `runCycle` coalesces while one is in flight, so a click that
  // lands during a cycle is followed by no world read at all — the snapshot has to
  // fold the mark itself or the operator watches their ask do nothing for a beat.
  const snapshot = buildStateSnapshot(system);
  const shown = snapshot.world.pullRequests[0]!;
  assert.equal(shown.reviewThreads![0]!.state, 'reopened');
  assert.equal(shown.unresolvedComments[0]!.handled, false);

  // The baseline is untouched, which is what lets the ask be taken back: the row
  // still says what the provider last said.
  assert.equal(system.store.getWorldBaseline()!.pullRequests[0]!.reviewThreads![0]!.state, 'resolved');

  const undone = await app.inject({
    method: 'POST',
    url: '/api/prs/7/threads/t1/reopen',
    payload: { reopened: false },
  });
  assert.equal(undone.statusCode, 200);
  assert.equal(buildStateSnapshot(system).world.pullRequests[0]!.reviewThreads![0]!.state, 'resolved');
});

test('a reopen on a thread nothing carries is refused rather than reported as done', async () => {
  const system = build();
  system.store.setWorldBaseline(world([pr([thread()])]));
  const { app } = await buildApp(system);

  const noThread = await app.inject({
    method: 'POST',
    url: '/api/prs/7/threads/nope/reopen',
    payload: { reopened: true },
  });
  assert.equal(noThread.statusCode, 404, 'a stale page must not leave the operator believing the fleet was asked');

  const noPr = await app.inject({ method: 'POST', url: '/api/prs/99/threads/t1/reopen', payload: { reopened: true } });
  assert.equal(noPr.statusCode, 404);
  assert.equal(system.store.prThreadReopens().length, 0);
});

test('a reopened thread reaches the dispatcher as work, and the fleet answering it spends the mark', async () => {
  const system = build();
  system.store.setWorldBaseline(world([pr([thread({ state: 'answered' })])]));
  const { app } = await buildApp(system);
  await app.inject({ method: 'POST', url: '/api/prs/7/threads/t1/reopen', payload: { reopened: true } });

  // What the rule reads, through the same fold the harness lays over the world it
  // decides against.
  const reopened = applyThreadReopens(system.store.getWorldBaseline()!, system.store.prThreadReopens());
  assert.equal(reopened.pullRequests[0]!.unresolvedComments.filter((c) => !c.handled).length, 1);

  // The reply the fleet eventually sends is what clears it. Without that the mark
  // would hold the thread open against every later reading and the rule would
  // dispatch for it every pulse, for as long as the pull request lived.
  system.store.setPrThreadReopened(7, 't1', false);
  const settled = applyThreadReopens(system.store.getWorldBaseline()!, system.store.prThreadReopens());
  assert.equal(
    settled.pullRequests[0]!.unresolvedComments.every((c) => c.handled),
    true,
  );
});
