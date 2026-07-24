import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { buildStateSnapshot } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';

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
  });
}

test('buildStateSnapshot ships a refUrls map covering world items and task branches', async () => {
  const system = buildSystem(testConfig(), { backend: new FakePtyBackend() });
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

  const snap = await buildStateSnapshot(system);

  assert.equal(snap.refUrls['#42'], 'https://example.test/pr:42');
  assert.equal(snap.refUrls['#13'], 'https://example.test/issue:13');
  assert.equal(snap.refUrls['feat/x'], 'https://example.test/feat/x');
  assert.equal(snap.refUrls['issue/13'], 'https://example.test/issue/13');
  system.store.close();
});

test('buildStateSnapshot attaches a pickup verdict to every issue', async () => {
  const system = buildSystem(testConfig(), { backend: new FakePtyBackend() });
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

  const snap = await buildStateSnapshot(system);

  const byNumber = new Map(snap.world.issues.map((i) => [i.number, i]));
  assert.deepEqual(byNumber.get(7)?.pickup, { eligible: true, status: 'eligible', reasons: [] });
  assert.deepEqual(byNumber.get(8)?.pickup, { eligible: false, status: 'active', reasons: ['agent queued'] });
  system.store.close();
});

test('buildStateSnapshot pickup verdict reflects paused dispatch', async () => {
  const system = buildSystem(testConfig(), { backend: new FakePtyBackend() });
  system.connector.inject({ kind: 'new_issue', number: 9, title: 'Bug' });
  system.runtimeControl.apply({ paused: true });

  const snap = await buildStateSnapshot(system);

  assert.deepEqual(snap.world.issues[0]?.pickup, {
    eligible: false,
    status: 'blocked',
    reasons: ['dispatch paused'],
  });
  system.store.close();
});
