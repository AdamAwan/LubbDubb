import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { buildApp, buildStateSnapshot } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { isPrExcluded } from '../src/prHealth.js';
import type { PullRequest } from '../src/types.js';

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

function build(overrides: Partial<Config> = {}) {
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
    ...overrides,
  });
  return buildSystem(config, { backend: new FakePtyBackend() });
}

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  id: 'p',
  number: 1,
  title: 'X',
  branch: 'feat',
  ciStatus: 'failing',
  unresolvedComments: [],
  ...over,
});

// --------------------------------------------------------------------------
// Pure predicate
// --------------------------------------------------------------------------

test('isPrExcluded: true only when the PR carries the configured tag', () => {
  assert.equal(isPrExcluded(pr({ labels: ['lubbdubb-ignore'] }), 'lubbdubb-ignore'), true);
  assert.equal(isPrExcluded(pr({ labels: ['other'] }), 'lubbdubb-ignore'), false);
  assert.equal(isPrExcluded(pr({ labels: [] }), 'lubbdubb-ignore'), false);
  assert.equal(isPrExcluded(pr({}), 'lubbdubb-ignore'), false, 'missing labels is treated as none');
  assert.equal(isPrExcluded(pr({ labels: ['lubbdubb-ignore'] }), ''), false, 'an empty tag disables the gate');
});

// --------------------------------------------------------------------------
// Harness behaviour
// --------------------------------------------------------------------------

test('a PR tagged with the exclusion label is left alone by the dispatcher', async () => {
  const system = build();
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'feat', labels: ['lubbdubb-ignore'] });
  system.connector.inject({ kind: 'ci_failed', prNumber: 42 });
  await system.harness.runCycle('manual');

  assert.equal(
    system.store.listTasks().some((t) => t.originRef === 'pr:42:ci'),
    false,
    'no CI-fix agent is dispatched for a tagged PR',
  );
  system.store.close();
});

test('an excluded PR stays visible (with its health and tag) in the state snapshot', async () => {
  const system = build();
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'feat', labels: ['lubbdubb-ignore'] });
  system.connector.inject({ kind: 'ci_failed', prNumber: 42 });
  await system.harness.runCycle('manual');

  const snapshot = await buildStateSnapshot(system);
  const found = snapshot.world.pullRequests.find((p) => p.number === 42);
  assert.ok(found, 'the excluded PR is still surfaced in the cockpit');
  assert.equal(found!.health.blocked, true, "its health is still computed so the operator sees why it's stuck");
  assert.deepEqual(found!.labels, ['lubbdubb-ignore']);
  assert.equal(snapshot.config.prExclusionLabel, 'lubbdubb-ignore');
  system.store.close();
});

test('tagging a PR via the sink stops the harness; untagging lets it back in', async () => {
  const system = build();
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'feat' });
  system.connector.inject({ kind: 'ci_failed', prNumber: 42 });

  // Tag it before the first cycle — the harness leaves it alone.
  await system.connector.setPrLabel({ prNumber: 42, label: 'lubbdubb-ignore', present: true });
  await system.harness.runCycle('manual');
  assert.equal(
    system.store.listTasks().some((t) => t.originRef === 'pr:42:ci'),
    false,
    'held while tagged',
  );

  // Untag it — the next cycle dispatches the CI-fix agent.
  await system.connector.setPrLabel({ prNumber: 42, label: 'lubbdubb-ignore', present: false });
  await system.harness.runCycle('manual');
  assert.equal(
    system.store.listTasks().some((t) => t.originRef === 'pr:42:ci'),
    true,
    'the CI-fix agent is dispatched once the tag is removed',
  );
  system.store.close();
});

// --------------------------------------------------------------------------
// Endpoint (the cockpit toggle)
// --------------------------------------------------------------------------

test('POST /api/prs/:n/exclude tags the PR, which the snapshot and harness both honour', async () => {
  const system = build();
  const { app } = await buildApp(system);
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'feat' });
  system.connector.inject({ kind: 'ci_failed', prNumber: 42 });

  const res = await app.inject({ method: 'POST', url: '/api/prs/42/exclude', payload: { excluded: true } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().excluded, true);

  const state = await (await app.inject({ method: 'GET', url: '/api/state' })).json();
  const found = state.world.pullRequests.find((p: { number: number }) => p.number === 42);
  assert.deepEqual(found.labels, ['lubbdubb-ignore'], 'the toggle set the tag on the PR');
  assert.equal(
    system.store.listTasks().some((t) => t.originRef === 'pr:42:ci'),
    false,
    'the tagged PR is not acted on',
  );

  // Toggle it back off.
  await app.inject({ method: 'POST', url: '/api/prs/42/exclude', payload: { excluded: false } });
  const cleared = await (await app.inject({ method: 'GET', url: '/api/state' })).json();
  const still = cleared.world.pullRequests.find((p: { number: number }) => p.number === 42);
  assert.deepEqual(still.labels, [], 'the tag was removed');

  await app.close();
  system.store.close();
});

test('POST /api/prs/:n/exclude rejects a non-boolean body with 400', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'POST', url: '/api/prs/42/exclude', payload: { excluded: 'yes' } });
  assert.equal(res.statusCode, 400);
  await app.close();
  system.store.close();
});
