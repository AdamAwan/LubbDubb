import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { buildSystem, type System } from '../src/system/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { DEFAULT_PLANNING } from '../src/plans/planning.js';
import { assignShortlist } from '../src/pr/prAssignAsk.js';
import type { ActionSink, PrAssignInput, PrAssignSink } from '../src/sink/actionSink.js';
import type { PrPerson, PullRequest } from '../src/types.js';

const carol: PrPerson = { id: 'carol', name: 'Carol' };
const dave: PrPerson = { id: 'dave', name: 'Dave' };
const me: PrPerson = { id: 'me', name: 'me' };

function recordingSink(canAssign = true): { sink: ActionSink & PrAssignSink; assigned: PrAssignInput[] } {
  const assigned: PrAssignInput[] = [];
  const own: Partial<ActionSink & PrAssignSink> = {
    canAssignPr: () => canAssign,
    assignPr: async (input) => {
      assigned.push(input);
      return { ok: true };
    },
  };
  const sink = new Proxy(own, {
    get: (target, key) => target[key as keyof typeof target] ?? (() => false),
  }) as ActionSink & PrAssignSink;
  return { sink, assigned };
}

function build(sink: ActionSink): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-assign-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    planning: { ...DEFAULT_PLANNING },
    userId: 'me',
  });
  return buildSystem(config, {
    sink,
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    gitObserver: new FakeGitObserver(),
    errorMirror: () => {},
  });
}

function pr(number: number, overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: `pr_${number}`,
    number,
    title: `Change ${number}`,
    branch: `issue/${number}`,
    ciStatus: 'passing',
    unresolvedComments: [],
    state: 'open',
    author: 'me',
    viewerAuthored: true,
    assignees: [],
    ...overrides,
  };
}

function seed(system: System, open: PullRequest[]): void {
  system.store.prArchive.archiveClosedPrs([
    pr(1, { state: 'merged', merged: true, assignees: [carol, me] }),
    pr(2, { state: 'merged', merged: true, assignees: [dave] }),
    pr(3, { state: 'merged', merged: true, assignees: [carol] }),
    pr(4, { state: 'merged', merged: true, assignees: [{ id: 'eve', name: 'Eve' }], viewerAuthored: false }),
  ]);
  system.store.world.setWorldBaseline({ takenAt: new Date().toISOString(), pullRequests: open, issues: [] });
}

function askOf(system: System, number: number): PrPerson[] | undefined {
  return buildStateSnapshot(system).world.pullRequests.find((p) => p.number === number)?.assignAsk;
}

test('a finished pull request of ours asks who to assign, offering who our pull requests usually go to', () => {
  const system = build(recordingSink().sink);
  seed(system, [pr(7)]);
  assert.deepEqual(
    askOf(system, 7),
    [carol, dave],
    'most-assigned first; the operator and other people’s PRs are left out',
  );
});

test('it is not asked while a comment is unanswered, once somebody is on it, or for somebody else’s pull request', () => {
  const system = build(recordingSink().sink);
  seed(system, [
    pr(7, { unresolvedComments: [{ id: 'c1', author: 'bob', body: 'why?', handled: false }] }),
    pr(8, { assignees: [dave] }),
    pr(9, { viewerAuthored: false, author: 'bob' }),
    pr(10, { assignees: undefined }),
  ]);
  for (const n of [7, 8, 9, 10]) assert.equal(askOf(system, n), undefined, `PR #${n}`);
});

test('it is not asked when the tracker cannot assign, or when there is nobody to offer', () => {
  const unable = build(recordingSink(false).sink);
  seed(unable, [pr(7)]);
  assert.equal(askOf(unable, 7), undefined);

  const fresh = build(recordingSink().sink);
  fresh.store.world.setWorldBaseline({ takenAt: new Date().toISOString(), pullRequests: [pr(7)], issues: [] });
  assert.equal(askOf(fresh, 7), undefined);
});

test('picking a person assigns them in the tracker and ends the ask', async () => {
  const { sink, assigned } = recordingSink();
  const system = build(sink);
  seed(system, [pr(7)]);
  const { app } = await buildApp(system);

  const stranger = await app.inject({ method: 'POST', url: '/api/prs/7/assign', payload: { personId: 'mallory' } });
  assert.equal(stranger.statusCode, 409, 'only the shortlist is offered, so only the shortlist is accepted');

  const done = await app.inject({ method: 'POST', url: '/api/prs/7/assign', payload: { personId: 'dave' } });
  assert.equal(done.statusCode, 200);
  assert.deepEqual(assigned, [{ prNumber: 7, personId: 'dave' }]);
  assert.equal(askOf(system, 7), undefined);
});

test('"nah" ends the ask for good, and assigns nobody', async () => {
  const { sink, assigned } = recordingSink();
  const system = build(sink);
  seed(system, [pr(7)]);
  const { app } = await buildApp(system);

  const res = await app.inject({ method: 'POST', url: '/api/prs/7/assign/decline' });
  assert.equal(res.statusCode, 200);
  assert.equal(askOf(system, 7), undefined);
  assert.deepEqual(assigned, []);

  const missing = await app.inject({ method: 'POST', url: '/api/prs/99/assign/decline' });
  assert.equal(missing.statusCode, 404);
});

test('an assignment made through the ask counts towards the shortlist', () => {
  const list = assignShortlist([], [{ prNumber: 5, person: dave }], 'me');
  assert.deepEqual(list, [dave]);
});
