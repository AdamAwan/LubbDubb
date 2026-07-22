import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import type { WorldEvent } from '../src/types.js';

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-we-'));
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

test('injected world changes are recorded as world events across cycles', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { backend });
  const emitted: WorldEvent[] = [];
  system.harness.on('world:events', ({ events }) => emitted.push(...events));

  // One cycle over the empty world first, to establish the baseline (the first
  // cycle never emits — it has nothing to diff against).
  await system.harness.runCycle('manual');

  // A PR appears, then its CI goes green, then it is approved — three cycles,
  // each diffing against the previous snapshot.
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'Add widget', branch: 'feat/widget' });
  await system.harness.runCycle('manual');
  system.connector.inject({ kind: 'ci_passed', prNumber: 42 });
  await system.harness.runCycle('manual');
  system.connector.inject({ kind: 'pr_approved', prNumber: 42 });
  await system.harness.runCycle('manual');

  const kinds = system.store.listWorldEvents().map((e) => e.kind);
  assert.ok(kinds.includes('pr_opened'), 'the new PR should record pr_opened');
  assert.ok(kinds.includes('pr_ci'), 'CI going green should record pr_ci');
  assert.ok(kinds.includes('pr_approved'), 'approval should record pr_approved');

  // Every recorded event was also streamed to the cockpit.
  assert.deepEqual(
    emitted.map((e) => e.id).sort(),
    system.store
      .listWorldEvents()
      .map((e) => e.id)
      .sort(),
  );

  // A summary carries the PR number so the feed line is self-describing.
  const ci = system.store.listWorldEvents().find((e) => e.kind === 'pr_ci')!;
  assert.match(ci.summary, /#42/);
  assert.match(ci.summary, /passing/);

  system.store.close();
});

test('the first cycle over a fresh store only sets the baseline (no spurious events)', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { backend });

  // Seed the world before the very first cycle, then run once.
  system.connector.inject({ kind: 'new_pr', number: 1, title: 'Seed', branch: 'seed' });
  await system.harness.runCycle('manual');

  // No prior baseline existed, so the seeded PR is the baseline — not a pr_opened.
  assert.deepEqual(system.store.listWorldEvents(), []);

  // A subsequent change now diffs against that baseline and does record.
  system.connector.inject({ kind: 'ci_passed', prNumber: 1 });
  await system.harness.runCycle('manual');
  assert.deepEqual(
    system.store.listWorldEvents().map((e) => e.kind),
    ['pr_ci'],
  );

  system.store.close();
});

test('the persisted baseline survives a restart, so no re-flood on the next boot', async () => {
  const backend = new FakePtyBackend();
  const config = testConfig();
  // Share one on-disk DB across two System instances to simulate a restart.
  const dbPath = join(mkdtempSync(join(tmpdir(), 'lubbdubb-restart-')), 'db.sqlite');
  config.dbPath = dbPath;

  const first = buildSystem(config, { backend });
  first.connector.inject({ kind: 'new_pr', number: 7, title: 'Persist', branch: 'p' });
  await first.harness.runCycle('manual'); // baseline set, no events
  assert.deepEqual(first.store.listWorldEvents(), []);
  first.store.close();

  // Reboot against the same DB and world; the persisted baseline means the
  // unchanged PR is not re-emitted as new.
  const second = buildSystem(config, { backend });
  await second.harness.runCycle('manual');
  assert.deepEqual(second.store.listWorldEvents(), [], 'restart must not re-flood the feed');
  second.store.close();
});
