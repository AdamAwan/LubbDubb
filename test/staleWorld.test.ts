import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { PullRequest, WorldSnapshot } from '../src/types.js';

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-sw-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
  });
}

function pr(number: number): PullRequest {
  return {
    id: `pr_${number}`,
    number,
    title: `PR #${number}`,
    branch: `b${number}`,
    baseBranch: 'main',
    ciStatus: 'passing',
    unresolvedComments: [],
  };
}

function snapshot(prs: PullRequest[], staleSources?: string[]): WorldSnapshot {
  return {
    takenAt: new Date().toISOString(),
    pullRequests: prs,
    issues: [],
    ...(staleSources ? { staleSources } : {}),
  };
}

test('a stale slice never moves the world baseline, so recovery re-announces nothing', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend });

  const real = snapshot([pr(1)]);
  const stale = snapshot([], ['sourceControl:github']);
  const scripted: WorldSnapshot[] = [real, stale, real];
  system.connector.getState = async () => scripted.shift() ?? real;

  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');

  assert.deepEqual(system.store.world.listWorldEvents(), []);

  assert.equal(system.store.world.getWorldBaseline()?.pullRequests.length, 1);

  system.store.close();
});
