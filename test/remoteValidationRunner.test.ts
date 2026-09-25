import { test } from 'node:test';
import { commentSink } from './support/commentSink.js';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { RemoteValidationDesk } from '../src/validation/remote/desk.js';
import { StateQueryDesk } from '../src/validation/remote/stateQueries.js';
import { FakeStateReader } from '../src/validation/remote/fakeStateReader.js';
import { parseSelectorListing } from '../src/validation/remote/runner.js';
import { preflightRows } from '../src/validation/remote/preflight.js';
import { runnableSelectors } from '../src/validation/remote/briefing.js';
import { FakeEnvironmentObserver, watchRow } from '../src/environments/fakeObserver.js';
import { queryDigest } from '../src/store/remoteValidation.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { StateQueryInput, ValidationCheck, ValidationCheckInput, ValidationStep } from '../src/types.js';

/*
 * Reading a runner's listing, and what the harness does *not* spawn to get one. Every
 * project-supplied browser command in this design is a live shell command against a real environment,
 * and **the harness now spawns none of them**: the run agent invokes all three in its pinned
 * checkout, so there is no runner seam and nothing to inject a fake for. What is left here is the
 * parser, the delimiter guard, and the proof that assembly asks a runner nothing. The listing a sheet
 * is read against is taken by the run (`test/remoteValidationListing.test.ts`).
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
  proof: null,
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
 * A `suite` step, written straight onto the row. An area is named by such a step and by nothing else
 * (`test/planCoverageArea.test.ts`); these tests are about what a sheet does with one.
 */
function setArea(file: string, goalRef: string, checkId: string, area: string): void {
  const db = new Database(file);
  const step: ValidationStep = {
    kind: 'suite',
    do: `Run the ${area} area`,
    area,
    expects: null,
    when: 'inline',
    script: null,
    scriptSweptAt: null,
    actor: 'fleet',
    why: null,
  };
  try {
    db.prepare(`UPDATE validation_checks SET steps=? WHERE origin_ref=? AND id=?`).run(
      JSON.stringify([step]),
      goalRef,
      checkId,
    );
  } finally {
    db.close();
  }
}

interface Bench {
  dir: string;
  file: string;
  store: Store;
  desk: RemoteValidationDesk;
}

function bench(environments: EnvironmentConfig[] = [ACCEPTANCE]): Bench {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-preflight-'));
  const file = join(dir, 'harness.sqlite');
  const store = new Store(file);
  const desk = new RemoteValidationDesk({
    sink: commentSink(),
    validationRoot: dir,
    store,
    environments,
    observer: new FakeEnvironmentObserver(),
    queries: new StateQueryDesk({ store, environments, reader: reader() }),
    scriptGraceMs: 30 * 24 * 60 * 60 * 1000,
    probeIntervalMs: PROBE_MS,
    now: () => NOW,
  });
  return { dir, file, store, desk };
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
  const b = bench();
  try {
    seed(b, 'Reports, exports');
    await b.desk.run();

    const row = b.store.remoteValidation.listRemoteSheetRows().find((r) => r.kind === 'check');
    assert.match(row?.blockedReason ?? '', /LUBBDUBB_SELECTORS/, 'and the reason names the delimiter');
    assert.match(row?.blockedReason ?? '', /two selectors that do not exist/);
    assert.equal(row?.matched, null, 'and nothing at assembly counts a row another cause has already blocked');
    assert.deepEqual(
      runnableSelectors(b.store, ACCEPTANCE, 'issue:12', b.store.remoteValidation.listRemoteSheetRows()),
      [],
      'so nothing comma-joins it into the variable a project would mis-split',
    );
  } finally {
    shut(b);
  }
});

test('assembly spawns nothing, and the sheet it writes carries no matched and no blockedReason', async () => {
  const b = bench();
  try {
    for (let n = 1; n <= 7; n += 1) seed(b, AREA, `issue:${String(n)}`);
    await b.desk.run();
    await b.desk.run();

    // A renamed or deleted area is exactly what the assembly-time listing used to block these rows
    // for. Assembly asks nothing now, so it blocks nothing: the mismatch is the run's own listing to
    // find, one press later, against the commit the environment is actually running.
    const rows = b.store.remoteValidation.listRemoteSheetRows().filter((r) => r.kind === 'check');
    assert.equal(rows.length, 7, 'every sheet is assembled exactly as it always was, five to a pass');
    for (const row of rows) {
      assert.equal(row.blockedReason, null, 'nothing at assembly blocks a row on what a runner offers');
      assert.equal(row.matched, null, 'and nothing at assembly writes a denominator');
    }
    assert.deepEqual(
      runnableSelectors(b.store, ACCEPTANCE, 'issue:1', b.store.remoteValidation.listRemoteSheetRows()),
      [AREA],
      'so the row is pressable, and the press is where its area is put to the deployed runner',
    );

    await b.desk.run();
  } finally {
    shut(b);
  }
});

test('the listing read leaves a row another cause already blocked exactly as it is', () => {
  assert.deepEqual(
    preflightRows({
      environment: 'acceptance',
      rows: [
        { rowId: 'check:a', kind: 'check', sourceId: 'a', blockedReason: 'acceptance does not permit check rows' },
        { rowId: 'state:b', kind: 'state', sourceId: 'b', blockedReason: null },
      ],
      checks: [{ id: 'a', steps: [] } as unknown as ValidationCheck],
      listing: { offers: [], detail: null },
    }),
    [],
    'an unpermitted kind is not a selector mismatch, and a state row is not a question for a runner',
  );
});

test('a database carrying remote_selector_offerings loses it on the boot that takes the build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-offerings-drop-'));
  const file = join(dir, 'with-the-cache.sqlite');
  try {
    const before = new Store(file);
    before.close();
    const seedDb = new Database(file);
    seedDb.exec(`CREATE TABLE IF NOT EXISTS remote_selector_offerings (
      environment TEXT NOT NULL, selector TEXT NOT NULL, tests INTEGER, listed_at TEXT NOT NULL,
      PRIMARY KEY (environment, selector))`);
    seedDb
      .prepare(`INSERT INTO remote_selector_offerings VALUES (?, ?, ?, ?)`)
      .run('acceptance', AREA, 4, '2026-01-01T00:00:00.000Z');
    seedDb.close();
    assert.ok(tables(file).includes('remote_selector_offerings'), 'a database from before the cache was retired');

    new Store(file).close();
    assert.ok(
      !tables(file).includes('remote_selector_offerings'),
      'the drop is one of three edits: the CREATE goes from the schema in the same change, because ' +
        '`rebuildTables` re-runs the schema straight after the drop and would recreate it empty every boot',
    );

    new Store(file).close();
    assert.ok(!tables(file).includes('remote_selector_offerings'), 'and a second boot is a no-op, not a second drop');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function tables(file: string): string[] {
  const db = new Database(file);
  try {
    return (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(
      (t) => t.name,
    );
  } finally {
    db.close();
  }
}
