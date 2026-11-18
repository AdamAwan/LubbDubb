import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { McpDesktopServer } from '../src/mcp/desktop.js';
import { buildApp } from '../src/server/app.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { askQueue } from '../src/server/askReads.js';
import {
  LISTEN_GRACE_MS,
  LISTEN_WAIT_MS,
  Listener,
  type ListenStanding,
  type WaitResult,
} from '../src/listen/listener.js';
import { FakeListenClock } from '../src/listen/fakeListenClock.js';
import { prOnYouReasons } from '../src/listen/prsOnYou.js';
import type { ToolCallResult } from '../src/mcp/protocol.js';
import type { PullRequest } from '../src/types.js';
import type { OpenPullRequest } from '../src/wire.js';
import { desktopDeps } from './support/desktop.js';

/* → docs/spec/44-needs-you.md */

const NOBODY: ListenStanding = () => false;

function stands(askIds: string[], prs: number[]): ListenStanding {
  return (item) => (item.kind === 'ask' ? askIds.includes(item.id) : prs.includes(item.number));
}
const ASK = { kind: 'ask', id: 'a1' } as const;
const PR = { kind: 'pr', number: 212 } as const;

function settledNow<T>(promise: Promise<T>): Promise<{ done: boolean; value?: T }> {
  return Promise.race([
    promise.then((value) => ({ done: true, value })),
    new Promise<{ done: boolean }>((resolve) => setImmediate(() => resolve({ done: false }))),
  ]);
}

test('a wait is bounded: it returns { item: null } by itself after LISTEN_WAIT_MS', async () => {
  const clock = new FakeListenClock();
  const listener = new Listener(clock);
  const wait = listener.wait();
  clock.advance(LISTEN_WAIT_MS - 1);
  assert.equal((await settledNow(wait)).done, false, 'still held just short of the bound');
  clock.advance(1);
  assert.deepEqual(await wait, { item: null });
});

test('an item is handed out once: a send answers the open waiter, and the next wait does not get it again', async () => {
  const clock = new FakeListenClock();
  const listener = new Listener(clock);
  const first = listener.wait();
  assert.deepEqual(listener.send(PR), { sent: true });
  assert.deepEqual(await first, { item: PR });
  const second = listener.wait();
  assert.equal((await settledNow(second)).done, false, 'the item already handed out is not handed out again');
  clock.advance(LISTEN_WAIT_MS);
  assert.deepEqual(await second, { item: null });
});

test('a queued item is handed to the next wait at once, in the order sent', async () => {
  const listener = new Listener(new FakeListenClock());
  listener.send(ASK);
  listener.send(PR);
  assert.equal(listener.view(NOBODY).queued, 2);
  assert.deepEqual(await listener.wait(), { item: ASK });
  assert.deepEqual(await listener.wait(), { item: PR });
  assert.equal(listener.view(NOBODY).queued, 0);
});

test('one waiter at a time: a new wait answers the older with superseded', async () => {
  const listener = new Listener(new FakeListenClock());
  const older = listener.wait();
  const newer = listener.wait();
  assert.deepEqual(await older, { item: null, superseded: true } satisfies WaitResult);
  listener.send(ASK);
  assert.deepEqual(await newer, { item: ASK }, 'the send reaches the waiter that took over');
});

test('state: listening while a wait is open and for the grace after an empty one, busy on an item, else off', async () => {
  const clock = new FakeListenClock();
  const listener = new Listener(clock);
  assert.equal(listener.view(NOBODY).state, 'off', 'nothing has ever waited');

  const wait = listener.wait();
  assert.equal(listener.view(NOBODY).state, 'listening');
  clock.advance(LISTEN_WAIT_MS);
  await wait;
  assert.equal(listener.view(NOBODY).state, 'listening', 'the grace covers the gap between waits');
  clock.advance(LISTEN_GRACE_MS - 1);
  assert.equal(listener.view(NOBODY).state, 'listening');
  clock.advance(1);
  assert.equal(listener.view(NOBODY).state, 'off', 'no wait came back within the grace');

  const working = listener.wait();
  listener.send(PR);
  await working;
  const busy = listener.view(NOBODY);
  assert.equal(busy.state, 'busy');
  assert.deepEqual(busy.on, PR);
  listener.send(ASK);
  assert.equal(listener.view(NOBODY).queued, 1, 'a send while busy queues behind the item');
  clock.advance(LISTEN_GRACE_MS * 10);
  assert.equal(listener.view(NOBODY).state, 'busy', 'busy holds until the chat waits again');

  void listener.wait();
  const back = listener.view(NOBODY);
  assert.equal(back.state, 'busy', 'the wait took the queued ask at once');
  assert.deepEqual(back.on, ASK);
});

test('the grace running out tells the cockpit', async () => {
  const clock = new FakeListenClock();
  const listener = new Listener(clock);
  let changes = 0;
  listener.on('changed', () => changes++);
  const wait = listener.wait();
  clock.advance(LISTEN_WAIT_MS);
  await wait;
  const before = changes;
  clock.advance(LISTEN_GRACE_MS);
  assert.equal(changes, before + 1);
});

test('the listener tells the cockpit only when what it shows has changed', async () => {
  const clock = new FakeListenClock();
  const listener = new Listener(clock);
  let changes = 0;
  listener.on('changed', () => changes++);
  void listener.wait();
  assert.equal(changes, 1, 'off to listening');
  void listener.wait();
  assert.equal(changes, 1, 'a newer wait is still listening');
  listener.send(PR);
  assert.equal(changes, 2, 'busy on the item');
  listener.send(PR);
  assert.equal(changes, 2, 'a no-op send shows nothing new');
});

test('sending an item already queued or already on the chat is a no-op', async () => {
  const listener = new Listener(new FakeListenClock());
  listener.send(PR);
  assert.deepEqual(listener.send({ kind: 'pr', number: 212 }), { sent: false });
  assert.equal(listener.view(NOBODY).queued, 1);
  await listener.wait();
  assert.deepEqual(listener.send(PR), { sent: false }, 'it is the item the chat is on');
  assert.equal(listener.view(NOBODY).queued, 0);
  assert.deepEqual(listener.send(ASK), { sent: true });
});

test('sent entries drop when the ask no longer stands, the pull request is off the page, or after a day', async () => {
  const clock = new FakeListenClock();
  const listener = new Listener(clock);
  const standing = stands(['a1'], [212]);
  listener.send(ASK);
  await listener.wait();
  clock.advance(1000);
  listener.send(PR);
  await listener.wait();
  const both = listener.view(standing).sent;
  assert.deepEqual(
    both.map((s) => s.item),
    [PR, ASK],
    'newest first',
  );
  assert.equal(both[1]?.sentAt, new Date(clock.now() - 1000).toISOString(), 'stamped when it was sent');

  assert.deepEqual(
    listener.view(stands([], [212])).sent.map((s) => s.item),
    [PR],
    'the settled ask is dropped',
  );
  assert.deepEqual(listener.view(stands(['a1'], [])).sent, [], 'the pull request left the page');

  listener.send(ASK);
  await listener.wait();
  clock.advance(24 * 60 * 60_000);
  assert.deepEqual(listener.view(standing).sent, [], 'a day later nothing is kept');
});

function openPr(over: Partial<OpenPullRequest> = {}): OpenPullRequest {
  return {
    id: 'pr_1',
    number: 1,
    title: 'Change',
    branch: 'b',
    ciStatus: 'passing',
    unresolvedComments: [],
    health: {} as OpenPullRequest['health'],
    attention: { status: 'harness', reasons: [] },
    ciVerdict: { actionable: false, dispatch: [], escalate: [], ignored: [], urgent: false },
    ...over,
  };
}

test('prOnYouReasons reads the spec table, in its order', () => {
  assert.deepEqual(prOnYouReasons(openPr()), []);
  assert.deepEqual(prOnYouReasons(openPr({ body: undefined })), [], 'an unread body is not an empty one');
  assert.deepEqual(
    prOnYouReasons(
      openPr({
        attention: { status: 'you', reasons: [], assignedToYou: 'reviewer-required' },
        unresolvedComments: [{ id: 'c', author: 'r', body: 'why?', handled: true }],
        assignAsk: [{ id: 'carol', name: 'Carol' }],
        body: '  \n',
      }),
    ),
    ['review', 'comments', 'assign', 'describe'],
    'assigned to you is a review, never also a call',
  );
  assert.deepEqual(prOnYouReasons(openPr({ attention: { status: 'you', reasons: [] } })), ['call']);
  assert.deepEqual(prOnYouReasons(openPr({ assignAsk: [] })), [], 'an empty reviewer ask is no ask');
});

const NOW = '2026-01-01T00:00:00.000Z';

function system(clock: FakeListenClock): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-listen-'));
  return buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
      listenClock: clock,
    },
  );
}

async function desktop(sys: System) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-listen-desk-'));
  const server = new McpDesktopServer({
    ...desktopDeps(sys),
    now: () => NOW,
    socketPath: process.platform === 'win32' ? `\\\\.\\pipe\\lubbdubb-listen-${Date.now()}` : join(dir, 'l.sock'),
    credentialPath: join(dir, 'desktop.json'),
  });
  assert.ok(await server.listen());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const session = server.session('c1');
    assert.ok(session);
    const result = (await session.call(name, args)) as ToolCallResult;
    const text = result.content[0]?.text ?? '';
    return { isError: result.isError === true, text, json: result.isError ? {} : JSON.parse(text) };
  };
  return { call, close: () => server.close() };
}

function pr(number: number, over: Partial<PullRequest> = {}): PullRequest {
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
    url: `https://example.test/pull/${number}`,
    ...over,
  };
}

test('POST /api/listen/send queues for ask_wait, refuses a malformed item, and the snapshot reads the listener', async () => {
  const clock = new FakeListenClock();
  const sys = system(clock);
  const { app } = await buildApp(sys);
  const d = await desktop(sys);
  try {
    sys.store.world.setWorldBaseline({ takenAt: NOW, pullRequests: [pr(212, { body: '' })], issues: [] });
    assert.deepEqual(buildStateSnapshot(sys).listener, { state: 'off', on: null, queued: 0, sent: [] });

    const bad = await app.inject({ method: 'POST', url: '/api/listen/send', payload: { item: { kind: 'pr' } } });
    assert.equal(bad.statusCode, 400);

    const sent = await app.inject({ method: 'POST', url: '/api/listen/send', payload: { item: PR } });
    assert.equal(sent.statusCode, 200);
    assert.deepEqual(sent.json(), { ok: true, sent: true });
    const again = await app.inject({ method: 'POST', url: '/api/listen/send', payload: { item: PR } });
    assert.deepEqual(again.json(), { ok: true, sent: false }, 'already queued');
    assert.equal(buildStateSnapshot(sys).listener.queued, 1);

    const waited = await d.call('ask_wait');
    assert.equal(waited.isError, false, waited.text);
    assert.deepEqual(waited.json.item, PR);
    assert.match(String(waited.json.next), /\/lubbdubb:pr <number>/);
    const view = buildStateSnapshot(sys).listener;
    assert.equal(view.state, 'busy');
    assert.deepEqual(view.on, PR);
    assert.deepEqual(
      view.sent.map((s) => s.item),
      [PR],
      'kept while the pull request is on the page (no description)',
    );

    sys.store.world.setWorldBaseline({ takenAt: NOW, pullRequests: [pr(212, { body: 'Does a thing' })], issues: [] });
    assert.deepEqual(buildStateSnapshot(sys).listener.sent, [], 'off the page, so the strip goes');
  } finally {
    await d.close();
    await app.close();
    sys.store.close();
  }
});

test('?sections=listener answers the listener alone, without the asks', async () => {
  const sys = system(new FakeListenClock());
  const { app } = await buildApp(sys);
  try {
    sys.listener.send(PR);
    const res = await app.inject({ method: 'GET', url: '/api/state?sections=listener' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.listener.queued, 1);
    assert.equal(body.asks, undefined);
  } finally {
    await app.close();
    sys.store.close();
  }
});

test('a sent ask is kept while it stands and dropped once it is settled', async () => {
  const clock = new FakeListenClock();
  const sys = system(clock);
  try {
    const escalation = sys.store.escalations.createEscalation({
      type: 'answer_question',
      prompt: 'Which store?',
      context: {},
      agentId: null,
      taskId: null,
    });
    const row = askQueue(sys).find((r) => r.subject.type === 'escalation');
    assert.ok(row);
    sys.listener.send({ kind: 'ask', id: row.id });
    await sys.listener.wait();
    assert.equal(buildStateSnapshot(sys).listener.sent.length, 1);
    sys.store.escalations.dismissEscalation(escalation.id, { reason: 'test' });
    assert.deepEqual(buildStateSnapshot(sys).listener.sent, []);
  } finally {
    sys.store.close();
  }
});

test('ask_wait holds until a send, and a newer call supersedes it', async () => {
  const clock = new FakeListenClock();
  const sys = system(clock);
  const d = await desktop(sys);
  try {
    const held = d.call('ask_wait');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(buildStateSnapshot(sys).listener.state, 'listening');
    const newer = d.call('ask_wait');
    const older = await held;
    assert.equal(older.json.superseded, true);
    assert.equal(older.json.item, null);
    sys.listener.send(ASK);
    assert.deepEqual((await newer).json.item, ASK);

    const empty = d.call('ask_wait');
    await new Promise((resolve) => setImmediate(resolve));
    clock.advance(LISTEN_WAIT_MS);
    assert.equal((await empty).json.item, null);
  } finally {
    await d.close();
    sys.store.close();
  }
});

test('pr_read answers the record of an open pull request and refuses one that is not open', async () => {
  const sys = system(new FakeListenClock());
  const d = await desktop(sys);
  try {
    sys.store.prArchive.archiveClosedPrs([pr(5, { state: 'merged', merged: true })]);
    sys.store.world.setWorldBaseline({
      takenAt: NOW,
      pullRequests: [
        pr(212, {
          body: '',
          baseBranch: 'main',
          ciChecks: [{ name: 'build', status: 'failing' }],
          ciStatus: 'failing',
          unresolvedComments: [
            {
              id: 'c1',
              author: 'rev',
              body: 'Why?',
              handled: false,
              replies: [{ id: 'r', author: 'me', body: 'Because', ours: true }],
            },
          ],
          reviewThreads: [
            { id: 't1', author: 'rev', body: 'Rename this', state: 'open', replies: [], path: 'src/a.ts', line: 3 },
          ],
        }),
      ],
      closedPullRequests: [pr(5, { state: 'merged', merged: true })],
      issues: [],
    });
    const read = await d.call('pr_read', { number: 212 });
    assert.equal(read.isError, false, read.text);
    assert.equal(read.json.title, 'Change 212');
    assert.equal(read.json.branch, 'issue/212');
    assert.equal(read.json.url, 'https://example.test/pull/212');
    assert.equal(read.json.ciStatus, 'failing');
    assert.ok(read.json.ciVerdict, 'the CI verdict rides along');
    assert.equal(read.json.reviewThreads[0].path, 'src/a.ts');
    assert.equal(read.json.unresolvedComments[0].replies[0].body, 'Because');
    assert.ok(read.json.attention.status);
    assert.ok(read.json.onYou.includes('describe'));
    assert.ok(read.json.onYou.includes('comments'));
    assert.equal(read.json.goal.ref, 'issue:212', 'the goal off the branch, as every ask line reads it');

    const merged = await d.call('pr_read', { number: 5 });
    assert.ok(merged.isError);
    assert.match(merged.text, /merged, not open/);
    const unknown = await d.call('pr_read', { number: 999 });
    assert.ok(unknown.isError);
  } finally {
    await d.close();
    sys.store.close();
  }
});
