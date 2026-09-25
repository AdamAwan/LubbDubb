import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem } from '../src/system/system.js';
import { buildApp } from '../src/server/app.js';
import { buildStateSections, buildStateSnapshot, STATE_SECTIONS } from '../src/server/stateSnapshot.js';
import type { StateSection } from '../src/wire.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { failPlanningOpen } from './support/plans.js';

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
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

test('every key a full snapshot ships belongs to exactly one section', () => {
  const system = build();
  const full = buildStateSnapshot(system);
  const everyKey = new Set(Object.keys(full));

  const seen = new Map<string, StateSection>();
  for (const section of STATE_SECTIONS) {
    for (const key of Object.keys(buildStateSections(system, new Set([section])))) {
      if (key === 'refUrls') continue;
      const already = seen.get(key);
      assert.equal(already, undefined, `${key} is in both '${already}' and '${section}' — sections must not overlap`);
      seen.set(key, section);
    }
  }

  for (const key of everyKey) {
    if (key === 'refUrls') continue;
    assert.ok(seen.has(key), `${key} is shipped by a full snapshot but belongs to no section — it would never arrive`);
  }
  for (const key of seen.keys()) {
    assert.ok(everyKey.has(key), `${key} is claimed by a section but is not on a full snapshot`);
  }

  system.store.close();
});

test('a sectioned build answers those sections and nothing else, plus refUrls', () => {
  const system = build();
  const patch = buildStateSections(system, new Set<StateSection>(['control', 'activity']));

  assert.deepEqual(
    Object.keys(patch).sort(),
    ['control', 'decisions', 'errors', 'refUrls', 'worldEvents'].sort(),
    'the goal enrichment, the fleet and the plan graph are not built at all',
  );

  const full = buildStateSnapshot(system);
  assert.deepEqual(patch.control, full.control);
  assert.deepEqual(patch.errors, full.errors);

  system.store.close();
});

test('GET /api/state answers the whole snapshot bare, and the named parts with ?sections', async () => {
  const system = build();
  const { app } = await buildApp(system);

  const whole = await app.inject({ method: 'GET', url: '/api/state' });
  assert.equal(whole.statusCode, 200);
  assert.ok(Object.keys(whole.json() as object).length > 40, 'a bare call is still the whole snapshot');

  const part = await app.inject({ method: 'GET', url: '/api/state?sections=fleet' });
  assert.equal(part.statusCode, 200);
  const keys = Object.keys(part.json() as object);
  assert.ok(keys.includes('agents') && keys.includes('overlaps'));
  assert.ok(!keys.includes('world'), 'a fleet fetch does not rebuild the goals');

  const typo = await app.inject({ method: 'GET', url: '/api/state?sections=fleet,goels' });
  assert.equal(typo.statusCode, 400);
  assert.match((typo.json() as { error: string }).error, /goels/);

  system.store.close();
});

test('a section patch overlaid on a full snapshot changes only that section', () => {
  const system = build();
  const full = buildStateSnapshot(system);
  const patch = buildStateSections(system, new Set<StateSection>(['fleet']));
  const merged = { ...full, ...patch, refUrls: { ...full.refUrls, ...patch.refUrls } };

  for (const key of Object.keys(full) as (keyof typeof full)[]) {
    assert.deepEqual(merged[key], full[key], `${key} survived the merge unchanged`);
  }

  system.store.close();
});

test('a section asked for alone answers exactly what a full snapshot answers for it', async () => {
  const system = build();
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'feat/x' });
  system.connector.inject({ kind: 'new_issue', number: 13, title: 'Bug' });
  failPlanningOpen(system.store, 13);
  system.store.tasks.createTask({
    kind: 'code',
    title: 'Resolve issue #13',
    prompt: 'p',
    branch: 'issue/13',
    originRef: 'issue:13',
  });
  system.store.world.recordWorldEvents([{ kind: 'pr_merged', ref: 'pr:91', summary: 'PR #91 merged' }]);
  system.store.world.setWorldBaseline(await system.connector.getState());

  const full = buildStateSnapshot(system) as unknown as Record<string, unknown>;
  for (const section of STATE_SECTIONS) {
    const patch = buildStateSections(system, new Set([section])) as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      // `build` carries the moment it was read, so two reads of it never compare equal.
      if (key === 'refUrls' || key === 'build') continue;
      assert.deepEqual(value, full[key], `${key} differs when only '${section}' is asked for`);
    }
  }

  system.store.close();
});
