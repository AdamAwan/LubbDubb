import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { PullRequest, WorldSnapshot } from '../src/types.js';

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-sw-'));
  return loadConfig({
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

/**
 * A provider whose read fails after a successful one serves a *stale* slice, and
 * the harness must not take that slice as the world's new baseline (issue #575):
 * diffing the recovery against an empty baseline re-announces the whole world and
 * releases every standing delivery verdict.
 */
test('a stale slice never moves the world baseline, so recovery re-announces nothing', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend });

  const real = snapshot([pr(1)]);
  const stale = snapshot([], ['sourceControl:github']);
  // Full -> empty-stale -> full: the first read failing is a different bug
  // (rethrow), so here the provider *has* read once and serves a stale empty slice.
  const scripted: WorldSnapshot[] = [real, stale, real];
  system.connector.getState = async () => scripted.shift() ?? real;

  // Pulse 1: establish the baseline over the real world — no events, baseline set.
  await system.harness.runCycle('manual');
  // Pulse 2: the stale slice. It must not move the baseline.
  await system.harness.runCycle('manual');
  // Pulse 3: the provider recovers with an identical world. Diffing it against the
  // empty stale baseline is exactly the flood this guards against.
  await system.harness.runCycle('manual');

  // No world event is ever fabricated across all three pulses.
  assert.deepEqual(system.store.listWorldEvents(), []);

  // The baseline still names the last world anybody actually read: the real one.
  assert.equal(system.store.getWorldBaseline()?.pullRequests.length, 1);

  system.store.close();
});
