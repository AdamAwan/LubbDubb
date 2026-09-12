import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { RemoteValidationDesk } from '../src/remoteValidation/desk.js';
import { RemoteRunDesk } from '../src/remoteValidation/run.js';
import { StateQueryDesk } from '../src/remoteValidation/stateQueries.js';
import { FakeStateReader } from '../src/remoteValidation/fakeStateReader.js';
import { FakeRemoteRunner } from '../src/remoteValidation/fakeRemoteRunner.js';
import { FakeTenantKeeper } from '../src/remoteValidation/fakeTenantKeeper.js';
import { FakeEnvironmentObserver, watchRow } from '../src/environments/fakeObserver.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { queryDigest } from '../src/store/remoteValidation.js';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { validationVerdict } from '../src/validation/verdict.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { RemoteRowOutcome, StateQueryInput, ValidationCheckInput } from '../src/types.js';

/*
 * The press, the pin and the lock. → docs/spec/36-remote-validation.md#the-press
 *
 * Every test here injects `FakeStateReader`, `FakeTenantKeeper`, `FakeEnvironmentProber` and
 * `FakeEnvironmentObserver`: the defaults are the command implementations, so a test that configures
 * a `validate` block and injects none of them spawns the project's own scripts against a real
 * environment — and passes while doing it.
 */

const NOW = Date.parse('2026-09-08T12:00:00.000Z');
const LANDED = 'aaaaaaa1111111111111111111111111111111aa';
const DEPLOYED = 'bbbbbbb2222222222222222222222222222222bb';

const ACCEPTANCE: EnvironmentConfig = {
  name: 'acceptance',
  at: './scripts/deployed-sha.sh acceptance',
  validate: {
    permits: ['state'],
    tenant: 'validation-customer-1',
    reseed: './scripts/reseed.sh',
    tenantFreshnessMs: 7 * 86_400_000,
    state: { run: './scripts/query.sh acceptance' },
  },
};

const QUERY: StateQueryInput = {
  id: 'orders-carry-a-channel',
  seq: 1,
  title: 'Every order written since the change carries a channel',
  query: 'select id, channel from orders where channel is null',
  presence: 'select id from orders limit 5',
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

interface Bench {
  store: Store;
  runs: RemoteRunDesk;
  prober: FakeEnvironmentProber;
  git: FakeGitObserver;
  reader: FakeStateReader;
  tenants: FakeTenantKeeper;
  close(): void;
}

function bench(
  opts: {
    environments?: EnvironmentConfig[];
    heads?: Record<string, string[]>;
    contains?: [string, string, boolean][];
    env?: Record<string, string | undefined>;
    now?: () => number;
  } = {},
): Bench {
  const environments = opts.environments ?? [ACCEPTANCE];
  const store = new Store(':memory:');
  const reader = new FakeStateReader({
    [`${QUERY.id}:presence`]: JSON.stringify([watchRow(QUERY.id, { id: 1 })]),
    [`${QUERY.id}:state`]: JSON.stringify([]),
  });
  const prober = new FakeEnvironmentProber(opts.heads ?? { acceptance: [DEPLOYED] });
  const git = new FakeGitObserver();
  for (const [head, commit, held] of opts.contains ?? [[DEPLOYED, LANDED, true]]) git.setContains(head, commit, held);
  const tenants = new FakeTenantKeeper();
  const desk = new RemoteValidationDesk({
    store,
    environments,
    observer: new FakeEnvironmentObserver(),
    queries: new StateQueryDesk({ store, environments, reader }),
    runner: new FakeRemoteRunner(),
    scriptGraceMs: 30 * 24 * 60 * 60 * 1000,
    probeIntervalMs: 60_000,
    now: opts.now ?? (() => NOW),
  });
  const runs = new RemoteRunDesk({
    store,
    environments,
    desk,
    prober,
    git,
    tenants,
    now: opts.now ?? (() => NOW),
    env: opts.env ?? {},
  });
  return { store, runs, prober, git, reader, tenants, close: () => store.close() };
}

/** A goal delivered, landed, arrived and sheeted — the state a press is made from. */
function seed(store: Store, environment = 'acceptance', opts: { approve?: boolean } = {}): void {
  store.validation.ingestValidation('issue:12', {
    checks: [CHECK],
    resources: [],
    supersededReason: '',
    amendNote: '',
  });
  store.remoteValidation.saveStateQueries('issue:12', [QUERY], 'agent');
  store.verdicts.recordDelivery({ originRef: 'issue:12', summary: 'PR #40 landed it', by: 'assessor' });
  store.environments.recordGoalLanding({ prNumber: 40, goalRef: 'issue:12', sha: LANDED });
  if (opts.approve !== false)
    store.remoteValidation.approveStateQuery({
      digest: queryDigest(QUERY.query, QUERY.presence),
      environment,
      originRef: 'issue:12',
      queryId: QUERY.id,
      rows: 0,
      detail: null,
    });
  store.remoteValidation.openRemoteSheet({ goalRef: 'issue:12', environment });
  store.remoteValidation.saveRemoteSheetRows('issue:12', environment, [
    {
      rowId: `check:${CHECK.id}`,
      kind: 'check',
      seq: 1,
      title: CHECK.title,
      sourceId: CHECK.id,
      selected: true,
      blockedReason: null,
      awaitingApproval: false,
      matched: null,
    },
    {
      rowId: `state:${QUERY.id}`,
      kind: 'state',
      seq: 2,
      title: QUERY.title,
      sourceId: QUERY.id,
      selected: true,
      blockedReason: null,
      awaitingApproval: false,
      matched: null,
    },
  ]);
}

test('a press opens one run, reads the confirmed rows and attributes them to the commits it straddled', async () => {
  const b = bench();
  try {
    seed(b.store);
    const pressed = await b.runs.press('issue:12', 'acceptance');

    assert.equal(pressed.ok, true);
    assert.equal(pressed.ok && pressed.abandoned, null, 'the pin opened the run');
    assert.equal(b.store.remoteValidation.listRemoteRuns().length, 1);
    const run = b.store.remoteValidation.listRemoteRuns()[0]!;
    assert.equal(run.status, 'ended');
    assert.equal(run.tenant, 'validation-customer-1');
    assert.equal(run.startedSha, DEPLOYED);
    assert.equal(run.endedSha, DEPLOYED);

    const reading = b.store.remoteValidation.listRemoteReadings().find((r) => r.runId === run.id);
    assert.equal(reading?.rowId, `state:${QUERY.id}`, 'the check row is a person’s, and nothing ran it');
    assert.equal(reading?.outcome, 'passed');
    assert.equal(reading?.startedSha, DEPLOYED, 'a reading with no commit beside it names no product');
    assert.equal(reading?.endedSha, DEPLOYED);

    assert.deepEqual(b.tenants.asked, [], 'a press never provisions or reseeds a tenant');
  } finally {
    b.close();
  }
});

test('two concurrent presses on one (environment, tenant) yield one run; two tenants yield two', async () => {
  const b = bench();
  try {
    seed(b.store);
    // The lock is a conditional insert *inside* the transaction, never a check the caller makes
    // first — so both presses reaching `beginRemoteRun` still produce one run.
    const one = b.store.remoteValidation.beginRemoteRun({
      goalRef: 'issue:12',
      environment: 'acceptance',
      tenant: 'validation-customer-1',
      startedSha: DEPLOYED,
    });
    const two = b.store.remoteValidation.beginRemoteRun({
      goalRef: 'issue:12',
      environment: 'acceptance',
      tenant: 'validation-customer-1',
      startedSha: DEPLOYED,
    });
    assert.notEqual(one.run, null);
    assert.equal(two.run, null, 'the second press is refused by the store, not by the caller');
    assert.equal(two.live?.id, one.run?.id, 'and it is told which run holds the lock');

    const other = b.store.remoteValidation.beginRemoteRun({
      goalRef: 'issue:12',
      environment: 'acceptance',
      tenant: 'validation-customer-2',
      startedSha: DEPLOYED,
    });
    assert.notEqual(other.run, null, 'a second tenant on one environment is a second run, never a race');
    assert.equal(b.store.remoteValidation.listRemoteRuns().length, 2);
  } finally {
    b.close();
  }
});

test('a press while a run is live is refused, naming the tenant', async () => {
  const b = bench();
  try {
    seed(b.store);
    b.store.remoteValidation.beginRemoteRun({
      goalRef: 'issue:12',
      environment: 'acceptance',
      tenant: 'validation-customer-1',
      startedSha: DEPLOYED,
    });
    const pressed = await b.runs.press('issue:12', 'acceptance');

    assert.equal(pressed.ok, false);
    assert.equal(!pressed.ok && pressed.code, 409);
    assert.match(!pressed.ok ? pressed.error : '', /validation-customer-1/, 'a clash names what is holding it');
    assert.deepEqual(b.store.remoteValidation.listRemoteReadings(), [], 'and nothing was read');
  } finally {
    b.close();
  }
});

test('a press with nothing selected is refused 400 and opens no run', async () => {
  const b = bench();
  try {
    seed(b.store);
    for (const rowId of [`check:${CHECK.id}`, `state:${QUERY.id}`])
      b.store.remoteValidation.setRemoteSheetRowSelected('issue:12', 'acceptance', rowId, false);
    const pressed = await b.runs.press('issue:12', 'acceptance');

    assert.equal(pressed.ok, false);
    assert.equal(!pressed.ok && pressed.code, 400);
    assert.deepEqual(b.store.remoteValidation.listRemoteRuns(), [], 'a press that learns nothing opens no run');
  } finally {
    b.close();
  }
});

test('the pin: every landing reached opens the run', async () => {
  const b = bench({ contains: [[DEPLOYED, LANDED, true]] });
  try {
    seed(b.store);
    const pressed = await b.runs.press('issue:12', 'acceptance');
    assert.equal(pressed.ok && pressed.abandoned, null);
    assert.equal(b.store.remoteValidation.listRemoteRuns()[0]?.status, 'ended');
  } finally {
    b.close();
  }
});

test('the pin: a landing the environment no longer holds abandons, and writes no reading at all', async () => {
  const b = bench({ contains: [[DEPLOYED, LANDED, false]] });
  try {
    seed(b.store);
    const before = b.store.remoteValidation.listRemoteSheetRows();
    const pressed = await b.runs.press('issue:12', 'acceptance');

    assert.equal(pressed.ok, true);
    assert.match(pressed.ok ? (pressed.abandoned ?? '') : '', /gone back past this goal's work/);
    assert.deepEqual(b.store.remoteValidation.listRemoteReadings(), [], 'an abandoned press writes no readings at all');
    assert.deepEqual(
      b.store.remoteValidation.listRemoteSheetRows().map((r) => r.blockedReason),
      before.map((r) => r.blockedReason),
      'and blocked on nothing — a row an abandoned press touched is exactly as it was',
    );
    assert.deepEqual(b.reader.asked, [], 'no command was put to the store');
  } finally {
    b.close();
  }
});

test('the pin: an unknown is abandoned rather than assumed present, and says which it is', async () => {
  // The clone answering `null` — an expired credential, a missing binary, a commit that never
  // shipped. Folding it into either arm is the quiet failure the three-valued verdict exists for.
  const b = bench({ contains: [] });
  try {
    seed(b.store);
    const pressed = await b.runs.press('issue:12', 'acceptance');

    assert.equal(pressed.ok, true);
    const why = pressed.ok ? (pressed.abandoned ?? '') : '';
    assert.match(why, /the clone could not say/);
    assert.doesNotMatch(why, /gone back past/, 'an unknown is never reported as a rollback');
    assert.equal(b.store.remoteValidation.listRemoteRuns()[0]?.status, 'abandoned');
    assert.deepEqual(b.store.remoteValidation.listRemoteReadings(), []);
  } finally {
    b.close();
  }
});

test('an environment that has moved forward still runs, where a rollback abandons', async () => {
  // The pair that separates this pin from 32's. A deployed environment is *supposed* to move: a
  // design that abandoned on sha inequality would starve any project that deploys faster than it
  // validates. What matters is whether the work is still in the deployed commit.
  const AHEAD = 'ccccccc3333333333333333333333333333333cc';

  const forward = bench({ heads: { acceptance: [AHEAD] }, contains: [[AHEAD, LANDED, true]] });
  try {
    seed(forward.store);
    const pressed = await forward.runs.press('issue:12', 'acceptance');
    assert.equal(pressed.ok && pressed.abandoned, null, 'a forward move is not a rollback');
    assert.equal(
      forward.store.remoteValidation.listRemoteRuns()[0]?.startedSha,
      AHEAD,
      'and the reading is pinned to where it is now',
    );
    assert.equal(forward.store.remoteValidation.listRemoteReadings().length, 1);
  } finally {
    forward.close();
  }

  const back = bench({ heads: { acceptance: [AHEAD] }, contains: [[AHEAD, LANDED, false]] });
  try {
    seed(back.store);
    const pressed = await back.runs.press('issue:12', 'acceptance');
    assert.match(pressed.ok ? (pressed.abandoned ?? '') : '', /gone back past/);
    assert.deepEqual(back.store.remoteValidation.listRemoteReadings(), []);
  } finally {
    back.close();
  }
});

test('an ended run is kept, and an abandoned one’s reason is readable afterwards', async () => {
  const b = bench({ contains: [[DEPLOYED, LANDED, false]] });
  try {
    seed(b.store);
    await b.runs.press('issue:12', 'acceptance');

    const kept = b.store.remoteValidation.listRemoteRuns();
    assert.equal(kept.length, 1, 'a run is never deleted');
    assert.equal(kept[0]?.status, 'abandoned');
    assert.match(kept[0]?.note ?? '', /gone back past this goal's work/, 'the case an operator actually hits');
  } finally {
    b.close();
  }
});

test('a later run supersedes a reading rather than deleting it', async () => {
  const b = bench();
  try {
    seed(b.store);
    await b.runs.press('issue:12', 'acceptance');
    await b.runs.press('issue:12', 'acceptance');

    const readings = b.store.remoteValidation.listRemoteReadings().filter((r) => r.rowId === `state:${QUERY.id}`);
    assert.equal(readings.length, 2, 'remote_readings is append-only');
    assert.notEqual(readings[0]?.runId, readings[1]?.runId, 'and each is attributed to its own run');
  } finally {
    b.close();
  }
});

test('cancel settles an open run abandoned, so the press is never absent for good', async () => {
  const b = bench();
  try {
    seed(b.store);
    b.store.remoteValidation.beginRemoteRun({
      goalRef: 'issue:12',
      environment: 'acceptance',
      tenant: 'validation-customer-1',
      startedSha: DEPLOYED,
    });
    const cancelled = b.runs.cancel('acceptance', null);

    assert.equal(cancelled?.status, 'abandoned');
    assert.match(cancelled?.note ?? '', /called this run off/);
    assert.equal(b.store.remoteValidation.liveRemoteRun('acceptance', 'validation-customer-1'), null);
    assert.equal(b.runs.cancel('acceptance', null), null, 'and there is nothing left to call off');
  } finally {
    b.close();
  }
});

test('a press writes no shortfall, no issue verdict, no WorldEvent and nothing into watch_readings', async () => {
  const answering = bench();
  try {
    seed(answering.store);
    const before = answering.store.world.listWorldEvents(50).length;
    await answering.runs.press('issue:12', 'acceptance');

    assert.equal(answering.store.world.listWorldEvents(50).length, before, 'a reading is never a WorldEvent');
    assert.deepEqual(answering.store.watches.listWatchReadings(), [], 'and never a watch reading: different clocks');
    assert.equal(answering.store.verdicts.getShortfall('issue:12'), null, 'a failed row is never a shortfall');
    assert.notEqual(answering.store.verdicts.getDelivery('issue:12'), null, 'the goal stays delivered, and parked');
  } finally {
    answering.close();
  }
});

test('the outcome vocabulary stays passed | failed | blocked, whatever a tenant’s age is', async () => {
  const STALE = { ...ACCEPTANCE, validate: { ...ACCEPTANCE.validate!, tenantFreshnessMs: 1 } };
  const b = bench({ environments: [STALE] });
  try {
    seed(b.store);
    await b.runs.press('issue:12', 'acceptance');

    const vocabulary: RemoteRowOutcome[] = ['passed', 'failed', 'blocked'];
    for (const reading of b.store.remoteValidation.listRemoteReadings())
      assert.ok(vocabulary.includes(reading.outcome), `${reading.outcome} is not one of the three`);
    assert.match(
      b.store.remoteValidation.listRemoteReadings()[0]?.detail ?? '',
      /against `validation-customer-1`/,
      'staleness is a qualifier on the reading, never a fourth outcome',
    );
  } finally {
    b.close();
  }
});

/*
 * The routes, at the seam an operator actually reaches them through. Every handler is wrapped in
 * `checked(schemas, handler)` and a refusal is a returned value and a status, never a throw.
 * → docs/spec/36-remote-validation.md#routes
 */

function server(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-press-route-'));
  const environments = [ACCEPTANCE];
  return buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      repoRoot: dir,
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      environments,
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      stateReader: new FakeStateReader({
        [`${QUERY.id}:presence`]: JSON.stringify([watchRow(QUERY.id, { id: 1 })]),
        [`${QUERY.id}:state`]: JSON.stringify([]),
      }),
      tenants: new FakeTenantKeeper(),
      environmentProber: new FakeEnvironmentProber({ acceptance: [DEPLOYED] }),
      environmentObserver: new FakeEnvironmentObserver(),
      gitObserver: new FakeGitObserver().setContains(DEPLOYED, LANDED, true),
      projectConfigFile: join(dir, 'absent.json'),
      errorMirror: () => {},
    },
  );
}

test('the run route is the only one here that runs a cycle, and refuses 409 and 400 as returned values', async () => {
  const system = server();
  const { app } = await buildApp(system);
  try {
    seed(system.store);
    let cycles = 0;
    const ran = system.harness.runCycle.bind(system.harness);
    system.harness.runCycle = async (why: Parameters<typeof ran>[0]) => {
      cycles += 1;
      return ran(why);
    };

    const url = '/api/issues/12/remote-validation/acceptance';
    const pressed = await app.inject({ method: 'POST', url: `${url}/run` });
    assert.equal(pressed.statusCode, 200);
    assert.equal(cycles, 1, 'the press runs a cycle: the run is work, and a heartbeat away is minutes on nothing');

    system.store.remoteValidation.beginRemoteRun({
      goalRef: 'issue:12',
      environment: 'acceptance',
      tenant: 'validation-customer-1',
      startedSha: DEPLOYED,
    });
    const clash = await app.inject({ method: 'POST', url: `${url}/run` });
    assert.equal(clash.statusCode, 409);
    assert.match((clash.json() as { error: string }).error, /validation-customer-1/);

    const cancelled = await app.inject({ method: 'POST', url: `${url}/cancel` });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(system.store.remoteValidation.liveRemoteRun('acceptance', 'validation-customer-1'), null);

    for (const rowId of [`check:${CHECK.id}`, `state:${QUERY.id}`]) {
      const dropped = await app.inject({
        method: 'POST',
        url: `${url}/rows/${encodeURIComponent(rowId)}`,
        payload: { selected: false },
      });
      assert.equal(dropped.statusCode, 200);
    }
    const empty = await app.inject({ method: 'POST', url: `${url}/run` });
    assert.equal(empty.statusCode, 400, 'a press with nothing selected refuses rather than opening a run');

    const nowhere = await app.inject({
      method: 'POST',
      url: `${url}/rows/state%3Anot-a-row`,
      payload: { selected: true },
    });
    assert.equal(nowhere.statusCode, 404);
    assert.equal(cycles, 1, 'and no other route here schedules anything');
  } finally {
    await app.close();
    system.store.close();
  }
});

test('waiving is not a route here: the sheet’s retire path is validation’s own, and a deferral is not clear', async () => {
  const system = server();
  const { app } = await buildApp(system);
  try {
    seed(system.store);
    const url = `/api/issues/12/validation/${CHECK.id}`;

    const nothingSaid = await app.inject({ method: 'POST', url: `${url}/waive`, payload: {} });
    assert.equal(nothingSaid.statusCode, 400, 'a waive requires a reason — retiring a check is an act somebody signs');

    const deferred = await app.inject({
      method: 'POST',
      url: `${url}/defer`,
      payload: { reason: 'the acceptance data is not seeded yet' },
    });
    assert.equal(deferred.statusCode, 200);
    assert.equal(
      validationVerdict(system.store.validation.listValidationChecks('issue:12')).state,
      'flagged',
      'a deferred check does not count as clear at close-out',
    );

    const waived = await app.inject({
      method: 'POST',
      url: `${url}/waive`,
      payload: { reason: 'the product has moved past this path, and the new one is covered' },
    });
    assert.equal(waived.statusCode, 200);
    const checks = system.store.validation.listValidationChecks('issue:12');
    assert.equal(validationVerdict(checks).state, 'clear', 'a waived one does');
    assert.equal(
      checks.find((c) => c.id === CHECK.id)?.resultNote,
      'the product has moved past this path, and the new one is covered',
    );

    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/issues/12/remote-validation/acceptance/waive' })).statusCode,
      404,
      'and the sheet grows no second waive route — two representations of one operator act would disagree',
    );
  } finally {
    await app.close();
    system.store.close();
  }
});
