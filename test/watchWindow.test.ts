import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueWindows, openableArrivals, settlingWindows } from '../src/environments/watchWindow.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { GoalArrival, WatchWindow } from '../src/types.js';

/**
 * The window's arithmetic, on its own: which arrivals open one, which windows are
 * due a reading, and which have run out of time.
 *
 * The freshness guard is the first thing here because it is the most consequential
 * line in the subsystem: without it the first pulse after this ships opens a window
 * on every goal that ever arrived, which is hundreds of queries a pulse against
 * work that shipped in March — and nothing errors.
 */

const PROBE_MS = 5 * 60 * 1000;
const NOW = Date.parse('2026-08-20T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const WATCHED: EnvironmentConfig[] = [{ name: 'testUk', at: 'unused', watch: { observe: './telemetry.sh testUk' } }];

function arrival(over: Partial<GoalArrival> = {}): GoalArrival {
  return {
    goalRef: 'issue:12',
    environment: 'testUk',
    arrivedAt: ago(PROBE_MS),
    announcedAt: null,
    watchedAt: null,
    ...over,
  };
}

const open = (input: Partial<Parameters<typeof openableArrivals>[0]> = {}) =>
  openableArrivals({
    arrivals: [arrival()],
    environments: WATCHED,
    declared: new Set(['issue:12']),
    probeIntervalMs: PROBE_MS,
    now: NOW,
    ...input,
  });

test('an arrival the harness watched happen opens a window', () => {
  const [considered] = open();
  assert.ok(considered);
  assert.equal(
    considered.settlesAt,
    // 48 hours from the arrival, which is the default where the environment
    // declares no `forMs`.
    new Date(Date.parse(considered.arrival.arrivedAt) + 48 * 60 * 60 * 1000).toISOString(),
  );
});

test('an arrival three probe intervals old opens no window, and is stamped anyway', () => {
  // The trap. The first pulse after this ships finds every goal already in every
  // environment; without the guard each one opens a window, and without the stamp
  // it opens one again on every pulse after that.
  const considered = open({ arrivals: [arrival({ arrivedAt: ago(PROBE_MS * 3) })] });
  assert.equal(considered.length, 1, 'the arrival is still returned — the caller stamps every one it considered');
  assert.equal(considered[0]!.settlesAt, null, 'nothing is opened for work the harness merely discovered');
});

test('an arrival already stamped is not considered again', () => {
  assert.deepEqual(open({ arrivals: [arrival({ watchedAt: ago(1000) })] }), []);
});

test('an environment that declares no watch opens nothing, and is stamped', () => {
  const considered = open({ environments: [{ name: 'testUk', at: 'unused' }] });
  assert.equal(considered.length, 1);
  assert.equal(considered[0]!.settlesAt, null);
});

test('a goal that declared no checks opens no window at all', () => {
  // Null is a third fact rather than a synonym for clean: a window with no
  // readings behind it would be an empty card claiming to be watching something.
  const considered = open({ declared: new Set<string>() });
  assert.equal(considered.length, 1);
  assert.equal(considered[0]!.settlesAt, null);
});

test('a window opens per environment, so one goal travelling is watched twice', () => {
  const environments: EnvironmentConfig[] = [
    ...WATCHED,
    { name: 'liveUk', at: 'unused', watch: { observe: './telemetry.sh uk' } },
  ];
  const considered = open({
    arrivals: [arrival(), arrival({ environment: 'liveUk' })],
    environments,
  });
  assert.deepEqual(
    considered.map((c) => [c.arrival.environment, c.settlesAt !== null]),
    [
      ['testUk', true],
      ['liveUk', true],
    ],
    'the acceptance environment is usually where presence is zero and the production one is where the answer is',
  );
});

test("the environment's own forMs sizes the window", () => {
  const environments: EnvironmentConfig[] = [
    { name: 'testUk', at: 'unused', watch: { observe: './telemetry.sh testUk', forMs: 60 * 60 * 1000 } },
  ];
  const [considered] = open({ environments });
  assert.equal(
    considered!.settlesAt,
    new Date(Date.parse(considered!.arrival.arrivedAt) + 60 * 60 * 1000).toISOString(),
  );
});

// --- settling ---------------------------------------------------------------

function window(over: Partial<WatchWindow> = {}): WatchWindow {
  return {
    goalRef: 'issue:12',
    environment: 'testUk',
    openedAt: ago(60_000),
    settlesAt: new Date(NOW + 60_000).toISOString(),
    settledAt: null,
    ...over,
  };
}

test('a window settles at for, and a settled one is never settled again', () => {
  assert.deepEqual(settlingWindows([window()], NOW), [], 'still inside its own window');
  assert.equal(settlingWindows([window({ settlesAt: ago(1) })], NOW).length, 1);
  assert.deepEqual(
    settlingWindows([window({ settlesAt: ago(1), settledAt: ago(1) })], NOW),
    [],
    'settled_at null means still watching, and a settled watch is a record rather than a monitor',
  );
});

// --- what is due ------------------------------------------------------------

const due = (input: Partial<Parameters<typeof dueWindows>[0]> = {}) =>
  dueWindows({ windows: [window()], readings: [], watchIntervalMs: 30 * 60 * 1000, now: NOW, ...input });

test('a window never read is due now', () => {
  assert.equal(due().length, 1, 'the first reading is the one the operator is waiting for');
});

test('a window read inside the interval is not asked again', () => {
  const readings = [{ goalRef: 'issue:12', environment: 'testUk', readAt: ago(60_000) }];
  assert.deepEqual(due({ readings }), []);
  assert.equal(due({ readings, watchIntervalMs: 30_000 }).length, 1);
});

test('a settled window is not re-opened by a later reading', () => {
  // The other half of the settle rule, and the half a reading could undo: a window
  // past its `for` is never asked again, whatever the interval says.
  assert.deepEqual(due({ windows: [window({ settledAt: ago(1000) })] }), []);
});

test('the per-pulse cap defers rather than drops, oldest window first', () => {
  const many = Array.from({ length: 25 }, (_, i) =>
    window({ goalRef: `issue:${String(i)}`, openedAt: ago((25 - i) * 60_000) }),
  );
  const first = due({ windows: many });
  assert.equal(first.length, 20, 'capped, so a backlog does not spawn 25 processes on one pulse');
  assert.deepEqual(
    first.map((w) => w.goalRef),
    many.slice(0, 20).map((w) => w.goalRef),
    'oldest first, so the queue drains in a fixed order and nothing starves',
  );
  // And the ones left out are asked next pulse rather than lost: they are still in
  // the list, still unread, and now at the front of it.
  const next = due({ windows: many.slice(20) });
  assert.deepEqual(
    next.map((w) => w.goalRef),
    many.slice(20).map((w) => w.goalRef),
  );
});
