import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, isWorldInjectable } from '../src/server/app.js';
import { buildSystem } from '../src/system.js';
import { loadConfig } from '../src/config.js';
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

test('isWorldInjectable: true only when a fake provider is configured', () => {
  assert.equal(isWorldInjectable({ sourceControl: 'fake', issues: 'fake', backlog: 'fake', calendar: 'fake' }), true);
  // One fake capability keeps injection available (its domain can still receive events).
  assert.equal(
    isWorldInjectable({ sourceControl: 'github', issues: 'github', backlog: 'fake', calendar: 'fake' }),
    true,
  );
  assert.equal(
    isWorldInjectable({ sourceControl: 'github', issues: 'github', backlog: 'azure', calendar: 'azure' }),
    false,
  );
});

test('/api/inject works and the snapshot advertises injectable with fake integrations', async () => {
  const system = buildSystem(testConfig(), { backend: new FakePtyBackend() });
  const { app } = await buildApp(system);

  const state = await (await app.inject({ method: 'GET', url: '/api/state' })).json();
  assert.equal(state.config.injectable, true);

  const res = await app.inject({
    method: 'POST',
    url: '/api/inject',
    payload: { kind: 'new_story', title: 'Injected via HTTP', wafPillars: ['Reliability'] },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);

  const after = await (await app.inject({ method: 'GET', url: '/api/state' })).json();
  assert.ok(after.world.stories.some((s: { title: string }) => s.title === 'Injected via HTTP'));

  await app.close();
  system.store.close();
});
