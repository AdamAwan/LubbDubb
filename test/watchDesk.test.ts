import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeEnvironmentObserver, watchRow } from '../src/environments/fakeObserver.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { buildGoalPage, buildGoalStrip } from '../web/src/view/goalPage.js';
import type { AppState } from '../web/src/types.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import type { GoalWatchInput } from '../src/types.js';

/**
 * The window pass at the `buildSystem` seam, with `dbPath: ':memory:'` and both
 * environment fakes injected. Nothing here spawns a shell or touches a network.
 *
 * The two that earn their place first are the silences: an arrival the harness
 * merely discovered opening nothing, and a presence query answering zero reading
 * `unknown` all the way to the words on the goal page — the one case that reads as
 * success.
 */

const PROBE_MS = 5 * 60 * 1000;

const TEST_UK: EnvironmentConfig = {
  name: 'testUk',
  at: 'echo unused',
  watch: { observe: './scripts/telemetry.sh testUk' },
};
const LIVE_UK: EnvironmentConfig = {
  name: 'liveUk',
  at: 'echo unused',
  watch: { observe: './scripts/telemetry.sh uk' },
};

const SIGNAL: GoalWatchInput = {
  id: 'no-timeouts',
  seq: 1,
  kind: 'signal',
  title: 'Job X stops timing out',
  query: "traces | where message has 'job X timed out'",
  presence: "traces | where operation_Name == 'job X'",
  tolerate: 0,
  why: null,
};

function build(
  observer: FakeEnvironmentObserver,
  environments: EnvironmentConfig[] = [TEST_UK],
  probed?: { prober: FakeEnvironmentProber; git: FakeGitObserver },
): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-watch-desk-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    environmentProbeIntervalMs: PROBE_MS,
    environments,
  });
  return buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    environmentObserver: observer,
    environmentProber: probed?.prober ?? new FakeEnvironmentProber(),
    gitObserver: probed?.git ?? new FakeGitObserver(),
    errorMirror: () => {},
  });
}

/** A goal that declared one signal, and whose whole work has just arrived somewhere. */
function arrived(system: System, environment: string, agoMs = 60_000, checks: GoalWatchInput[] = [SIGNAL]): void {
  system.store.ingestGoalWatch('issue:12', checks);
  system.store.recordGoalArrival({
    goalRef: 'issue:12',
    environment,
    arrivedAt: new Date(Date.now() - agoMs).toISOString(),
  });
}

/** A presence query that answers and a check query that does not match — a clean reading. */
const CLEAN = {
  'no-timeouts:presence': JSON.stringify([watchRow('no-timeouts', { runs: 96 })]),
  'no-timeouts:signal': '[]',
};

test('an arrival opens a window, and the harness reads it', async () => {
  const observer = new FakeEnvironmentObserver(CLEAN);
  const system = build(observer);
  arrived(system, 'testUk');

  await system.harness.runCycle();

  const [window] = system.store.listWatchWindows();
  assert.equal(window?.environment, 'testUk');
  assert.equal(window?.settledAt, null, 'still watching');
  const [reading] = system.store.listWatchReadings();
  assert.equal(reading?.verdict, 'clean');
  assert.equal(reading?.rows, 0);
  assert.notEqual(system.store.listGoalArrivals()[0]?.watchedAt, null, 'considered, and stamped');
  system.store.close();
});

test('an arrival three probe intervals old opens no window, and is stamped anyway', async () => {
  // The first pulse after this ships finds every goal already in every environment.
  // Without the guard each one opens a window; without the stamp each opens one
  // again on every pulse after that, forever, and nothing goes red.
  const observer = new FakeEnvironmentObserver(CLEAN);
  const system = build(observer);
  arrived(system, 'testUk', PROBE_MS * 3);

  await system.harness.runCycle();
  await system.harness.runCycle();

  assert.deepEqual(system.store.listWatchWindows(), []);
  assert.deepEqual(observer.asked, [], 'nothing is asked about work that shipped in March');
  assert.notEqual(
    system.store.listGoalArrivals()[0]?.watchedAt,
    null,
    'stamped anyway, so the next arrival is the first one watched rather than the whole history at once',
  );
  system.store.close();
});

test('presence answering zero reads unknown on the glass, in the goal page’s own words', async () => {
  // The case that reads as success: an acceptance environment where the scheduled
  // job does not run, the queue is empty and no real traffic arrives. End to end
  // from the probe that confirms the landing, so the arrival the window opens on is
  // one this harness genuinely watched happen.
  const observer = new FakeEnvironmentObserver({ 'no-timeouts:presence': '[]', 'no-timeouts:signal': '[]' });
  const system = build(observer, [TEST_UK], {
    prober: new FakeEnvironmentProber({ testUk: ['head-testUk'] }),
    git: new FakeGitObserver().setContains('head-testUk', 'abc', true),
  });
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Job X keeps timing out' });
  system.store.recordGoalLanding({ prNumber: 1, goalRef: 'issue:12', sha: 'abc' });
  system.store.ingestGoalWatch('issue:12', [SIGNAL]);

  await system.harness.runCycle();

  assert.equal(system.store.listWatchReadings()[0]?.verdict, 'unknown', 'never folded into clean');
  const page = buildGoalPage(buildStateSnapshot(system) as unknown as AppState, 'issue:12', []);
  const check = page?.watches[0]?.checks[0];
  assert.equal(check?.reading?.verdict, 'unknown');
  assert.match(check!.reading!.detail!, /could not read testUk/);
  assert.match(check!.reading!.detail!, /has not run here/);
  // And the strip folds it off the card rather than computing a second verdict, in
  // words that are never a clean one's.
  const shipped = buildGoalStrip(page!).find((s) => s.at === 'environments');
  assert.equal(shipped?.reading, 'reached testUk · watch not read');
  // The check's own query is not even asked: whatever it would say about a code
  // path the telemetry has never heard of is not a reading.
  assert.deepEqual(
    observer.asked.map((a) => a.kind),
    ['presence'],
  );
  system.store.close();
});

test('a goal with no declared checks reads null and draws nothing', async () => {
  const observer = new FakeEnvironmentObserver(CLEAN);
  const system = build(observer);
  system.store.recordGoalArrival({
    goalRef: 'issue:12',
    environment: 'testUk',
    arrivedAt: new Date().toISOString(),
  });

  await system.harness.runCycle();

  assert.deepEqual(system.store.listWatchWindows(), [], 'not an empty card, not a row of question marks');
  assert.deepEqual(buildStateSnapshot(system).goalWatchWindows, []);
  assert.deepEqual(observer.asked, []);
  system.store.close();
});

test('nothing is asked where no environment declares a watch, and no arrival is spent', async () => {
  const observer = new FakeEnvironmentObserver(CLEAN);
  const system = build(observer, [{ name: 'testUk', at: 'echo unused' }]);
  arrived(system, 'testUk');

  await system.harness.runCycle();

  assert.deepEqual(system.store.listWatchWindows(), []);
  assert.equal(
    system.store.listGoalArrivals()[0]?.watchedAt,
    null,
    'the stamp is the one guard that makes turning the feature on later safe — it is not spent while it is off',
  );
  assert.deepEqual(buildStateSnapshot(system).goalWatchWindows, []);
  system.store.close();
});

test('a watch opens per environment, so a goal travelling is watched twice with separate readings', async () => {
  // testUk answers zero to everything, which is what an acceptance environment
  // where the job does not run answers; liveUk is where the answer is.
  const observer = new FakeEnvironmentObserver({
    'no-timeouts:presence': JSON.stringify([watchRow('no-timeouts', { runs: 96 })]),
    'no-timeouts:signal': '[]',
  });
  const system = build(observer, [TEST_UK, LIVE_UK]);
  arrived(system, 'testUk');
  system.store.recordGoalArrival({
    goalRef: 'issue:12',
    environment: 'liveUk',
    arrivedAt: new Date().toISOString(),
  });

  await system.harness.runCycle();

  assert.deepEqual(
    system.store
      .listWatchWindows()
      .map((w) => w.environment)
      .sort(),
    ['liveUk', 'testUk'],
  );
  assert.deepEqual(
    system.store
      .listWatchReadings()
      .map((r) => r.environment)
      .sort(),
    ['liveUk', 'testUk'],
    'separate readings — the two environments are not one question asked twice',
  );
  assert.deepEqual(observer.asked.map((a) => a.environment).sort(), ['liveUk', 'liveUk', 'testUk', 'testUk']);
  system.store.close();
});

test('a regressed reading says what it expected and what it read, and does not roll up', async () => {
  const observer = new FakeEnvironmentObserver({
    'no-timeouts:presence': JSON.stringify([watchRow('no-timeouts', { runs: 96 })]),
    'no-timeouts:signal': JSON.stringify([watchRow('no-timeouts', { role: 'worker' })]),
  });
  const system = build(observer);
  arrived(system, 'testUk', 60_000, [SIGNAL, { ...SIGNAL, id: 'no-retries', seq: 2, presence: null }]);

  await system.harness.runCycle();

  const readings = new Map(system.store.listWatchReadings().map((r) => [r.checkId, r]));
  assert.equal(readings.get('no-timeouts')?.verdict, 'regressed');
  assert.match(readings.get('no-timeouts')!.detail!, /answered 1 row where the check declared none at all/);
  // The second check answered nothing scripted, so it could not be read — and the
  // window is not one word: a goal whose one check passed and whose other failed
  // is a fix that worked and a thing that is still broken.
  assert.equal(readings.get('no-retries')?.verdict, 'unknown');
  const [window] = buildStateSnapshot(system).goalWatchWindows;
  assert.deepEqual(
    window?.checks.map((c) => c.reading?.verdict),
    ['regressed', 'unknown'],
  );
  system.store.close();
});

test('a settled watch is not re-opened by a later reading', async () => {
  const observer = new FakeEnvironmentObserver(CLEAN);
  const system = build(observer, [{ ...TEST_UK, watch: { ...TEST_UK.watch!, forMs: 1 } }]);
  arrived(system, 'testUk');

  // The window settles the moment it opens: `forMs` is one millisecond, so it is
  // already past its own end when the settle pass runs.
  await system.harness.runCycle();
  const settledAt = system.store.listWatchWindows()[0]?.settledAt;
  assert.notEqual(settledAt, null, 'settled at `for`');
  assert.deepEqual(observer.asked, [], 'settling runs before the readings, so nothing is read past the end');

  await system.harness.runCycle();
  assert.equal(system.store.listWatchWindows()[0]?.settledAt, settledAt, 'a record, not a monitor');
  assert.deepEqual(system.store.listWatchReadings(), []);
  system.store.close();
});

test('a window is not read again inside watchIntervalMs, and the arrival opens only one', async () => {
  const observer = new FakeEnvironmentObserver(CLEAN);
  const system = build(observer);
  arrived(system, 'testUk');

  await system.harness.runCycle();
  await system.harness.runCycle();

  assert.equal(system.store.listWatchWindows().length, 1, 'arriving again is not a second window');
  assert.equal(system.store.listWatchReadings().length, 1, 'nothing is asked when nothing is due');
  system.store.close();
});

test('a check an amendment stopped declaring takes its readings with it', async () => {
  const observer = new FakeEnvironmentObserver(CLEAN);
  const system = build(observer);
  arrived(system, 'testUk', 60_000, [SIGNAL, { ...SIGNAL, id: 'no-retries', seq: 2 }]);

  await system.harness.runCycle();
  assert.equal(system.store.listWatchReadings().length, 2);

  // The document speaks for the whole watch. Dropping the row alone would leave a
  // reading of a check no document declares — a number with no rule.
  system.store.ingestGoalWatch('issue:12', [SIGNAL]);
  assert.deepEqual(
    system.store.listWatchReadings().map((r) => r.checkId),
    ['no-timeouts'],
  );
  system.store.close();
});
