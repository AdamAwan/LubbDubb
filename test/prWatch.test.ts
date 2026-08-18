import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { isPrWatched } from '../src/prHealth.js';
import { prsToSeedWatch } from '../src/prWatch.js';
import type { PullRequest } from '../src/types.js';
import { gitRepo } from './support/gitRepo.js';

function build(overrides: Partial<Config> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const config = loadConfig({
    // The cockpit guard is exercised in test/cockpitAuth.test.ts; these drive routes.
    auth: { enabled: false } as never,
    dbPath: ':memory:',
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
// Pure predicates
// --------------------------------------------------------------------------

test('isPrWatched: true only when the PR carries the configured tag', () => {
  assert.equal(isPrWatched(pr({ labels: ['lubbdubb-watch'] }), 'lubbdubb-watch'), true);
  assert.equal(isPrWatched(pr({ labels: ['other'] }), 'lubbdubb-watch'), false);
  assert.equal(isPrWatched(pr({ labels: [] }), 'lubbdubb-watch'), false);
  assert.equal(isPrWatched(pr({}), 'lubbdubb-watch'), false, 'missing labels is treated as none');
  assert.equal(isPrWatched(pr({ labels: [] }), ''), true, 'an empty tag disables the gate');
});

test('prsToSeedWatch: only the harness’s own untagged pull requests', () => {
  const ctx = { watchLabel: 'lubbdubb-watch', legacyIgnoreLabel: 'lubbdubb-ignore', seeded: new Set<number>() };
  const seeds = prsToSeedWatch(
    [
      pr({ number: 1, branch: 'issue/12' }),
      pr({ number: 2, branch: 'issue/12/store' }),
      pr({ number: 3, branch: 'job/abc' }),
      pr({ number: 4, branch: 'someone-elses-work' }),
      pr({ number: 5, branch: 'issue/13', labels: ['lubbdubb-watch'] }),
      pr({ number: 6, branch: 'issue/14', labels: ['lubbdubb-ignore'] }),
      pr({ number: 7, branch: 'issue/15', state: 'merged', merged: true }),
    ],
    ctx,
  );
  assert.deepEqual(
    seeds.map((s) => s.prNumber),
    [1, 2, 3],
    'every dispatch branch shape, and nothing else',
  );

  assert.deepEqual(prsToSeedWatch([pr({ number: 1, branch: 'issue/12' })], { ...ctx, seeded: new Set([1]) }), []);
  assert.deepEqual(prsToSeedWatch([pr({ number: 1, branch: 'issue/12' })], { ...ctx, watchLabel: '' }), []);
});

// --------------------------------------------------------------------------
// Harness behaviour
// --------------------------------------------------------------------------

test('a PR carrying no watch tag is left alone by the dispatcher', async () => {
  const system = build();
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'feat' });
  system.connector.inject({ kind: 'ci_failed', prNumber: 42 });
  await system.harness.runCycle('manual');

  assert.equal(
    system.store.listTasks().some((t) => t.originRef === 'pr:42:ci'),
    false,
    'no CI-fix agent is dispatched for an untagged PR',
  );
  system.store.close();
});

test('an unwatched PR stays visible (with its health) in the state snapshot', async () => {
  const system = build();
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'feat' });
  system.connector.inject({ kind: 'ci_failed', prNumber: 42 });
  await system.harness.runCycle('manual');

  const snapshot = await buildStateSnapshot(system);
  const found = snapshot.world.pullRequests.find((p) => p.number === 42);
  assert.ok(found, 'the unwatched PR is still surfaced in the cockpit');
  assert.equal(found!.health.blocked, true, "its health is still computed so the operator sees why it's stuck");
  assert.equal(found!.attention.status, 'unwatched');
  assert.equal(snapshot.config.watchLabel, 'lubbdubb-watch');
  system.store.close();
});

test('tagging a PR via the sink lets the harness in; untagging stops it', async () => {
  const system = build();
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'feat' });
  system.connector.inject({ kind: 'ci_failed', prNumber: 42 });

  await system.harness.runCycle('manual');
  assert.equal(
    system.store.listTasks().some((t) => t.originRef === 'pr:42:ci'),
    false,
    'held while untagged',
  );

  await system.connector.setPrLabel({ prNumber: 42, label: 'lubbdubb-watch', present: true });
  await system.harness.runCycle('manual');
  assert.equal(
    system.store.listTasks().some((t) => t.originRef === 'pr:42:ci'),
    true,
    'the CI-fix agent is dispatched once the tag is on',
  );
  system.store.close();
});

// --------------------------------------------------------------------------
// The harness tags its own work
// --------------------------------------------------------------------------

test('a PR on a dispatch branch is tagged by the harness, once', async () => {
  const system = build();
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'issue/7' });
  await system.harness.runCycle('manual');

  const world = await system.connector.getState();
  const found = world.pullRequests.find((p) => p.number === 42);
  assert.deepEqual(found?.labels, ['lubbdubb-watch'], 'the harness tagged its own pull request');
  assert.ok(system.store.seededPrs().has(42), 'and recorded that it has answered for it');

  // The operator takes it back off. The next pulse must not write it back — a
  // control that undoes itself is the whole reason the seed row exists.
  await system.connector.setPrLabel({ prNumber: 42, label: 'lubbdubb-watch', present: false });
  await system.harness.runCycle('manual');
  const after = (await system.connector.getState()).pullRequests.find((p) => p.number === 42);
  assert.deepEqual(after?.labels, [], 'un-watching sticks');
  system.store.close();
});

test('a PR carrying the retired ignore tag is never seeded', async () => {
  const system = build();
  system.connector.inject({
    kind: 'new_pr',
    number: 42,
    title: 'X',
    branch: 'issue/7',
    labels: ['lubbdubb-ignore'],
  });
  await system.harness.runCycle('manual');

  const found = (await system.connector.getState()).pullRequests.find((p) => p.number === 42);
  assert.deepEqual(found?.labels, ['lubbdubb-ignore'], 'the operator’s old "leave this alone" is not overwritten');
  assert.equal(system.store.seededPrs().has(42), false);
  system.store.close();
});

// --------------------------------------------------------------------------
// Endpoint (the cockpit toggle)
// --------------------------------------------------------------------------

test('POST /api/prs/:n/watch tags the PR, which the snapshot and harness both honour', async () => {
  const system = build();
  const { app } = await buildApp(system);
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'feat' });
  system.connector.inject({ kind: 'ci_failed', prNumber: 42 });

  const res = await app.inject({ method: 'POST', url: '/api/prs/42/watch', payload: { watched: true } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().watched, true);

  const state = await (await app.inject({ method: 'GET', url: '/api/state' })).json();
  const found = state.world.pullRequests.find((p: { number: number }) => p.number === 42);
  assert.deepEqual(found.labels, ['lubbdubb-watch'], 'the toggle set the tag on the PR');
  assert.equal(
    system.store.listTasks().some((t) => t.originRef === 'pr:42:ci'),
    true,
    'the tagged PR is acted on',
  );

  // Toggle it back off.
  await app.inject({ method: 'POST', url: '/api/prs/42/watch', payload: { watched: false } });
  const cleared = await (await app.inject({ method: 'GET', url: '/api/state' })).json();
  const still = cleared.world.pullRequests.find((p: { number: number }) => p.number === 42);
  assert.deepEqual(still.labels, [], 'the tag was removed');

  await app.close();
  system.store.close();
});

test('un-watching through the route stops the seeding desk answering again', async () => {
  const system = build();
  const { app } = await buildApp(system);
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'issue/7', labels: ['lubbdubb-watch'] });

  // Tagged by hand before the harness ever saw it, so there is no seed row yet.
  await app.inject({ method: 'POST', url: '/api/prs/42/watch', payload: { watched: false } });
  await system.harness.runCycle('manual');

  const found = (await system.connector.getState()).pullRequests.find((p) => p.number === 42);
  assert.deepEqual(found?.labels, [], 'the operator’s answer outranks the seeder');

  await app.close();
  system.store.close();
});

test('POST /api/prs/:n/watch rejects a non-boolean body with 400', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'POST', url: '/api/prs/42/watch', payload: { watched: 'yes' } });
  assert.equal(res.statusCode, 400);
  await app.close();
  system.store.close();
});
