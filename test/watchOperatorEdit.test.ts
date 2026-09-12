import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeEnvironmentObserver, watchRow } from '../src/environments/fakeObserver.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { buildGoalPage } from '../web/src/view/goalPage.js';
import type { AppState } from '../web/src/types.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { GoalWatchInput } from '../src/types.js';

const TEST_UK: EnvironmentConfig = {
  name: 'testUk',
  at: 'echo unused',
  watch: { observe: './scripts/telemetry.sh testUk' },
};

const PLANNED: GoalWatchInput = {
  id: 'no-timeouts',
  seq: 1,
  kind: 'signal',
  title: 'Job X stops timing out',
  query: "traces | where message has 'job X timed out'",
  presence: "traces | where operation_Name == 'job X'",
  tolerate: 0,
  expectUnder: null,
  expectOver: null,
  expectBaseline: false,
  unit: null,
  why: null,
};

const ANSWERS = {
  'no-timeouts:presence': JSON.stringify([watchRow('no-timeouts', { runs: 96 })]),
  'no-timeouts:signal': JSON.stringify([watchRow('no-timeouts', { failures: 3 })]),
  'orders-p95:measure': JSON.stringify([watchRow('orders-p95', { value: 412 })]),
};

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-watch-edit-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    environments: [TEST_UK],
  });
  return buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    environmentObserver: new FakeEnvironmentObserver(ANSWERS),
    errorMirror: () => {},
  });
}

test('an operator writes a check, and it is live and read without anybody approving it', async () => {
  const system = build();
  const { app } = await buildApp(system);

  const res = await app.inject({
    method: 'PUT',
    url: '/api/issues/12/watch/checks/no-timeouts',
    payload: {
      kind: 'signal',
      id: 'no-timeouts',
      title: 'Job X stops timing out',
      query: "traces | where message has 'job X timed out'",
      presence: "traces | where operation_Name == 'job X'",
      tolerate: 0,
    },
  });
  assert.equal(res.statusCode, 200);

  const [check] = system.store.watches.listGoalWatches();
  assert.equal(check?.id, 'no-timeouts');
  assert.equal(check?.authored, 'operator');
  assert.deepEqual(system.store.watches.listProposedGoalWatches(), []);
  assert.equal(check?.dryRunEnvironment, 'testUk');
  assert.equal(check?.dryRunVerdict, 'fires');

  await app.close();
  system.store.close();
});

test('a signal without a presence query is refused, exactly as a plan document refuses it', async () => {
  const system = build();
  const { app } = await buildApp(system);

  const res = await app.inject({
    method: 'PUT',
    url: '/api/issues/12/watch/checks/no-timeouts',
    payload: {
      kind: 'signal',
      id: 'no-timeouts',
      title: 'Job X stops timing out',
      query: "traces | where message has 'job X timed out'",
      tolerate: 0,
    },
  });

  assert.equal(res.statusCode, 400);
  assert.deepEqual(system.store.watches.listGoalWatches(), []);
  await app.close();
  system.store.close();
});

test('a measure with nothing that could fail it is refused', async () => {
  const system = build();
  const { app } = await buildApp(system);

  const res = await app.inject({
    method: 'PUT',
    url: '/api/issues/12/watch/checks/orders-p95',
    payload: {
      kind: 'measure',
      id: 'orders-p95',
      title: 'The orders proc is no slower',
      query: 'requests | summarize value = percentile(duration, 95)',
      expect: {},
    },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
  system.store.close();
});

test('the body and the path must name the same check', async () => {
  const system = build();
  const { app } = await buildApp(system);

  const res = await app.inject({
    method: 'PUT',
    url: '/api/issues/12/watch/checks/no-timeouts',
    payload: {
      kind: 'signal',
      id: 'something-else',
      title: 'Job X stops timing out',
      query: 'traces',
      presence: 'traces',
      tolerate: 0,
    },
  });

  assert.equal(res.statusCode, 400);
  assert.deepEqual(system.store.watches.listGoalWatches(), []);
  await app.close();
  system.store.close();
});

test('a replan neither reverts an operator’s edit nor sweeps the check they wrote', async () => {
  const system = build();
  const { app } = await buildApp(system);
  system.store.watches.ingestGoalWatch('issue:12', [PLANNED]);

  await app.inject({
    method: 'PUT',
    url: '/api/issues/12/watch/checks/no-timeouts',
    payload: {
      kind: 'signal',
      id: 'no-timeouts',
      title: 'Job X stops timing out after retries',
      query: "traces | where message has 'job X exhausted retries'",
      presence: "traces | where operation_Name == 'job X'",
      tolerate: 0,
    },
  });
  await app.inject({
    method: 'PUT',
    url: '/api/issues/12/watch/checks/orders-p95',
    payload: {
      kind: 'measure',
      id: 'orders-p95',
      title: 'The orders proc is no slower than it was',
      query: 'requests | summarize value = percentile(duration, 95)',
      expect: { noWorseThan: 'baseline' },
      unit: 'ms',
    },
  });

  system.store.watches.ingestGoalWatch('issue:12', [PLANNED]);

  const checks = system.store.watches.listGoalWatches();
  assert.equal(checks.length, 2, 'the check the operator wrote is still here');
  const edited = checks.find((c) => c.id === 'no-timeouts');
  assert.equal(edited?.title, 'Job X stops timing out after retries', 'the edit stands');
  assert.match(edited!.query, /exhausted retries/);
  assert.equal(checks.find((c) => c.id === 'orders-p95')?.authored, 'operator');

  await app.close();
  system.store.close();
});

test('an edit keeps a measure’s baseline where the question did not change, and drops it where it did', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const measure = {
    kind: 'measure',
    id: 'orders-p95',
    title: 'The orders proc is no slower than it was',
    query: 'requests | summarize value = percentile(duration, 95)',
    expect: { noWorseThan: 'baseline' },
    unit: 'ms',
  };
  await app.inject({ method: 'PUT', url: '/api/issues/12/watch/checks/orders-p95', payload: measure });
  assert.equal(system.store.watches.listGoalWatches()[0]?.baselineValue, 412, 'the dry run took the before');

  await app.inject({
    method: 'PUT',
    url: '/api/issues/12/watch/checks/orders-p95',
    payload: { ...measure, title: 'Orders p95 has not regressed' },
  });
  assert.equal(system.store.watches.listGoalWatches()[0]?.baselineValue, 412, 'the same question keeps its answer');

  const saved = system.store.watches.saveOperatorWatch('issue:12', {
    ...system.store.watches.listGoalWatches()[0]!,
    query: 'requests | summarize value = percentile(duration, 99)',
  });
  assert.equal(saved.baselineValue, null, 'a reading is a reading of that query');
  assert.equal(saved.dryRunVerdict, null, 'and so is the dry run');

  await app.close();
  system.store.close();
});

test('a delete takes the check and its readings, and answers 404 for one that was never there', async () => {
  const system = build();
  const { app } = await buildApp(system);
  system.store.watches.ingestGoalWatch('issue:12', [PLANNED]);
  system.store.watches.recordWatchReading({
    goalRef: 'issue:12',
    environment: 'testUk',
    checkId: 'no-timeouts',
    verdict: 'clean',
    rows: 0,
    value: null,
    detail: null,
  });

  const gone = await app.inject({ method: 'DELETE', url: '/api/issues/12/watch/checks/no-timeouts' });
  assert.equal(gone.statusCode, 200);
  assert.deepEqual(system.store.watches.listGoalWatches(), []);
  assert.deepEqual(system.store.watches.listWatchReadings(), []);

  const again = await app.inject({ method: 'DELETE', url: '/api/issues/12/watch/checks/no-timeouts' });
  assert.equal(again.statusCode, 404);

  await app.close();
  system.store.close();
});

test('the goal page carries the declarations, an agent’s unruled one included', async () => {
  const system = build();
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Job X keeps timing out' });
  system.store.watches.ingestGoalWatch('issue:12', [PLANNED]);
  system.store.watches.proposeGoalWatch('issue:12', [{ ...PLANNED, id: 'retry-loop' }], 'The retry is the new signal.');

  await system.harness.runCycle();
  const page = buildGoalPage(buildStateSnapshot(system) as unknown as AppState, 'issue:12', []);

  assert.deepEqual(
    page?.signals.map((c) => `${c.id}:${String(c.live)}`),
    ['no-timeouts:true', 'retry-loop:false'],
  );
  system.store.close();
});
