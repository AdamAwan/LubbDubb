import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { buildStateSnapshot } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';

/** A throwaway git repo with one commit, so real `git worktree add` works in isolation. */
function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-repo-'));
  const git = (args: string[]): void => void execFileSync('git', args, { cwd: dir });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['commit', '-q', '--allow-empty', '-m', 'root']);
  return dir;
}

function build() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const config = loadConfig({
    dbPath: ':memory:',
    dispatcher: 'rule',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    repoRoot: gitRepo(),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
  return buildSystem(config, { backend: new FakePtyBackend() });
}

test('config.excludedPrs seeds the runtime exclusion set and keeps the harness off that PR', async () => {
  const system = build();
  // Seeded directly here to prove the config → runtime path; the endpoint test
  // covers the live toggle.
  system.runtimeControl.apply({ excludedPrs: [42] });

  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'feat', baseBranch: 'main' });
  system.connector.inject({ kind: 'ci_failed', prNumber: 42 });
  await system.harness.runCycle('manual');

  assert.equal(
    system.store.listTasks().some((t) => t.originRef === 'pr:42:ci'),
    false,
    'no CI-fix agent is dispatched for an excluded PR',
  );
  system.store.close();
});

test('an excluded PR stays visible (with its health) in the state snapshot', async () => {
  const system = build();
  system.runtimeControl.apply({ excludedPrs: [42] });
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'feat', baseBranch: 'main' });
  system.connector.inject({ kind: 'ci_failed', prNumber: 42 });
  await system.harness.runCycle('manual');

  const snapshot = await buildStateSnapshot(system);
  const pr = snapshot.world.pullRequests.find((p) => p.number === 42);
  assert.ok(pr, 'the excluded PR is still surfaced in the cockpit');
  assert.equal(pr!.health.blocked, true, "its health is still computed so the operator sees why it's stuck");
  assert.deepEqual(snapshot.control.excludedPrs, [42]);
  system.store.close();
});

test('un-excluding a PR lets the harness pick it up again on the next cycle', async () => {
  const system = build();
  system.runtimeControl.apply({ excludedPrs: [42] });
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'feat', baseBranch: 'main' });
  system.connector.inject({ kind: 'ci_failed', prNumber: 42 });
  await system.harness.runCycle('manual');
  assert.equal(
    system.store.listTasks().some((t) => t.originRef === 'pr:42:ci'),
    false,
    'held while excluded',
  );

  // Operator resumes the harness on the PR (the cockpit "watch" toggle).
  system.runtimeControl.apply({ excludedPrs: [] });
  await system.harness.runCycle('manual');
  assert.equal(
    system.store.listTasks().some((t) => t.originRef === 'pr:42:ci'),
    true,
    'the CI-fix agent is dispatched once the PR is no longer excluded',
  );
  system.store.close();
});
