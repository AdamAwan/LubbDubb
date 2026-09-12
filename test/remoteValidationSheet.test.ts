import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { RemoteValidationDesk } from '../src/remoteValidation/desk.js';
import { StateQueryDesk } from '../src/remoteValidation/stateQueries.js';
import { FakeStateReader } from '../src/remoteValidation/fakeStateReader.js';
import { FakeRemoteRunner } from '../src/remoteValidation/fakeRemoteRunner.js';
import { FakeEnvironmentObserver, watchRow } from '../src/environments/fakeObserver.js';
import { sheetBenchLine } from '../src/remoteValidation/sheet.js';
import { queryDigest } from '../src/store/remoteValidation.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { GoalWatchInput, StateQueryInput, ValidationCheckInput } from '../src/types.js';
import { PULSE_PIPELINE, type PulseDeskId } from '../src/pulseDesks.js';

// → docs/spec/36-remote-validation.md

const PROBE_MS = 60_000;
const NOW = Date.parse('2026-09-08T12:00:00.000Z');

const ACCEPTANCE: EnvironmentConfig = {
  name: 'acceptance',
  at: 'echo unused',
  watch: { observe: './telemetry.sh acceptance' },
  validate: { permits: ['state', 'signal'], state: { run: './query.sh acceptance' } },
};

const PRODUCTION: EnvironmentConfig = {
  name: 'production',
  at: 'echo unused',
  watch: { observe: './telemetry.sh production' },
  validate: { permits: ['state', 'signal'], state: { run: './query.sh production' } },
};

const QUERY: StateQueryInput = {
  id: 'orders-carry-a-channel',
  seq: 1,
  title: 'Every order written since the change carries a channel',
  query: 'select id, channel from orders where channel is null',
  presence: 'select id from orders limit 5',
  why: null,
};

const SIGNAL: GoalWatchInput = {
  id: 'checkout-throws',
  seq: 1,
  kind: 'signal',
  title: 'Checkout throws',
  query: 'exceptions | where operation == "checkout"',
  presence: 'requests | where operation == "checkout"',
  tolerate: 0,
  expectUnder: null,
  expectOver: null,
  expectBaseline: false,
  unit: null,
  why: null,
};

const CHECK: ValidationCheckInput = {
  id: 'an-order-places',
  seq: 1,
  title: 'An order still places end to end',
  do: 'Place one',
  expect: 'It places',
  uses: [],
  covers: [],
  fleetCandidate: false,
  candidateWhy: null,
};

function reader(): FakeStateReader {
  return new FakeStateReader({
    [`${QUERY.id}:presence`]: JSON.stringify([watchRow(QUERY.id, { id: 1 })]),
    [`${QUERY.id}:state`]: JSON.stringify([]),
  });
}

function observer(): FakeEnvironmentObserver {
  return new FakeEnvironmentObserver({
    [`${SIGNAL.id}:presence`]: JSON.stringify([watchRow(SIGNAL.id, { op: 'checkout' })]),
    [`${SIGNAL.id}:signal`]: JSON.stringify([]),
  });
}

interface Bench {
  store: Store;
  desk: RemoteValidationDesk;
  reader: FakeStateReader;
  observer: FakeEnvironmentObserver;
}

function bench(
  environments: EnvironmentConfig[] = [ACCEPTANCE],
  now: () => number = () => NOW,
  opts: { reader?: FakeStateReader; observer?: FakeEnvironmentObserver } = {},
): Bench {
  const store = new Store(':memory:');
  const stateReader = opts.reader ?? reader();
  const env = opts.observer ?? observer();
  const desk = new RemoteValidationDesk({
    store,
    environments,
    observer: env,
    queries: new StateQueryDesk({ store, environments, reader: stateReader }),
    runner: new FakeRemoteRunner(),
    scriptGraceMs: 30 * 24 * 60 * 60 * 1000,
    probeIntervalMs: PROBE_MS,
    now,
  });
  return { store, desk, reader: stateReader, observer: env };
}

function seedGoal(store: Store, goalRef = 'issue:12'): void {
  store.validation.ingestValidation(goalRef, { checks: [CHECK], resources: [], supersededReason: '', amendNote: '' });
  store.watches.ingestGoalWatch(goalRef, [SIGNAL]);
  store.remoteValidation.saveStateQueries(goalRef, [QUERY], 'agent');
}

function arrive(
  store: Store,
  environment: string,
  goalRef = 'issue:12',
  at = new Date(NOW - 1000).toISOString(),
): void {
  store.environments.recordGoalArrival({ goalRef, environment, arrivedAt: at });
}

function approve(store: Store, goalRef: string, environment: string, query: string, presence: string): void {
  store.remoteValidation.approveStateQuery({
    digest: queryDigest(query, presence),
    environment,
    originRef: goalRef,
    queryId: 'seeded',
    rows: 0,
    detail: null,
  });
}

test('an arrival assembles one sheet, of the goal’s checks, watches and state queries', async () => {
  const { store, desk } = bench();
  try {
    seedGoal(store);
    arrive(store, 'acceptance');
    await desk.run();

    assert.deepEqual(
      store.remoteValidation.listRemoteSheets().map((s) => `${s.goalRef} ${s.environment}`),
      ['issue:12 acceptance'],
    );
    assert.deepEqual(
      store.remoteValidation.listRemoteSheetRows().map((r) => `${r.kind}:${r.sourceId}`),
      ['check:an-order-places', 'state:orders-carry-a-channel', 'signal:checkout-throws'],
    );
    assert.notEqual(store.environments.listGoalArrivals()[0]?.sheetedAt, null, 'the arrival is stamped');
  } finally {
    store.close();
  }
});

test('a second arrival re-runs the sheet that exists rather than opening a second one', async () => {
  const { store, desk } = bench();
  try {
    seedGoal(store);
    arrive(store, 'acceptance');
    await desk.run();
    const first = store.remoteValidation.listRemoteSheets()[0]!;

    // The same pair arrives again: the guard has stamped it, so the desk leaves it alone; and where
    // it is considered again the sheet it finds is the one that exists.
    store.remoteValidation.openRemoteSheet({ goalRef: 'issue:12', environment: 'acceptance' });
    await desk.run();

    assert.equal(store.remoteValidation.listRemoteSheets().length, 1, 'one sheet per (goal, environment), for good');
    assert.equal(
      store.remoteValidation.listRemoteSheets()[0]?.assembledAt,
      first.assembledAt,
      'a sheet does not expire',
    );
    assert.equal(store.remoteValidation.listRemoteSheetRows().length, 3, 'and its rows are replaced, never duplicated');
  } finally {
    store.close();
  }
});

test('an approved state row carries a reading, and neither the world nor the watch hears about it', async () => {
  const { store, desk } = bench();
  try {
    seedGoal(store);
    approve(store, 'issue:12', 'acceptance', QUERY.query, QUERY.presence);
    arrive(store, 'acceptance');
    await desk.run();

    const reading = store.remoteValidation.listRemoteReadings().find((r) => r.rowId === `state:${QUERY.id}`);
    assert.equal(reading?.outcome, 'passed', 'the query matched nothing, which is the shape of correct data');
    assert.equal(reading?.rows, 0);
    assert.deepEqual(store.world.listWorldEvents(50), [], 'a reading is never a WorldEvent — deliveryHold reads those');
    assert.deepEqual(store.watches.listWatchReadings(), [], 'and never a watch reading: different clocks');
  } finally {
    store.close();
  }
});

test('a state query that matches rows fails the row, and says what it answered', async () => {
  const answering = new FakeStateReader({
    [`${QUERY.id}:presence`]: JSON.stringify([watchRow(QUERY.id, { id: 1 })]),
    [`${QUERY.id}:state`]: JSON.stringify([watchRow(QUERY.id, { id: 7 }), watchRow(QUERY.id, { id: 8 })]),
  });
  const { store, desk } = bench([ACCEPTANCE], () => NOW, { reader: answering });
  try {
    seedGoal(store);
    approve(store, 'issue:12', 'acceptance', QUERY.query, QUERY.presence);
    arrive(store, 'acceptance');
    await desk.run();

    const reading = store.remoteValidation.listRemoteReadings().find((r) => r.rowId === `state:${QUERY.id}`);
    assert.equal(reading?.outcome, 'failed');
    assert.match(reading?.detail ?? '', /answered 2 rows/);
  } finally {
    store.close();
  }
});

test('an unapproved query is blocked, never run and never failed — a state query and a live watch check alike', async () => {
  const { store, desk, reader: asked, observer: watched } = bench();
  try {
    seedGoal(store);
    arrive(store, 'acceptance');
    await desk.run();

    const rows = store.remoteValidation.listRemoteSheetRows();
    for (const rowId of [`state:${QUERY.id}`, `watch:${SIGNAL.id}`]) {
      const row = rows.find((r) => r.rowId === rowId);
      assert.equal(row?.awaitingApproval, true, `${rowId} says what it waits for`);
      assert.match(row?.blockedReason ?? '', /waiting for an operator to read it and accept it against acceptance/);
    }
    assert.deepEqual(store.remoteValidation.listRemoteReadings(), [], 'nothing unapproved was run');
    assert.deepEqual(asked.asked, [], 'and no command was put to the store');
    assert.deepEqual(watched.asked, [], 'nor to the telemetry');
  } finally {
    store.close();
  }
});

test('a query approved against one environment is still blocked on another', async () => {
  const { store, desk } = bench([ACCEPTANCE, PRODUCTION]);
  try {
    seedGoal(store);
    approve(store, 'issue:12', 'acceptance', QUERY.query, QUERY.presence);
    arrive(store, 'acceptance');
    arrive(store, 'production');
    await desk.run();

    const rows = store.remoteValidation.listRemoteSheetRows().filter((r) => r.rowId === `state:${QUERY.id}`);
    assert.equal(rows.find((r) => r.environment === 'acceptance')?.blockedReason, null);
    assert.match(
      rows.find((r) => r.environment === 'production')?.blockedReason ?? '',
      /accept it against production/,
      'consent to a place is not transferable',
    );
  } finally {
    store.close();
  }
});

test('a state row on a store nothing can reach is blocked while every other row on the sheet still reports', async () => {
  const unreachable = new FakeStateReader({});
  const { store, desk } = bench([ACCEPTANCE], () => NOW, { reader: unreachable });
  try {
    seedGoal(store);
    approve(store, 'issue:12', 'acceptance', QUERY.query, QUERY.presence);
    approve(store, 'issue:12', 'acceptance', SIGNAL.query, SIGNAL.presence!);
    arrive(store, 'acceptance');
    await desk.run();

    const state = store.remoteValidation.listRemoteSheetRows().find((r) => r.rowId === `state:${QUERY.id}`);
    assert.notEqual(state?.blockedReason, null, 'blocked, never failed: failed here dispatches at code that is fine');
    assert.equal(
      store.remoteValidation.listRemoteReadings().find((r) => r.rowId === `state:${QUERY.id}`),
      undefined,
      'and an observation that fails is never a reading',
    );
    assert.equal(
      store.remoteValidation.listRemoteReadings().find((r) => r.rowId === `watch:${SIGNAL.id}`)?.outcome,
      'passed',
      'blocked resolves per row, never per run',
    );
  } finally {
    store.close();
  }
});

test('an observation that answers without the id echo is blocked, never a reading', async () => {
  const echoless = new FakeStateReader({
    [`${QUERY.id}:presence`]: JSON.stringify([watchRow('some-other-query', { id: 1 })]),
  });
  const { store, desk } = bench([ACCEPTANCE], () => NOW, { reader: echoless });
  try {
    seedGoal(store);
    approve(store, 'issue:12', 'acceptance', QUERY.query, QUERY.presence);
    arrive(store, 'acceptance');
    await desk.run();

    const row = store.remoteValidation.listRemoteSheetRows().find((r) => r.rowId === `state:${QUERY.id}`);
    assert.match(row?.blockedReason ?? '', /answered without the query it was given/);
    assert.deepEqual(
      store.remoteValidation.listRemoteReadings(),
      [],
      'a result that does not carry the id back is not an answer',
    );
  } finally {
    store.close();
  }
});

test('a row of a kind the environment does not permit is blocked, saying so', async () => {
  const stateOnly: EnvironmentConfig = { ...ACCEPTANCE, validate: { ...ACCEPTANCE.validate!, permits: ['state'] } };
  const { store, desk } = bench([stateOnly]);
  try {
    seedGoal(store);
    arrive(store, 'acceptance');
    await desk.run();

    const rows = store.remoteValidation.listRemoteSheetRows();
    assert.match(rows.find((r) => r.kind === 'check')?.blockedReason ?? '', /does not permit check rows/);
    assert.match(rows.find((r) => r.kind === 'signal')?.blockedReason ?? '', /does not permit signal rows/);
    assert.equal(
      rows.find((r) => r.kind === 'signal')?.awaitingApproval,
      false,
      'a kind nothing may ask for is not waiting on a person',
    );
  } finally {
    store.close();
  }
});

test('a sheet is not assembled for an arrival older than two probe intervals, and it is stamped anyway', async () => {
  const { store, desk } = bench();
  try {
    seedGoal(store);
    arrive(store, 'acceptance', 'issue:12', new Date(NOW - PROBE_MS * 3).toISOString());
    await desk.run();

    assert.deepEqual(
      store.remoteValidation.listRemoteSheets(),
      [],
      'work that shipped in March gets no sheet and no bench row',
    );
    assert.notEqual(
      store.environments.listGoalArrivals()[0]?.sheetedAt,
      null,
      'stamped, so the next arrival is the first sheeted',
    );
  } finally {
    store.close();
  }
});

test('an arrival on an environment with no validate block is left unstamped', async () => {
  const bare: EnvironmentConfig = { name: 'hallway', at: 'echo unused' };
  const { store, desk } = bench([ACCEPTANCE, bare]);
  try {
    seedGoal(store);
    arrive(store, 'hallway');
    await desk.run();

    assert.equal(
      store.environments.listGoalArrivals().find((a) => a.environment === 'hallway')?.sheetedAt,
      null,
      'stamping where the feature is off burns the guard that makes turning it on next month safe',
    );
  } finally {
    store.close();
  }
});

test('the desk returns immediately where no environment declares a validate block, and stamps nothing', async () => {
  const bare: EnvironmentConfig = { name: 'hallway', at: 'echo unused' };
  const { store, desk, reader: asked } = bench([bare]);
  try {
    seedGoal(store);
    arrive(store, 'hallway');
    await desk.run();

    assert.deepEqual(store.remoteValidation.listRemoteSheets(), []);
    assert.deepEqual(store.remoteValidation.listRemoteSheetRows(), []);
    assert.equal(store.environments.listGoalArrivals()[0]?.sheetedAt, null);
    assert.deepEqual(asked.asked, [], 'no command is spawned');
  } finally {
    store.close();
  }
});

test('the per-pulse cap defers rather than drops, oldest arrival first', async () => {
  const { store, desk } = bench();
  try {
    for (let n = 1; n <= 7; n += 1) {
      seedGoal(store, `issue:${n}`);
      arrive(store, 'acceptance', `issue:${n}`, new Date(NOW - PROBE_MS - n).toISOString());
    }
    await desk.run();
    const first = store.remoteValidation
      .listRemoteSheets()
      .map((s) => s.goalRef)
      .sort();
    assert.equal(first.length, 5, 'five sheets a pulse');
    assert.deepEqual(first, ['issue:3', 'issue:4', 'issue:5', 'issue:6', 'issue:7'], 'oldest arrival first');

    await desk.run();
    assert.equal(store.remoteValidation.listRemoteSheets().length, 7, 'the backlog drains rather than being dropped');
  } finally {
    store.close();
  }
});

test('a pass that throws is recorded and never fails the cycle', async () => {
  const logged: string[] = [];
  const store = new Store(':memory:');
  try {
    const desk = new RemoteValidationDesk({
      store,
      environments: [ACCEPTANCE],
      observer: observer(),
      queries: {
        read: () => {
          throw new Error('the reader blew up');
        },
      } as unknown as StateQueryDesk,
      runner: new FakeRemoteRunner(),
      scriptGraceMs: 30 * 24 * 60 * 60 * 1000,
      probeIntervalMs: PROBE_MS,
      errors: { record: (e: { message: string }) => logged.push(e.message) } as never,
      now: () => NOW,
    });
    seedGoal(store);
    approve(store, 'issue:12', 'acceptance', QUERY.query, QUERY.presence);
    arrive(store, 'acceptance');
    await desk.run();

    assert.equal(logged.length, 1);
    assert.match(logged[0] ?? '', /assembling the validation sheet for issue:12 on acceptance failed/);
  } finally {
    store.close();
  }
});

test('the bench line is the minimal one: a sheet, its rows, and what waits on a person', () => {
  const rows = [
    { environment: 'acceptance', awaitingApproval: false },
    { environment: 'acceptance', awaitingApproval: true },
  ] as never;
  assert.equal(
    sheetBenchLine('acceptance', rows),
    'A validation sheet is assembled for `acceptance` — 2 rows, 1 waiting on an approval.',
  );
  assert.equal(sheetBenchLine('acceptance', [] as never), 'A validation sheet is assembled for `acceptance` — 0 rows.');
});

test('a database written before goal_arrivals.sheeted_at gains it on boot, and nothing is backfilled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-sheeted-'));
  const file = join(dir, 'before-the-column.sqlite');
  try {
    const before = new Store(file);
    before.environments.recordGoalArrival({
      goalRef: 'issue:12',
      environment: 'acceptance',
      arrivedAt: new Date(NOW - 1000).toISOString(),
    });
    before.close();

    const raw = new Database(file);
    raw.exec(`CREATE TABLE goal_arrivals_pre AS SELECT goal_ref, environment, arrived_at, recorded_at,
                announced_at, watched_at FROM goal_arrivals`);
    raw.exec('DROP TABLE goal_arrivals');
    raw.exec(`CREATE TABLE goal_arrivals (
                goal_ref TEXT NOT NULL, environment TEXT NOT NULL, arrived_at TEXT NOT NULL,
                recorded_at TEXT NOT NULL, announced_at TEXT, watched_at TEXT,
                PRIMARY KEY (goal_ref, environment))`);
    raw.exec('INSERT INTO goal_arrivals SELECT * FROM goal_arrivals_pre');
    raw.exec('DROP TABLE goal_arrivals_pre');
    raw.close();

    const store = new Store(file);
    try {
      assert.equal(
        store.environments.listGoalArrivals()[0]?.sheetedAt,
        null,
        'the column is present, readable, and not backfilled',
      );
      const desk = new RemoteValidationDesk({
        store,
        environments: [ACCEPTANCE],
        observer: observer(),
        queries: new StateQueryDesk({ store, environments: [ACCEPTANCE], reader: reader() }),
        runner: new FakeRemoteRunner(),
        scriptGraceMs: 30 * 24 * 60 * 60 * 1000,
        probeIntervalMs: PROBE_MS,
        now: () => NOW + PROBE_MS * 10,
      });
      seedGoal(store);
      await desk.run();
      assert.deepEqual(
        store.remoteValidation.listRemoteSheets(),
        [],
        'an upgraded database assembles nothing for work that predates the column',
      );
      assert.notEqual(store.environments.listGoalArrivals()[0]?.sheetedAt, null, 'it is walked once and stamped');
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('the desk assembles below EnvironmentDesk and above ValidationReadyDesk', () => {
  const at = (id: PulseDeskId): number => {
    const found = PULSE_PIPELINE.indexOf(id);
    assert.ok(found >= 0, `${id} takes a position in the pulse`);
    return found;
  };
  const graph = at('graph');
  const environments = at('environments');
  const sheets = at('remoteValidation');
  const ready = at('validationReady');
  const closeOuts = at('closeOuts');
  assert.ok(graph < environments, 'attribution walks the graph the arrivals are read off');
  assert.ok(environments < sheets, 'above it, every sheet would be one pulse late forever, with nothing red');
  assert.ok(sheets < ready, 'below it, the bench row would state the pulse before the readings landed');
  assert.ok(ready < closeOuts, 'the bench asks for one thing at a time');
});

test('nothing under src/dispatcher/ imports src/remoteValidation/ or src/environments/', () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) files.push(path);
    }
  };
  walk('src/dispatcher');
  const readers = files
    .filter((f) => /from '(\.\.\/)+(remoteValidation|environments)\//.test(readFileSync(f, 'utf8')))
    .sort();
  assert.deepEqual(readers, [], 'the sheet is a lens; the dispatcher decides from the world and the store');
});
