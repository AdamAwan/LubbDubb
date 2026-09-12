import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { RemoteValidationDesk } from '../src/remoteValidation/desk.js';
import { StateQueryDesk } from '../src/remoteValidation/stateQueries.js';
import { FakeStateReader } from '../src/remoteValidation/fakeStateReader.js';
import { FakeRemoteRunner } from '../src/remoteValidation/fakeRemoteRunner.js';
import { CommandRemoteRunner, parseSelectorListing, runnerEnv } from '../src/remoteValidation/runner.js';
import { preflightRows } from '../src/remoteValidation/preflight.js';
import { runnableSelectors } from '../src/remoteValidation/briefing.js';
import { FakeEnvironmentObserver, watchRow } from '../src/environments/fakeObserver.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { queryDigest } from '../src/store/remoteValidation.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { StateQueryInput, ValidationCheck, ValidationCheckInput } from '../src/types.js';

/*
 * The runner seam and the pre-flight. Every project-supplied command in this design is a live shell
 * command against a real environment — a browser suite most of all — so what these tests assert
 * about the fake is asserted on **its own record of what it was asked for**, never on an absence.
 *
 * → docs/spec/36-remote-validation.md#the-runner-contract
 */

const PROBE_MS = 60_000;
const NOW = Date.parse('2026-09-08T12:00:00.000Z');
const AREA = 'checkout';

const ACCEPTANCE: EnvironmentConfig = {
  name: 'acceptance',
  at: 'echo unused',
  validate: {
    permits: ['check', 'state'],
    tenant: 'validation-customer-1',
    browser: {
      runner: 'npm run e2e -- --project=validation',
      listSelectors: 'npm run e2e -- --project=validation --list',
      profile: 'acc-uk',
      publishArtefacts: './scripts/publish-report.sh',
    },
    state: { run: './query.sh acceptance' },
  },
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

const QUERY: StateQueryInput = {
  id: 'orders-carry-a-channel',
  seq: 1,
  title: 'Every order written since the change carries a channel',
  query: 'select id, channel from orders where channel is null',
  presence: 'select id from orders limit 5',
  why: null,
};

function reader(): FakeStateReader {
  return new FakeStateReader({
    [`${QUERY.id}:presence`]: JSON.stringify([watchRow(QUERY.id, { id: 1 })]),
    [`${QUERY.id}:state`]: JSON.stringify([]),
  });
}

/**
 * The column, written directly. An area is really inherited from the `coverage` of a test part the
 * check covers (`test/planCoverageArea.test.ts`); these tests are about what the pre-flight does with
 * one, so they set it where the join would have.
 */
function setArea(file: string, goalRef: string, checkId: string, area: string): void {
  const db = new Database(file);
  try {
    db.prepare(`UPDATE validation_checks SET area=? WHERE origin_ref=? AND id=?`).run(area, goalRef, checkId);
  } finally {
    db.close();
  }
}

function columns(file: string, table: string): string[] {
  const db = new Database(file);
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  } finally {
    db.close();
  }
}

interface Bench {
  dir: string;
  file: string;
  store: Store;
  desk: RemoteValidationDesk;
  runner: FakeRemoteRunner;
}

function bench(runner: FakeRemoteRunner, environments: EnvironmentConfig[] = [ACCEPTANCE]): Bench {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-preflight-'));
  const file = join(dir, 'harness.sqlite');
  const store = new Store(file);
  const desk = new RemoteValidationDesk({
    store,
    environments,
    observer: new FakeEnvironmentObserver(),
    queries: new StateQueryDesk({ store, environments, reader: reader() }),
    runner,
    scriptGraceMs: 30 * 24 * 60 * 60 * 1000,
    probeIntervalMs: PROBE_MS,
    now: () => NOW,
  });
  return { dir, file, store, desk, runner };
}

function shut(b: Bench): void {
  b.store.close();
  rmSync(b.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

function seed(b: Pick<Bench, 'store' | 'file'>, area: string | null = AREA, goalRef = 'issue:12'): void {
  b.store.validation.ingestValidation(goalRef, { checks: [CHECK], resources: [], supersededReason: '', amendNote: '' });
  b.store.remoteValidation.saveStateQueries(goalRef, [QUERY], 'agent');
  b.store.remoteValidation.approveStateQuery({
    digest: queryDigest(QUERY.query, QUERY.presence),
    environment: 'acceptance',
    originRef: goalRef,
    queryId: QUERY.id,
    rows: 0,
    detail: null,
  });
  if (area !== null) setArea(b.file, goalRef, CHECK.id, area);
  b.store.environments.recordGoalArrival({
    goalRef,
    environment: 'acceptance',
    arrivedAt: new Date(NOW - 1000).toISOString(),
  });
}

function checkOf(store: Store, goalRef = 'issue:12'): ValidationCheck {
  const check = store.validation.listValidationChecks(goalRef)[0];
  assert.ok(check !== undefined);
  return check;
}

test('runnerEnv carries every parameter, and the command carries none of them', () => {
  const command = ACCEPTANCE.validate?.browser?.runner ?? '';
  assert.deepEqual(
    runnerEnv({
      environment: 'acceptance',
      command,
      profile: 'acc-uk',
      tenant: 'validation-customer-1',
      selectors: [AREA, 'refunds'],
      reportDir: '/tmp/run-7/report',
    }),
    {
      LUBBDUBB_ENVIRONMENT: 'acceptance',
      LUBBDUBB_PROFILE: 'acc-uk',
      LUBBDUBB_TENANT: 'validation-customer-1',
      LUBBDUBB_SELECTORS: 'checkout,refunds',
      LUBBDUBB_REPORT_DIR: '/tmp/run-7/report',
    },
  );
  // A command is never assembled from its parameters — the tenant's value most of all, which on a
  // `tenantEnv` deployment is per-operator and reaches the spawn env and nowhere else.
  for (const value of ['acc-uk', 'validation-customer-1', AREA, 'refunds', '/tmp/run-7/report'])
    assert.ok(!command.includes(value), `the command names no ${value}`);
  assert.equal(command, 'npm run e2e -- --project=validation', 'and it is the committed one, verbatim');
});

test('a listing is read as areas, and one that could not answer is never an offering of nothing', () => {
  assert.deepEqual(parseSelectorListing('[{"selector":"checkout","tests":12}]').offers, [
    { selector: AREA, tests: 12 },
  ]);
  assert.deepEqual(parseSelectorListing('checkout\nrefunds\n').offers, [
    { selector: AREA, tests: null },
    { selector: 'refunds', tests: null },
  ]);
  assert.equal(parseSelectorListing('   ').offers, null, 'nothing printed is never an empty offering');
  assert.match(parseSelectorListing('').detail ?? '', /printed nothing/);
});

test('a banner ahead of the listing is not read as areas, and prose is refused rather than guessed at', () => {
  // A suite's own config prints ahead of its report — a dotenv banner is the ordinary case, and it
  // holds a brace of its own, so seeking the first `{` is not enough.
  const banner = "injected env (10) from .env // tip: custom filepath { path: '/custom/path/.env' }";
  const prefixed = parseSelectorListing(
    `${banner}\n[{"selector":"checkout","tests":2},{"selector":"refunds","tests":63}]`,
  );
  assert.equal(prefixed.detail, null);
  assert.deepEqual(prefixed.offers, [
    { selector: AREA, tests: 2 },
    { selector: 'refunds', tests: 63 },
  ]);

  // And a banner with no listing behind it answers *nothing*. Read as one name per line it offers
  // areas no check can match, which blocks every row naming a renamed area against a runner that
  // offered exactly the right ones — the same shape as an empty listing read as an answer.
  const garbage = parseSelectorListing(banner);
  assert.equal(garbage.offers, null, 'a banner is never an offering');
  assert.match(garbage.detail ?? '', /not a list of selectors/);
  for (const prose of ['{"tests": 4}', 'see https://example/docs // for the areas', `x${'y'.repeat(200)}`])
    assert.equal(parseSelectorListing(`checkout\n${prose}`).offers, null, `${prose.slice(0, 20)} is not an area`);
});

test('an area holding the delimiter its own list is joined on blocks its row at assembly', async () => {
  const b = bench(new FakeRemoteRunner({ acceptance: { listing: JSON.stringify([{ selector: AREA, tests: 12 }]) } }));
  try {
    seed(b, 'Reports, exports');
    await b.desk.run();

    const row = b.store.remoteValidation.listRemoteSheetRows().find((r) => r.kind === 'check');
    assert.match(row?.blockedReason ?? '', /LUBBDUBB_SELECTORS/, 'and the reason names the delimiter');
    assert.match(row?.blockedReason ?? '', /two selectors that do not exist/);
    assert.equal(row?.matched, null, 'the pre-flight leaves a row another cause has already blocked');
    assert.deepEqual(
      runnableSelectors(b.store, ACCEPTANCE, 'issue:12', b.store.remoteValidation.listRemoteSheetRows()),
      [],
      'so nothing comma-joins it into the variable a project would mis-split',
    );
  } finally {
    shut(b);
  }
});

test('CommandRemoteRunner spawns the project’s own command with the parameters as environment only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-runner-'));
  try {
    const runner = new CommandRemoteRunner(dir);
    const report = join(dir, 'report');
    const said = await runner.run({
      environment: 'acceptance',
      command:
        'node -e "console.log([process.env.LUBBDUBB_ENVIRONMENT, process.env.LUBBDUBB_PROFILE, ' +
        `process.env.LUBBDUBB_TENANT, process.env.LUBBDUBB_SELECTORS, process.env.LUBBDUBB_REPORT_DIR].join('|'))"`,
      profile: 'acc-uk',
      tenant: 'validation-customer-1',
      selectors: [AREA],
      reportDir: report,
    });
    assert.equal(said.detail, null);
    assert.equal((said.said ?? '').trim(), `acceptance|acc-uk|validation-customer-1|checkout|${report}`);

    // The exit code is never read: one invocation carries many rows and one code.
    const failed = await runner.run({
      environment: 'acceptance',
      command: `node -e "console.log('the report is written'); process.exit(3)"`,
      profile: null,
      tenant: null,
      selectors: [],
      reportDir: null,
    });
    assert.equal(failed.detail, null, 'a non-zero exit is not a run that could not be carried out');
    assert.match(failed.said ?? '', /the report is written/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('runTimeoutMs is the kill for a runner invocation and for nothing else, and a kill answers nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-runner-kill-'));
  const slow = `node -e "setTimeout(() => console.log('checkout'), 3000)"`;
  const request = { environment: 'acceptance', profile: null, tenant: null, selectors: [], reportDir: null };
  try {
    // A browser suite gets the long kill; the listing and the publish keep the ordinary 30-second one.
    const short = new CommandRemoteRunner(dir, 40, 30_000);
    const killed = await short.run({ ...request, command: slow });
    assert.equal(killed.said, null, 'the kill answers nothing rather than answering emptily');
    assert.match(killed.detail ?? '', /killed/);

    const long = new CommandRemoteRunner(dir, 30 * 60 * 1000, 40);
    const listing = await long.listSelectors({ ...request, command: slow });
    assert.equal(listing.offers, null, 'a killed listing offers nothing rather than offering none');
    assert.match(listing.detail ?? '', /killed/);
    const published = await long.publishArtefacts({ ...request, command: slow });
    assert.equal(published.said, null);
    assert.match(published.detail ?? '', /killed/);

    const ran = await long.run({ ...request, command: slow });
    assert.match(ran.said ?? '', /checkout/, 'and the same command inside the run timeout answers');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('the fake drives all three methods and spawns nothing, on its own record of what it was asked', async () => {
  const runner = new FakeRemoteRunner({
    acceptance: {
      listing: JSON.stringify([{ selector: AREA, tests: 4 }]),
      run: { said: 'report.json', detail: null },
      artefacts: { said: 'https://reports.example/run-7', detail: null },
    },
  });
  const request = {
    environment: 'acceptance',
    command: 'npm run e2e',
    profile: 'acc-uk',
    tenant: 'validation-customer-1',
    selectors: [AREA],
    reportDir: '/tmp/run-7',
  };
  assert.deepEqual((await runner.listSelectors(request)).offers, [{ selector: AREA, tests: 4 }]);
  assert.equal((await runner.run(request)).said, 'report.json');
  assert.equal((await runner.publishArtefacts(request)).said, 'https://reports.example/run-7');
  assert.deepEqual(
    runner.asked.map((a) => a.call),
    ['listSelectors', 'run', 'publishArtefacts'],
  );
  assert.deepEqual(runner.asked[0]?.selectors, [AREA]);
  assert.equal(runner.asked[1]?.tenant, 'validation-customer-1');
});

test('the pre-flight writes the matched count from the listing, before any press', async () => {
  const b = bench(new FakeRemoteRunner({ acceptance: { listing: JSON.stringify([{ selector: AREA, tests: 12 }]) } }));
  try {
    seed(b);
    await b.desk.run();

    const row = b.store.remoteValidation.listRemoteSheetRows().find((r) => r.kind === 'check');
    assert.equal(row?.matched, 12, 'the count is the listing’s, and nothing in this part has ever seen a report');
    assert.equal(row?.blockedReason, null);
    assert.equal(b.runner.asked[0]?.command, ACCEPTANCE.validate?.browser?.listSelectors);
    assert.equal(b.runner.asked[0]?.profile, 'acc-uk');
    assert.equal(b.runner.asked[0]?.tenant, 'validation-customer-1');
  } finally {
    shut(b);
  }
});

test('a check whose area the listing does not offer is blocked before a press, and writes nothing on the check', async () => {
  const b = bench(new FakeRemoteRunner({ acceptance: { listing: 'refunds\nsearch\n' } }));
  try {
    seed(b);
    await b.desk.run();

    const row = b.store.remoteValidation.listRemoteSheetRows().find((r) => r.kind === 'check');
    assert.equal(row?.matched, 0, 'zero matched, and zero matched is never a pass');
    assert.match(row?.blockedReason ?? '', /offers no selector `checkout`/);

    // A blocked row writes nothing at all: no reading, no verdict, no world event.
    assert.deepEqual(
      b.store.remoteValidation.listRemoteReadings().filter((r) => r.rowId === row?.rowId),
      [],
    );
    assert.equal(checkOf(b.store).state, 'unrun', 'the check is exactly as it was');
    assert.equal(checkOf(b.store).resultBy, null);
    assert.deepEqual(b.store.world.listWorldEvents(), [], 'and the pre-flight is a new writer: no WorldEvent');
    assert.deepEqual(b.store.watches.listWatchReadings(), [], 'nor anything in watch_readings');
  } finally {
    shut(b);
  }
});

test('a listing that could not answer blocks the check rows and leaves every other reading standing', async () => {
  const b = bench(new FakeRemoteRunner({ acceptance: { listingFailure: 'the command exited 1: no such project' } }));
  try {
    seed(b);
    await b.desk.run();

    const rows = b.store.remoteValidation.listRemoteSheetRows();
    const check = rows.find((r) => r.kind === 'check');
    assert.match(check?.blockedReason ?? '', /could not say which selectors it offers/);
    assert.equal(check?.matched, null, 'an unanswered listing counts nothing rather than counting zero');

    // `blocked` resolves per row, never per run.
    const state = rows.find((r) => r.kind === 'state');
    assert.equal(state?.blockedReason, null, 'the state row is untouched by a runner that could not answer');
    assert.equal(
      b.store.remoteValidation.listRemoteReadings().find((r) => r.rowId === state?.rowId)?.outcome,
      'passed',
      'and the reading it already landed stands',
    );
  } finally {
    shut(b);
  }
});

test('a check that names no area is a person’s, and the pre-flight asks nothing about it', async () => {
  const b = bench(new FakeRemoteRunner({ acceptance: { listing: 'refunds' } }));
  try {
    seed(b, null);
    await b.desk.run();

    const row = b.store.remoteValidation.listRemoteSheetRows().find((r) => r.kind === 'check');
    assert.equal(row?.blockedReason, null, 'a check declaring no area is manual, exactly as every check is today');
    assert.equal(row?.matched, null);
    assert.equal(
      b.runner.asked.length,
      1,
      'the one listing is the offering refresh, which is about the environment and not about this check',
    );
    await b.desk.run();
    assert.equal(b.runner.asked.length, 1, 'and the pre-flight asks nothing at all about a check naming no area');
  } finally {
    shut(b);
  }
});

test('the pre-flight runs on the assembly pass only, and inside the desk’s cap of five', async () => {
  const b = bench(new FakeRemoteRunner({ acceptance: { listing: JSON.stringify([{ selector: AREA, tests: 1 }]) } }));
  try {
    for (let n = 1; n <= 7; n += 1) seed(b, AREA, `issue:${String(n)}`);
    await b.desk.run();
    assert.equal(
      b.runner.asked.length,
      6,
      'a process spawn per sheet, bounded by the cap rather than the watch’s, beside the one offering refresh',
    );

    await b.desk.run();
    assert.equal(b.runner.asked.length, 8, 'the backlog drains in a fixed order and nothing starves');

    await b.desk.run();
    assert.equal(b.runner.asked.length, 8, 'and a stamped arrival is never re-listed');
  } finally {
    shut(b);
  }
});

test('a pre-flight that throws is recorded through errors.record and never fails the cycle', async () => {
  const logged: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-preflight-throw-'));
  const file = join(dir, 'harness.sqlite');
  const store = new Store(file);
  try {
    const environments = [ACCEPTANCE];
    const desk = new RemoteValidationDesk({
      store,
      environments,
      observer: new FakeEnvironmentObserver(),
      queries: new StateQueryDesk({ store, environments, reader: reader() }),
      runner: {
        listSelectors: () => {
          throw new Error('the runner blew up');
        },
      } as never,
      scriptGraceMs: 30 * 24 * 60 * 60 * 1000,
      probeIntervalMs: PROBE_MS,
      errors: { record: (e: { message: string }) => logged.push(e.message) } as never,
      now: () => NOW,
    });
    seed({ store, file });
    await desk.run();

    assert.equal(logged.length, 2, 'the offering refresh and the pre-flight each record their own failure');
    assert.match(logged[0] ?? '', /listing the selectors acceptance offers failed: the runner blew up/);
    assert.match(logged[1] ?? '', /pre-flight for issue:12 on acceptance failed: the runner blew up/);
    assert.equal(
      store.remoteValidation.listRemoteReadings().find((r) => r.rowId === `state:${QUERY.id}`)?.outcome,
      'passed',
      'and the rest of the assembly still ran',
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('the pre-flight leaves a row another cause already blocked exactly as it is', () => {
  assert.deepEqual(
    preflightRows({
      environment: 'acceptance',
      rows: [
        { rowId: 'check:a', kind: 'check', sourceId: 'a', blockedReason: 'acceptance does not permit check rows' },
        { rowId: 'state:b', kind: 'state', sourceId: 'b', blockedReason: null },
      ],
      checks: [{ id: 'a', area: AREA } as ValidationCheck],
      listing: { offers: [], detail: null },
    }),
    [],
    'an unpermitted kind is not a selector mismatch, and a state row is not a question for a runner',
  );
});

test('buildSystem takes remoteRunner, and defaults to the command implementation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-runner-system-'));
  const system = build(dir, [
    {
      name: 'acceptance',
      at: 'echo unused',
      validate: {
        permits: ['check'],
        browser: { runner: 'echo unused', listSelectors: `node -e "console.log('refunds')"` },
      },
    },
  ]);
  try {
    seedSystem(system, join(dir, 'harness.sqlite'));
    await system.harness.runCycle('manual');
    assert.match(
      system.store.remoteValidation.listRemoteSheetRows().find((r) => r.kind === 'check')?.blockedReason ?? '',
      /offers no selector `checkout`/,
      'the default spawned the project’s own command and read what it printed',
    );
  } finally {
    system.store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('an environment with no validate.browser block declares no command for a runner to run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-runner-none-'));
  const runner = new FakeRemoteRunner();
  const system = build(
    dir,
    [{ name: 'acceptance', at: 'echo unused', validate: { permits: ['state'], state: { run: './query.sh' } } }],
    runner,
  );
  try {
    seedSystem(system, join(dir, 'harness.sqlite'));
    await system.harness.runCycle('manual');
    assert.equal(
      system.store.remoteValidation.listRemoteSheetRows().length,
      1,
      'the sheet is assembled as it always was',
    );
    assert.deepEqual(runner.asked, [], 'and nothing is asked of a runner this environment does not declare');
  } finally {
    system.store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('a database written before validation_checks.area gains it on boot, and nothing is backfilled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-area-'));
  const file = join(dir, 'before-the-column.sqlite');
  try {
    const before = new Store(file);
    before.validation.ingestValidation('issue:12', {
      checks: [CHECK],
      resources: [],
      supersededReason: '',
      amendNote: '',
    });
    before.close();

    const raw = new Database(file);
    raw.exec('ALTER TABLE validation_checks DROP COLUMN area');
    raw.close();
    assert.ok(!columns(file, 'validation_checks').includes('area'), 'a database from before the column');

    const store = new Store(file);
    try {
      assert.ok(columns(file, 'validation_checks').includes('area'), 'gains it on the boot that takes the build');
      assert.equal(checkOf(store).area, null, 'and null means no area declared, which nothing backfills');
      assert.equal(checkOf(store).state, 'unrun', 'nothing else about the row moved');
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function build(dir: string, environments: EnvironmentConfig[], runner?: FakeRemoteRunner): System {
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: join(dir, 'harness.sqlite'),
    agentMode: 'raw',
    repoRoot: dir,
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    environments,
  });
  return buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    stateReader: reader(),
    ...(runner === undefined ? {} : { remoteRunner: runner }),
    environmentProber: new FakeEnvironmentProber(),
    gitObserver: new FakeGitObserver(),
    projectConfigFile: join(dir, 'absent.json'),
    environmentObserver: new FakeEnvironmentObserver(),
    errorMirror: () => {},
  });
}

function seedSystem(system: System, file: string): void {
  system.store.validation.ingestValidation('issue:12', {
    checks: [CHECK],
    resources: [],
    supersededReason: '',
    amendNote: '',
  });
  setArea(file, 'issue:12', CHECK.id, AREA);
  system.store.verdicts.recordDelivery({ originRef: 'issue:12', summary: 'PR #40 landed it', by: 'assessor' });
  system.store.environments.recordGoalArrival({
    goalRef: 'issue:12',
    environment: 'acceptance',
    arrivedAt: new Date().toISOString(),
  });
}
