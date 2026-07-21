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
