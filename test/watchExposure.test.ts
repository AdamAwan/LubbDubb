import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeEnvironmentObserver, watchRow } from '../src/environments/fakeObserver.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { EXPOSURE_ECHO_COLUMN, exposureShortfall, parseExposure } from '../src/environments/exposure.js';
import { validateEnvironments, type EnvironmentConfig } from '../src/environments/policy.js';
import { watchDeclareNote, watchNote } from '../src/plans/planning.js';
import type { GoalWatchInput } from '../src/types.js';

const HOUR = 60 * 60 * 1000;

const STAGED: EnvironmentConfig = {
  name: 'liveUk',
  at: 'echo unused',
  watch: {
    observe: './scripts/telemetry.sh uk',
    forMs: 48 * HOUR,
    exposure: { command: './scripts/exposure.sh uk', atLeast: 0.9 },
  },
};

const SIGNAL: GoalWatchInput = {
  id: 'no-timeouts',
  seq: 1,
  kind: 'signal',
  title: 'Job X stops timing out',
  query: "traces | where timestamp > datetime({since}) | where message has 'job X timed out'",
  presence: "traces | where timestamp > datetime({since}) | where operation_Name == 'job X'",
  tolerate: 0,
  expectUnder: null,
  expectOver: null,
  expectBaseline: false,
  unit: null,
  why: null,
};

const STILL_FAILING = {
  'no-timeouts:presence': JSON.stringify([watchRow('no-timeouts', { runs: 96 })]),
  'no-timeouts:signal': JSON.stringify([watchRow('no-timeouts', { tenant: 'old-build' })]),
};

function build(observer: FakeEnvironmentObserver): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-watch-exposure-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    environmentProbeIntervalMs: 5 * 60 * 1000,
    watchIntervalMs: 1,
    environments: [STAGED],
  });
  return buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    environmentObserver: observer,
    environmentProber: new FakeEnvironmentProber(),
    gitObserver: new FakeGitObserver(),
    errorMirror: () => {},
  });
}

function arrived(system: System): void {
  system.store.watches.ingestGoalWatch('issue:12', [SIGNAL]);
  system.store.environments.recordGoalLanding({ prNumber: 4, goalRef: 'issue:12', sha: 'abc' });
  system.store.environments.recordGoalLanding({ prNumber: 5, goalRef: 'issue:12', sha: 'def' });
  system.store.environments.recordGoalArrival({
    goalRef: 'issue:12',
    environment: 'liveUk',
    arrivedAt: new Date(Date.now() - 60_000).toISOString(),
  });
}

test('below the exposure floor a reading is unknown, and the old build is never asked about', async () => {
  const observer = new FakeEnvironmentObserver(STILL_FAILING);
  observer.exposureOutput = 0.25;
  const system = build(observer);
  arrived(system);

  await system.harness.runCycle();

  assert.deepEqual(observer.exposureAsked, [{ environment: 'liveUk', commits: ['abc', 'def'] }]);
  assert.deepEqual(observer.asked, [], 'no query is put to traffic that does not run the change');
  const [reading] = system.store.watches.listWatchReadings();
  assert.equal(reading?.verdict, 'unknown', 'never regressed on tenants that have not upgraded');
  assert.match(reading!.detail!, /25% of liveUk/);
  assert.deepEqual(system.store.humanTasks.listHumanTasksOfKind('watch'), [], 'unknown files no bench row');
  const [window] = system.store.watches.listWatchWindows();
  assert.equal(window?.exposedAt, null);
  assert.ok(
    Date.parse(window!.settlesAt) - Date.parse(window!.openedAt) > 48 * HOUR,
    'an unexposed window waits for the rollout rather than running out at forMs',
  );
  system.store.close();
});

test('clearing the floor restarts the window from exposure, and queries carry the commits and that instant', async () => {
  const observer = new FakeEnvironmentObserver({
    'no-timeouts:presence': JSON.stringify([watchRow('no-timeouts', { runs: 96 })]),
    'no-timeouts:signal': '[]',
  });
  observer.exposureOutput = 0.25;
  const system = build(observer);
  arrived(system);
  await system.harness.runCycle();

  observer.exposureOutput = 0.95;
  await new Promise((r) => setTimeout(r, 5));
  const before = Date.now();
  await system.harness.runCycle();

  const [window] = system.store.watches.listWatchWindows();
  assert.notEqual(window?.exposedAt, null);
  assert.ok(Date.parse(window!.exposedAt!) >= before);
  assert.equal(Date.parse(window!.settlesAt) - Date.parse(window!.exposedAt!), 48 * HOUR);
  assert.deepEqual(
    observer.asked.map((a) => [a.kind, a.since, a.commits?.join(' ')]),
    [
      ['presence', window!.exposedAt, 'abc def'],
      ['signal', window!.exposedAt, 'abc def'],
    ],
  );
  const newest = system.store.watches.listWatchReadings().at(-1);
  assert.equal(newest?.verdict, 'clean');
  system.store.close();
});

test('an exposure probe that cannot say reads unknown, never clean', async () => {
  const observer = new FakeEnvironmentObserver(STILL_FAILING);
  observer.exposureOutput = JSON.stringify({ share: 1 });
  const system = build(observer);
  arrived(system);

  await system.harness.runCycle();

  assert.deepEqual(observer.asked, []);
  const [reading] = system.store.watches.listWatchReadings();
  assert.equal(reading?.verdict, 'unknown');
  assert.match(reading!.detail!, /without the commits it was asked about/);
  system.store.close();
});

test('the exposure output contract', () => {
  const echo = { [EXPOSURE_ECHO_COLUMN]: 'abc def' };
  assert.deepEqual(parseExposure(JSON.stringify({ ...echo, share: 0.5 }), ['abc', 'def']), {
    share: 0.5,
    detail: null,
  });
  assert.equal(parseExposure(JSON.stringify({ ...echo, share: 50 }), ['abc', 'def']).share, null);
  assert.equal(parseExposure('0.5', ['abc', 'def']).share, null);
  assert.equal(parseExposure('', ['abc']).share, null);
  assert.equal(exposureShortfall('liveUk', { share: 0.9, detail: null }, 0.9), null);
  assert.notEqual(exposureShortfall('liveUk', { share: null, detail: 'x' }, 0.1), null);
});

test('config refuses an exposure block that could never gate anything', () => {
  const bad = (exposure: unknown): void =>
    validateEnvironments([
      { name: 'liveUk', at: 'echo unused', watch: { observe: './t.sh', exposure } } as unknown as EnvironmentConfig,
    ]);
  assert.throws(() => bad({ command: '' }), /exposure\.command/);
  assert.throws(() => bad({ command: './e.sh', atLeast: 0 }), /exposure\.atLeast/);
  assert.throws(() => bad({ command: './e.sh', atLeast: 90 }), /exposure\.atLeast/);
  assert.throws(() => bad({ command: './e.sh', waitMs: -1 }), /exposure\.waitMs/);
  assert.doesNotThrow(() => bad({ command: './e.sh' }));
});

test('planners are told to scope every query on a staged environment, and only there', () => {
  for (const note of [watchNote, watchDeclareNote]) {
    assert.match(note([STAGED]), /Staged rollout on liveUk/);
    assert.match(note([STAGED]), /signal, measure and presence alike/);
    assert.doesNotMatch(note([{ name: 'testUk', watch: { observe: './t.sh' } } as never]), /Staged rollout/);
  }
});
