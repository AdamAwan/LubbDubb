import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { buildStateSnapshot } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    dispatcher: 'rule',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    // The funnel, the assessor and the assay are pinned off: they default **on**
    // now, and this file is about something else — leaving them on would put an
    // extra agent in front of every issue these assertions dispatch. Each has its
    // own tests.
    planning: { enabled: false } as never,
    assessment: { enabled: false } as never,
    assay: { enabled: false } as never,
    retrospective: { enabled: false } as never,
  });
}

test('buildStateSnapshot ships a refUrls map covering world items and task branches', async () => {
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'feat/x' });
  system.connector.inject({ kind: 'new_issue', number: 13, title: 'Bug' });
  // The fake provider builds no real URLs; stand in a resolver so the wiring is
  // observable (the provider's resolver is unit-tested elsewhere).
  system.connector.resolveRefUrl = (ref: string) => `https://example.test/${ref}`;
  system.store.createTask({
    kind: 'code',
    title: 'Resolve issue #13',
    prompt: 'p',
    branch: 'issue/13',
    originRef: 'issue:13',
  });
  // The snapshot draws the world the *pulse* observed, never a fresh provider
  // read, so an injected world has to be observed before the cockpit can see it.
  // Seeded rather than pulsed: a real cycle would dispatch agents at these items.
  system.store.setWorldBaseline(await system.connector.getState());

  const snap = await buildStateSnapshot(system);

  assert.equal(snap.refUrls['#42'], 'https://example.test/pr:42');
  assert.equal(snap.refUrls['#13'], 'https://example.test/issue:13');
  assert.equal(snap.refUrls['feat/x'], 'https://example.test/feat/x');
  assert.equal(snap.refUrls['issue/13'], 'https://example.test/issue/13');
  system.store.close();
});

test('buildStateSnapshot attaches a pickup verdict to every issue', async () => {
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  system.connector.inject({ kind: 'new_issue', number: 7, title: 'Bug' });
  system.connector.inject({ kind: 'new_issue', number: 8, title: 'Staffed' });
  // Issue 8 has an active task on its origin → 'active', not 'eligible'.
  system.store.createTask({
    kind: 'code',
    title: 'Resolve issue #8',
    prompt: 'p',
    branch: 'issue/8',
    originRef: 'issue:8',
  });
  system.store.setWorldBaseline(await system.connector.getState());

  const snap = await buildStateSnapshot(system);

  const byNumber = new Map(snap.world.issues.map((i) => [i.number, i]));
  assert.deepEqual(byNumber.get(7)?.pickup, { eligible: true, status: 'eligible', reasons: [] });
  assert.deepEqual(byNumber.get(8)?.pickup, { eligible: false, status: 'active', reasons: ['agent queued'] });
  system.store.close();
});

test('buildStateSnapshot pickup verdict reflects paused dispatch', async () => {
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  system.connector.inject({ kind: 'new_issue', number: 9, title: 'Bug' });
  system.runtimeControl.apply({ paused: true });
  system.store.setWorldBaseline(await system.connector.getState());

  const snap = await buildStateSnapshot(system);

  assert.deepEqual(snap.world.issues[0]?.pickup, {
    eligible: false,
    status: 'blocked',
    reasons: ['dispatch paused'],
  });
  system.store.close();
});

/**
 * The load guard. `connector.getState()` is a provider fan-out — for `azure`,
 * `2 + 3N` REST calls for `N` open PRs — and the cockpit refetches this snapshot
 * on every `dirty`, one of which rides *every file an agent writes*. Reading the
 * provider here made the request rate a function of agent tool-call volume and of
 * how many cockpit tabs were open, which is a rate-limit block waiting to happen.
 *
 * Asserted rather than intended: the count is what a later change would trip.
 */
test('buildStateSnapshot never reads the provider — the pulse is the only reader', async () => {
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  system.connector.inject({ kind: 'new_pr', number: 77, title: 'X', branch: 'feat/x' });
  system.connector.inject({ kind: 'new_issue', number: 78, title: 'Bug' });
  await system.harness.runCycle('manual');

  let reads = 0;
  const real = system.connector.getState.bind(system.connector);
  system.connector.getState = () => {
    reads += 1;
    return real();
  };

  for (let i = 0; i < 3; i += 1) {
    const snap = await buildStateSnapshot(system);
    // Reading the store, not nothing: the world the pulse observed is all there.
    assert.equal(snap.world.pullRequests.length, 1);
    assert.equal(snap.world.issues.length, 1);
    assert.equal(snap.worldObservedAt, snap.world.takenAt);
  }

  assert.equal(reads, 0, 'the snapshot fanned out to the provider');
  system.store.close();
});

/**
 * Before the first cycle there is no baseline. Falling back to a live fetch here
 * is the obvious move and is wrong: boot while the provider is throttling and the
 * boot cycle fails, so the baseline is never written, so every `dirty` refetches,
 * fans out, fails, and records an error — which broadcasts another `dirty`.
 * Unbounded, and worst exactly when the provider is already refusing us.
 */
test('buildStateSnapshot with no baseline ships an empty world, not a live fetch', async () => {
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  system.connector.inject({ kind: 'new_pr', number: 79, title: 'X', branch: 'feat/y' });

  let reads = 0;
  const real = system.connector.getState.bind(system.connector);
  system.connector.getState = () => {
    reads += 1;
    return real();
  };

  const snap = await buildStateSnapshot(system);

  assert.equal(snap.worldObservedAt, null, 'an unobserved world must not claim a timestamp');
  assert.deepEqual(snap.world.pullRequests, []);
  assert.deepEqual(snap.world.issues, []);
  assert.equal(reads, 0, 'the empty case fell back to the provider');
  system.store.close();
});
