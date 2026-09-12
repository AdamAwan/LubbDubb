import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import type { WorldEvent } from '../src/types.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-we-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
}

test('injected world changes are recorded as world events across cycles', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend });
  const emitted: WorldEvent[] = [];
  system.harness.on('world:events', ({ events }) => emitted.push(...events));

  await system.harness.runCycle('manual');

  system.connector.inject({ kind: 'new_pr', number: 42, title: 'Add widget', branch: 'feat/widget' });
  await system.harness.runCycle('manual');
  system.connector.inject({ kind: 'ci_passed', prNumber: 42 });
  await system.harness.runCycle('manual');
  system.connector.inject({ kind: 'pr_approved', prNumber: 42 });
  await system.harness.runCycle('manual');

  const kinds = system.store.world.listWorldEvents().map((e) => e.kind);
  assert.ok(kinds.includes('pr_opened'), 'the new PR should record pr_opened');
  assert.ok(kinds.includes('pr_ci'), 'CI going green should record pr_ci');
  assert.ok(kinds.includes('pr_approved'), 'approval should record pr_approved');

  assert.deepEqual(
    emitted.map((e) => e.id).sort(),
    system.store.world
      .listWorldEvents()
      .map((e) => e.id)
      .sort(),
  );

  const ci = system.store.world.listWorldEvents().find((e) => e.kind === 'pr_ci')!;
  assert.match(ci.summary, /#42/);
  assert.match(ci.summary, /passing/);

  system.store.close();
});

test('the first cycle over a fresh store only sets the baseline (no spurious events)', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend });

  system.connector.inject({ kind: 'new_pr', number: 1, title: 'Seed', branch: 'seed' });
  await system.harness.runCycle('manual');

  assert.deepEqual(system.store.world.listWorldEvents(), []);

  system.connector.inject({ kind: 'ci_passed', prNumber: 1 });
  await system.harness.runCycle('manual');
  assert.deepEqual(
    system.store.world.listWorldEvents().map((e) => e.kind),
    ['pr_ci'],
  );

  system.store.close();
});

test('the persisted baseline survives a restart, so no re-flood on the next boot', async () => {
  const backend = new FakePtyBackend();
  const config = testConfig();
  const dbPath = join(mkdtempSync(join(tmpdir(), 'lubbdubb-restart-')), 'db.sqlite');
  config.dbPath = dbPath;

  const first = buildSystem(config, { worktrees: new FakeWorktreeManager(), backend });
  first.connector.inject({ kind: 'new_pr', number: 7, title: 'Persist', branch: 'p' });
  await first.harness.runCycle('manual');
  assert.deepEqual(first.store.world.listWorldEvents(), []);
  first.store.close();

  const second = buildSystem(config, { worktrees: new FakeWorktreeManager(), backend });
  await second.harness.runCycle('manual');
  assert.deepEqual(second.store.world.listWorldEvents(), [], 'restart must not re-flood the feed');
  second.store.close();
});
