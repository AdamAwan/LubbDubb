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
import { AutoSend, autoSendWhy } from '../src/listen/autoSend.js';
import { DEFAULT_LISTEN, type ListenPolicy } from '../src/listen/policy.js';
import { FakeListenClock } from '../src/listen/fakeListenClock.js';
import type { ToolCallResult } from '../src/mcp/protocol.js';
import type { ListenItem, PullRequest } from '../src/types.js';
import type { OpenPullRequest } from '../src/wire.js';
import { desktopDeps } from './support/desktop.js';

/* → docs/spec/44-needs-you.md#sending-by-itself */

function openPr(number: number, over: Partial<OpenPullRequest> = {}): OpenPullRequest {
  return {
    id: `pr_${number}`,
    number,
    title: 'Change',
    branch: `b${number}`,
    ciStatus: 'passing',
    ciChecks: [{ name: 'build', status: 'passing' }],
    unresolvedComments: [],
    health: {} as OpenPullRequest['health'],
    attention: { status: 'you', reasons: [] },
    ciVerdict: { actionable: false, dispatch: [], escalate: [], ignored: [], urgent: false },
    viewerAuthored: true,
    ...over,
  };
}

const review = (number: number, over: Partial<OpenPullRequest> = {}): OpenPullRequest =>
  openPr(number, {
    viewerAuthored: false,
    viewerAssignment: 'reviewer-required',
    attention: { status: 'you', reasons: [], assignedToYou: 'reviewer-required' },
    ...over,
  });

test('a pull request is sent only with every CI check passing', () => {
  assert.equal(autoSendWhy(openPr(1)), 'ready');
  assert.equal(autoSendWhy(review(2)), 'review');
  const red = {
    ciChecks: [
      { name: 'build', status: 'passing' as const },
      { name: 'lint', status: 'failing' as const },
    ],
  };
  assert.equal(autoSendWhy(openPr(3, red)), null, 'one failing check holds it');
  assert.equal(autoSendWhy(review(4, red)), null, 'a review too');
  assert.equal(
    autoSendWhy(openPr(5, { ciChecks: [{ name: 'build', status: 'pending' }] })),
    null,
    'pending is not passed',
  );
  assert.equal(
    autoSendWhy(openPr(6, { ciChecks: [{ name: 'docs', status: 'failing', advisory: true }] })),
    null,
    'an advisory failure still holds it',
  );
  assert.equal(autoSendWhy(openPr(7, { ciStatus: 'unknown' })), null);
  assert.equal(autoSendWhy(openPr(8, { ciChecksWithheld: true })), null, 'checks it could not read are not green');
});

test('ready is a pull request on the operator with no agent on it; review is one asked of them', () => {
  assert.equal(autoSendWhy(openPr(1, { attention: { status: 'harness', reasons: [] } })), null, 'the fleet is on it');
  assert.equal(
    autoSendWhy(openPr(2, { viewerAuthored: false, attention: { status: 'elsewhere', reasons: [] } })),
    null,
    'somebody else’s, not asked of you',
  );
  assert.equal(
    autoSendWhy(openPr(3, { viewerAuthored: false, attention: { status: 'harness', reasons: [] }, assignAsk: [] })),
    null,
  );
  assert.equal(autoSendWhy(openPr(4, { viewerAuthored: false, assignAsk: [{ id: 'p', name: 'Pat' }] })), 'ready');
  assert.equal(
    autoSendWhy(review(5, { viewerApproved: true, attention: { status: 'elsewhere', reasons: [] } })),
    null,
    'once you approved it, attention no longer puts it on you',
  );
  assert.equal(
    autoSendWhy(openPr(6, { attention: { status: 'unwatched', reasons: [] } })),
    'ready',
    'yours, unwatched',
  );
});

function harnessOf(policy: Partial<ListenPolicy>) {
  const sent: ListenItem[] = [];
  const current: { policy: ListenPolicy } = { policy: { ...DEFAULT_LISTEN, ...policy } };
  const auto = new AutoSend({ send: (item) => (sent.push(item), { sent: true }) }, () => current.policy);
  return { sent, auto, current };
}

test('off by default: nothing is read and nothing is sent', () => {
  const { sent, auto } = harnessOf({});
  let read = 0;
  auto.observe(() => (read++, [openPr(1)]));
  auto.observe(() => (read++, [openPr(1), review(2)]));
  assert.equal(read, 0);
  assert.deepEqual(sent, []);
});

test('the first pass after it is turned on only learns what already qualifies; later ones send once each', () => {
  const { sent, auto, current } = harnessOf({ autoSendReviews: true, autoSendReady: true });
  auto.observe(() => [openPr(1)]);
  assert.deepEqual(sent, [], 'already ready when it was turned on');
  auto.observe(() => [openPr(1), review(2), openPr(3, { ciChecks: [{ name: 'build', status: 'failing' }] })]);
  assert.deepEqual(sent, [{ kind: 'pr', number: 2, why: 'review' }]);
  auto.observe(() => [openPr(1), review(2), openPr(3)]);
  auto.observe(() => [openPr(1), review(2), openPr(3)]);
  assert.deepEqual(sent.slice(1), [{ kind: 'pr', number: 3, why: 'ready' }], 'each once');

  auto.observe(() => [openPr(3, { ciChecks: [{ name: 'build', status: 'failing' }] })]);
  auto.observe(() => [openPr(3)]);
  assert.equal(sent.length, 2, 'going red and green again is not sent twice');

  auto.observe(() => null);
  auto.observe(() => [openPr(3)]);
  assert.equal(sent.length, 2, 'a read that is not whole forgets nothing, so nothing is sent again');

  current.policy = { ...current.policy, autoSendReady: false };
  auto.observe(() => [openPr(3), openPr(9)]);
  assert.equal(sent.length, 2, 'ready turned off');
});

const NOW = '2026-01-01T00:00:00.000Z';

function system(listen: Partial<ListenPolicy>): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-autosend-'));
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
      listen: { ...DEFAULT_LISTEN, ...listen },
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
      listenClock: new FakeListenClock(),
    },
  );
}

function worldPr(number: number, over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: `pr_${number}`,
    number,
    title: `Change ${number}`,
    branch: `feature/${number}`,
    ciStatus: 'passing',
    ciChecks: [{ name: 'build', status: 'passing' }],
    unresolvedComments: [],
    state: 'open',
    author: 'pat',
    viewerAuthored: false,
    viewerAssignment: 'reviewer-required',
    assignees: [],
    body: 'Does a thing.',
    url: `https://example.test/pull/${number}`,
    ...over,
  };
}

const endCycle = (sys: System): void => {
  sys.harness.emit('cycle:end', { cycleId: 'cyc_test', at: NOW } as never);
};

async function askWait(sys: System) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-autosend-desk-'));
  const server = new McpDesktopServer({
    ...desktopDeps(sys),
    now: () => NOW,
    socketPath: join(dir, 'desktop.sock'),
    credentialPath: join(dir, 'desktop.json'),
  });
  assert.ok(await server.listen());
  try {
    const result = (await server.session('c1')!.call('ask_wait', {})) as ToolCallResult;
    return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
  } finally {
    await server.close();
  }
}

test('a review asked of the operator reaches ask_wait after a cycle, with the operator’s skill and a titled session', async () => {
  const sys = system({ autoSendReviews: true, prSkill: '/my-pr-skill' });
  try {
    endCycle(sys);
    sys.store.world.setWorldBaseline({ takenAt: NOW, pullRequests: [worldPr(40)], issues: [] });
    endCycle(sys);
    sys.store.world.setWorldBaseline({
      takenAt: NOW,
      pullRequests: [worldPr(40), worldPr(41, { ciChecks: [{ name: 'build', status: 'failing' }] }), worldPr(42)],
      issues: [],
    });
    endCycle(sys);
    assert.equal(
      sys.listener.view(() => true).queued,
      1,
      'no world read yet learns nothing; #40 was there when it first read one',
    );
    const waited = await askWait(sys);
    assert.deepEqual(waited.item, { kind: 'pr', number: 42, why: 'review' });
    assert.equal(waited.skill, '/my-pr-skill 42');
    assert.equal(waited.title, 'Review #42');
  } finally {
    sys.store.close();
  }
});

test('a pull request pressed on the page keeps /lubbdubb:pr and a talk-through title', async () => {
  const sys = system({});
  try {
    sys.listener.send({ kind: 'pr', number: 7 });
    const waited = await askWait(sys);
    assert.equal(waited.skill, '/lubbdubb:pr 7');
    assert.equal(waited.title, 'Talk through #7');
  } finally {
    sys.store.close();
  }
});
