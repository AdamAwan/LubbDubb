import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server/app.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeEnvironmentObserver, watchRow } from '../src/environments/fakeObserver.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { GoalWatchInput } from '../src/types.js';

/**
 * What a finding does, at the `buildSystem` seam with `dbPath: ':memory:'` and
 * `FakeEnvironmentObserver` injected. Nothing here spawns a shell or touches a
 * network.
 *
 * The ones that earn their place are the silences. A row per reading rather than
 * per window is 96 asks a day per check burying the rail. A row filed off an
 * `unknown` puts an expired credential in front of a person as a regression. A
 * reading written as a `WorldEvent` un-parks the goal it just reported on and
 * hands finished work back to the fleet — and every one of those looks, on the
 * glass, exactly like the feature working.
 */

const PROBE_MS = 5 * 60 * 1000;

/** A window that has already run out by the time the pass looks at it. */
const SETTLES_AT_ONCE: EnvironmentConfig = {
  name: 'testUk',
  at: 'echo unused',
  watch: { observe: './scripts/telemetry.sh testUk', forMs: 1 },
};

const OPEN: EnvironmentConfig = {
  name: 'testUk',
  at: 'echo unused',
  watch: { observe: './scripts/telemetry.sh testUk' },
};

const SIGNAL: GoalWatchInput = {
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

/** Presence answers, and the check's own query matches a row it declared none of. */
const REGRESSED = {
  'no-timeouts:presence': JSON.stringify([watchRow('no-timeouts', { runs: 96 })]),
  'no-timeouts:signal': JSON.stringify([watchRow('no-timeouts', { role: 'worker' })]),
};
/** Presence answers zero — the environment could not be read, which is not a finding. */
const UNKNOWN = { 'no-timeouts:presence': '[]', 'no-timeouts:signal': '[]' };
const CLEAN = {
  'no-timeouts:presence': JSON.stringify([watchRow('no-timeouts', { runs: 96 })]),
  'no-timeouts:signal': '[]',
};

function build(observer: FakeEnvironmentObserver, environments: EnvironmentConfig[] = [OPEN]): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-watch-finding-'));
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
    environmentProber: new FakeEnvironmentProber(),
    gitObserver: new FakeGitObserver(),
    errorMirror: () => {},
  });
}

/** A goal that declared one signal and whose whole work has just arrived. */
function arrived(system: System, environment = 'testUk'): void {
  system.store.ingestGoalWatch('issue:12', [SIGNAL]);
  system.store.recordGoalArrival({
    goalRef: 'issue:12',
    environment,
    arrivedAt: new Date(Date.now() - 60_000).toISOString(),
  });
}

/** The goal in the world and delivered, so the close-out desk has a row to file. */
function delivered(system: System): void {
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Job X keeps timing out' });
  system.store.recordDelivery({ originRef: 'issue:12', summary: 'PR #40 landed it', by: 'assessor' });
}

// -- the bench row ------------------------------------------------------------

test('a settled-regressed watch files one row, and a second reading files no second one', async () => {
  const observer = new FakeEnvironmentObserver(REGRESSED);
  const system = build(observer, [OPEN]);
  arrived(system);

  await system.harness.runCycle();
  const filed = system.store.listHumanTasksOfKind('watch');
  assert.equal(filed.length, 1);
  assert.match(filed[0]!.title, /watch on testUk/);
  assert.equal(filed[0]!.originRef, 'issue:12');
  // The numbers ride, in the reading's own words — no model read them and none
  // will, so the row is where they go in front of a person.
  assert.match(filed[0]!.detail ?? '', /Job X stops timing out/);
  assert.match(filed[0]!.detail ?? '', /answered 1 row where the check declared none at all/);

  // A window is 96 readings on the defaults. A row per reading is the rail burying
  // its own asks under one goal's telemetry, so the second one lands on the row
  // the first filed.
  system.store.recordWatchReading({
    goalRef: 'issue:12',
    environment: 'testUk',
    checkId: 'no-timeouts',
    verdict: 'regressed',
    rows: 4,
    value: null,
    detail: 'testUk answered 4 rows where the check declared none at all.',
  });
  await system.harness.runCycle();

  const after = system.store.listHumanTasksOfKind('watch');
  assert.equal(after.length, 1, 'one row per window, never one per reading');
  assert.equal(after[0]!.id, filed[0]!.id);
  assert.match(after[0]!.detail ?? '', /4 rows/, 'and its detail states what the watch says now');
  system.store.close();
});

test('a settled-unknown watch files nothing — it is not a finding', async () => {
  // The case that most looks like one: an expired credential, a missing binary and
  // a job that has not run here all fail identically, and a row filed off any of
  // them asks a person to look at a regression that was never read.
  const observer = new FakeEnvironmentObserver(UNKNOWN);
  const system = build(observer, [SETTLES_AT_ONCE]);
  arrived(system);

  await system.harness.runCycle();
  await system.harness.runCycle();

  assert.notEqual(system.store.listWatchWindows()[0]?.settledAt, null, 'settled, and settled unread');
  assert.deepEqual(system.store.listHumanTasksOfKind('watch'), []);
  system.store.close();
});

test('a reading that comes back clean retracts the row, and a later regression brings it back', async () => {
  const observer = new FakeEnvironmentObserver(REGRESSED);
  const system = build(observer, [OPEN]);
  arrived(system);
  await system.harness.runCycle();
  const [row] = system.store.listHumanTasksOfKind('watch');
  assert.equal(row?.status, 'open');

  // The obligation is not owed *right now*, which is a different thing from a
  // person saying they have dealt with it — so the harness's own marker, or the
  // dedup would refresh their settled row's detail and leave it settled.
  system.store.recordWatchReading({
    goalRef: 'issue:12',
    environment: 'testUk',
    checkId: 'no-timeouts',
    verdict: 'clean',
    rows: 0,
    value: null,
    detail: null,
  });
  await system.harness.runCycle();
  const settled = system.store.getHumanTask(row!.id)!;
  assert.equal(settled.status, 'done');
  assert.match(settled.resolution ?? '', /Settled by the harness/);

  system.store.recordWatchReading({
    goalRef: 'issue:12',
    environment: 'testUk',
    checkId: 'no-timeouts',
    verdict: 'regressed',
    rows: 2,
    value: null,
    detail: 'testUk answered 2 rows where the check declared none at all.',
  });
  await system.harness.runCycle();
  const back = system.store.getHumanTask(row!.id)!;
  assert.equal(back.status, 'open', 'reopened rather than re-filed');
  assert.equal(system.store.listHumanTasksOfKind('watch').length, 1);
  system.store.close();
});

// -- the close-out ------------------------------------------------------------

test('the close-out carries what the watch says and does not hold it, with holds absent', async () => {
  const observer = new FakeEnvironmentObserver(REGRESSED);
  const system = build(observer, [OPEN]);
  arrived(system);
  delivered(system);

  // Two pulses: the first opens the window and reads it, and the close-out desk
  // runs above the environment pass, so the second is the one that carries it.
  await system.harness.runCycle();
  await system.harness.runCycle();

  const [row] = system.store.listHumanTasksOfKind('close_out');
  assert.ok(row, 'a watch holds nothing by default — the row is filed while it is open');
  assert.equal(row.status, 'open');
  assert.match(row.detail ?? '', /testUk is answering outside what was declared/);
  assert.match(row.detail ?? '', /holds nothing/);
  system.store.close();
});

test('a goal delivered with a watch still open closes in front of the reading, not past it', async () => {
  // `validate`'s arrangement exactly: the row is filed, it is closable, and the
  // detail is rewritten on every pulse — so the sentence an operator reads at the
  // moment they close the ticket is the one the watch is saying then.
  const observer = new FakeEnvironmentObserver(CLEAN);
  const system = build(observer, [OPEN]);
  arrived(system);
  delivered(system);

  await system.harness.runCycle();
  await system.harness.runCycle();
  const [row] = system.store.listHumanTasksOfKind('close_out');
  assert.match(row!.detail ?? '', /read every declared check clean/);
  assert.match(row!.detail ?? '', /still open, and holds nothing/);

  // And it moves with the readings rather than stating what was true when it was
  // filed. An `unknown` is never drawn in a clean one's words.
  system.store.recordWatchReading({
    goalRef: 'issue:12',
    environment: 'testUk',
    checkId: 'no-timeouts',
    verdict: 'unknown',
    rows: null,
    value: null,
    detail: 'the watch could not read testUk',
  });
  await system.harness.runCycle();
  assert.match(system.store.getHumanTask(row!.id)!.detail ?? '', /could not be read/);
  system.store.close();
});

test('holds: ["close_out"] withholds the row while the window is open, and releases it when it settles', async () => {
  const observer = new FakeEnvironmentObserver(CLEAN);
  const system = build(observer, [{ ...OPEN, watch: { ...OPEN.watch!, holds: ['close_out'] } }]);
  arrived(system);
  delivered(system);

  await system.harness.runCycle();
  await system.harness.runCycle();
  assert.deepEqual(
    system.store.listHumanTasksOfKind('close_out'),
    [],
    'the stricter thing a team opts into — and it withholds from the delivery, not from the arrival',
  );

  system.store.settleWatchWindow('issue:12', 'testUk');
  await system.harness.runCycle();
  const [row] = system.store.listHumanTasksOfKind('close_out');
  assert.ok(row, 'a settled watch has said what it is going to say');
  assert.match(row.detail ?? '', /read every declared check clean/);
  system.store.close();
});

// -- extending ----------------------------------------------------------------

test('extend re-opens the settled window, and the verdict it fixed is still readable', async () => {
  // Open question 2, settled: it re-opens *this* window rather than opening a
  // second one. `watch_windows` is keyed on `(goal, environment)`, so a second
  // window would split one goal's readings across two rows nothing joins — and the
  // readings taken before it ran out are the evidence behind whatever it says
  // next. `settleWatchWindow`'s `settled_at IS NULL` guard is untouched by this:
  // what it prevents is a later *reading* moving a stamp, and a click is not one.
  const observer = new FakeEnvironmentObserver(REGRESSED);
  const system = build(observer, [SETTLES_AT_ONCE]);
  arrived(system);
  await system.harness.runCycle();

  // A window sized at one millisecond settles before anything is read, so give it
  // the reading whose verdict has to survive.
  system.store.recordWatchReading({
    goalRef: 'issue:12',
    environment: 'testUk',
    checkId: 'no-timeouts',
    verdict: 'regressed',
    rows: 1,
    value: null,
    detail: 'testUk answered 1 row where the check declared none at all.',
  });
  const before = system.store.listWatchWindows()[0]!;
  assert.notEqual(before.settledAt, null);

  const extended = system.store.extendWatchWindow(
    'issue:12',
    'testUk',
    new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  );

  assert.equal(system.store.listWatchWindows().length, 1, 'one window, not two');
  assert.equal(extended?.settledAt, null, 'watching again');
  assert.notEqual(extended?.extendedAt, null, 'and stamped, so the card can say why its end is not the arrival’s');
  assert.equal(extended?.openedAt, before.openedAt, 'and nothing else moved');
  assert.deepEqual(
    system.store.listWatchReadings().map((r) => r.verdict),
    ['regressed'],
    'the verdict that was fixed is still readable',
  );
  system.store.close();
});

test('extend answers nothing for a goal or environment with no window', () => {
  const observer = new FakeEnvironmentObserver(CLEAN);
  const system = build(observer, [OPEN]);
  const at = new Date(Date.now() + 1000).toISOString();
  assert.equal(system.store.extendWatchWindow('issue:12', 'testUk', at), null);
  assert.deepEqual(system.store.listWatchWindows(), []);
  system.store.close();
});

test('the extend route refuses a window that is not there, and an environment that asks nothing', async () => {
  // Reported as done, either would leave the operator believing they had extended
  // something — a stale page and a wrong name look identical from here otherwise.
  const observer = new FakeEnvironmentObserver(CLEAN);
  const system = build(observer, [OPEN, { name: 'liveUk', at: 'echo unused' }]);
  arrived(system);
  await system.harness.runCycle();

  const { app } = await buildApp(system);
  const missing = await app.inject({ method: 'POST', url: '/api/issues/99/watch/testUk/extend' });
  assert.equal(missing.statusCode, 404);
  // `liveUk` is probed for reach and declares no telemetry, so a window re-opened
  // there would run to its new end reading nothing at all.
  const unwatched = await app.inject({ method: 'POST', url: '/api/issues/12/watch/liveUk/extend' });
  assert.equal(unwatched.statusCode, 409);

  const extended = await app.inject({ method: 'POST', url: '/api/issues/12/watch/testUk/extend' });
  assert.equal(extended.statusCode, 200);
  assert.notEqual(system.store.listWatchWindows()[0]?.extendedAt, null);
  await app.close();
  system.store.close();
});

// -- the rule none of it may break --------------------------------------------

test('nothing a finding does is written as a WorldEvent', async () => {
  // `deliveryHold` expires a standing delivery verdict on *any* world event
  // matching the goal's issue ref, so a reading, a bench row or a close-out
  // sentence written as one would un-park the goal it just reported on and hand
  // the finished fix back to the fleet. Nothing errors, and the re-dispatch of
  // completed work looks like the harness deciding there is more to do.
  const observer = new FakeEnvironmentObserver(REGRESSED);
  const system = build(observer, [OPEN]);
  arrived(system);
  delivered(system);

  await system.harness.runCycle();
  await system.harness.runCycle();
  assert.equal(system.store.listHumanTasksOfKind('watch').length, 1, 'the finding did happen');

  const events = system.store.listWorldEvents();
  assert.deepEqual(
    events.filter((e) => /watch|regress/i.test(`${e.kind} ${e.summary}`)),
    [],
    'watch readings have their own table and their own wire list, merged at the feed’s door',
  );
  system.store.close();
});
