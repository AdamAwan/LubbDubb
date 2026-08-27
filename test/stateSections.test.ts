import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { buildStateSections, buildStateSnapshot, STATE_SECTIONS } from '../src/server/stateSnapshot.js';
import type { StateSection } from '../src/wire.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

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

/**
 * **The one that matters.** The sections are a partition of `CockpitState`, and
 * the failure mode of a partition that has drifted is silent: a key added to the
 * wire and to no section is simply never shipped, on every snapshot, and the
 * surface that draws it renders whatever `undefined` renders as. Nothing is red —
 * the payload still validates and the cockpit still starts.
 *
 * Asserted against a **built** snapshot rather than a hand-written key list, so
 * the list cannot be the thing that goes stale.
 */
test('every key a full snapshot ships belongs to exactly one section', () => {
  const system = build();
  const full = buildStateSnapshot(system);
  const everyKey = new Set(Object.keys(full));

  const seen = new Map<string, StateSection>();
  for (const section of STATE_SECTIONS) {
    for (const key of Object.keys(buildStateSections(system, new Set([section])))) {
      // `refUrls` rides every response deliberately — it is the map every other
      // section's links resolve in, so it is the one key that is in all of them.
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

  // The values are the same ones a full build produces: sectioning is a narrowing
  // of what is assembled, never a second opinion about what a key means.
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

  // Refused rather than ignored: a typo that quietly answers less is a surface
  // that quietly stops updating, which is the whole failure this route prevents.
  const typo = await app.inject({ method: 'GET', url: '/api/state?sections=fleet,goels' });
  assert.equal(typo.statusCode, 400);
  assert.match((typo.json() as { error: string }).error, /goels/);

  system.store.close();
});

/**
 * A patch merged over a held snapshot has to leave the rest of it alone — that is
 * the whole reason the cockpit can keep one complete `AppState` and no component
 * has to learn about partiality. Asserted here rather than in the browser because
 * it is a property of what the server ships.
 */
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
