import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem } from '../src/system.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-archive-'));
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

function build() {
  return buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
}

test('a closed pull request is archived by the pulse and outlives the world’s window', async () => {
  const system = build();

  system.connector.inject({ kind: 'new_pr', number: 42, title: 'Add widget', branch: 'issue/12/widget' });
  await system.harness.runCycle('manual');
  assert.deepEqual(system.store.prArchive.listArchivedPrs(), [], 'an open pull request is not archived');

  system.connector.inject({ kind: 'pr_closed', prNumber: 42, merged: true });
  await system.harness.runCycle('manual');
  assert.deepEqual(
    system.store.prArchive.listArchivedPrs().map((pr) => ({ number: pr.number, merged: pr.merged, title: pr.title })),
    [{ number: 42, merged: true, title: 'Add widget' }],
  );

  system.store.world.setWorldBaseline({ takenAt: new Date().toISOString(), pullRequests: [], issues: [] });
  const kept = system.store.prArchive.listArchivedPrs();
  assert.deepEqual(
    kept.map((pr) => pr.number),
    [42],
  );
  assert.equal(kept[0]?.branch, 'issue/12/widget', 'the whole row is kept, not a stub of it');

  const snapshot = buildStateSnapshot(system);
  assert.deepEqual(
    snapshot.archivedPullRequests.map((pr) => pr.number),
    [42],
    'the cockpit is shipped the archive beside the world, not inside it',
  );
  assert.deepEqual(snapshot.world.closedPullRequests ?? [], [], 'the world still means "recently"');

  system.store.close();
});

test('re-reporting the same closed pull request refreshes its row rather than adding one', () => {
  const system = build();
  const pr = {
    id: 'pr-7',
    number: 7,
    title: 'as first seen',
    branch: 'issue/12',
    ciStatus: 'unknown' as const,
    unresolvedComments: [],
    merged: true,
    state: 'merged' as const,
    closedAt: '2026-01-01T00:00:00.000Z',
  };

  system.store.prArchive.archiveClosedPrs([pr]);
  system.store.prArchive.archiveClosedPrs([{ ...pr, title: 'as last read' }]);

  assert.deepEqual(
    system.store.prArchive.listArchivedPrs().map((row) => row.title),
    ['as last read'],
  );

  system.store.close();
});
