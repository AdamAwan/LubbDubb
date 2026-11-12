import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system/system.js';
import { buildApp } from '../src/server/app.js';
import { Store } from '../src/store/store.js';
import { SCHEMA } from '../src/store/schema.js';
import { WATCH_COLUMNS } from '../src/store/watches.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeEnvironmentObserver, watchRow } from '../src/environments/fakeObserver.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { CommandEnvironmentObserver } from '../src/environments/observer.js';
import { preparedQuery, WATCH_ID_COLUMN } from '../src/environments/watchResult.js';
import { resolveWatchSource, watchSources } from '../src/environments/watchSource.js';
import { watchFindings, watchWindowReadings } from '../src/environments/watchFinding.js';
import { validateEnvironments, type EnvironmentConfig } from '../src/environments/policy.js';
import { WatchCheckSchema, WatchSchema, watchCheckInputs } from '../src/validation/watchDocument.js';
import { watchNote } from '../src/plans/planning.js';
import type { GoalWatchInput } from '../src/types.js';

const PROBE_MS = 5 * 60 * 1000;

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
  source: null,
};

const MEASURE: GoalWatchInput = {
  id: 'orders-landed',
  seq: 2,
  kind: 'measure',
  title: 'Orders still land',
  query: 'select count(*) as value from orders where created_at > {since} and created_at <= {until}',
  presence: null,
  tolerate: 0,
  expectUnder: null,
  expectOver: 10,
  expectBaseline: false,
  unit: null,
  why: null,
  source: 'sql',
};

const TWO_SOURCES: EnvironmentConfig = {
  name: 'liveUk',
  at: 'echo unused',
  watch: {
    sources: {
      logs: {
        language: 'kql',
        runBy: 'harness',
        observe: './scripts/ai-query.sh liveUk',
        queryUrl: 'https://portal.example/#/{queryGzip}',
      },
      sql: { language: 'sql', runBy: 'harness', observe: './scripts/sql.sh liveUk' },
    },
  },
};

const LOGS_ONLY: EnvironmentConfig = {
  name: 'liveEu',
  at: 'echo unused',
  watch: { observe: './scripts/ai-query.sh liveEu' },
};

function refusal(environment: object): string {
  try {
    validateEnvironments([{ name: 'liveUk', at: 'echo x', ...environment } as EnvironmentConfig]);
  } catch (err) {
    return (err as Error).message;
  }
  return '';
}

test('"observe" alone is the shorthand for one kql source the harness runs, called logs', () => {
  assert.deepEqual(watchSources({ observe: './t.sh', queryUrl: 'https://x/{query}' }), [
    { name: 'logs', language: 'kql', runBy: 'harness', observe: './t.sh', queryUrl: 'https://x/{query}' },
  ]);
  assert.deepEqual(
    watchSources(TWO_SOURCES.watch).map((s) => [s.name, s.language, s.runBy]),
    [
      ['logs', 'kql', 'harness'],
      ['sql', 'sql', 'harness'],
    ],
  );
  assert.deepEqual(watchSources(undefined), []);
  validateEnvironments([TWO_SOURCES, LOGS_ONLY]);
  validateEnvironments([
    { name: 'a', at: 'x', watch: { sources: { sql: { language: 'sql', runBy: 'operator', queryUrl: 'q/{query}' } } } },
  ]);
});

test('validateEnvironments refuses each shape of source that would read nothing', () => {
  const harness = { language: 'kql', runBy: 'harness', observe: './t.sh' };
  assert.match(refusal({ watch: { observe: './t.sh', sources: { logs: harness } } }), /both "observe" and "sources"/);
  assert.match(refusal({ watch: { sources: {} } }), /"watch.sources" is empty/);
  assert.match(
    refusal({ watch: { sources: { logs: { language: 'kql', runBy: 'harness' } } } }),
    /harness runs needs a non-empty "observe"/,
  );
  assert.match(
    refusal({ watch: { sources: { sql: { language: 'sql', runBy: 'operator', observe: './sql.sh' } } } }),
    /run by the operator declares no "observe"/,
  );
  assert.match(
    refusal({ watch: { sources: { logs: { ...harness, language: 'splunk' } } } }),
    /kql \/ sql \/ promql \/ other/,
  );
  assert.match(refusal({ watch: { sources: { logs: { ...harness, runBy: 'cron' } } } }), /"runBy" must be/);
  assert.match(
    refusal({ watch: { queryUrl: 'https://x/{query}', sources: { logs: harness } } }),
    /beside "watch.sources" is read by nothing/,
  );
  assert.match(
    refusal({ watch: { sources: { logs: { ...harness, queryUrl: 'https://x/' } } } }),
    /"queryUrl" carries none/,
  );
  assert.match(refusal({ watch: {} }), /"watch.observe" must be a non-empty command/);
});

test('a check names its source, and every writer carries it', () => {
  const parsed = WatchSchema.parse({
    signals: [{ id: SIGNAL.id, title: SIGNAL.title, query: SIGNAL.query, presence: SIGNAL.presence, source: 'logs' }],
    measures: [{ id: MEASURE.id, title: MEASURE.title, query: MEASURE.query, expect: { over: 10 }, source: 'sql' }],
  });
  assert.deepEqual(
    watchCheckInputs(parsed).map((c) => [c.id, c.source]),
    [
      ['no-timeouts', 'logs'],
      ['orders-landed', 'sql'],
    ],
  );
  const unnamed = WatchCheckSchema.parse({
    kind: 'measure',
    id: 'm',
    title: 't',
    query: 'q {since} {until}',
    expect: { under: 1 },
  });
  assert.equal(unnamed.source, undefined);
  assert.ok(!WatchCheckSchema.safeParse({ ...unnamed, source: 'two words' }).success);
});

test('goal_watches.source is declared in WATCH_COLUMNS, so a database from before it gains it on boot', () => {
  assert.equal(WATCH_COLUMNS.goal_watches?.source, 'TEXT');
  const path = join(mkdtempSync(join(tmpdir(), 'lubbdubb-watch-source-')), 'old.db');
  const db = new Database(path);
  db.exec(SCHEMA);
  db.exec('ALTER TABLE goal_watches DROP COLUMN source');
  db.prepare(
    `INSERT INTO goal_watches (goal_ref, check_id, seq, kind, title, query, presence, tolerate, created_at, updated_at)
     VALUES ('issue:12', 'no-timeouts', 1, 'signal', 't', 'q {since}', 'p {since}', 0, '2026-01-01', '2026-01-01')`,
  ).run();
  db.close();

  const store = new Store(path);
  const [check] = store.watches.listGoalWatches();
  assert.equal(check?.source, null, "null reads the environment's only source, which is what every old row read");
  store.watches.ingestGoalWatch('issue:12', [{ ...SIGNAL, source: 'logs' }]);
  assert.equal(store.watches.listGoalWatches()[0]?.source, 'logs');
  store.close();
});

function build(observer: FakeEnvironmentObserver, environments: EnvironmentConfig[]): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-watch-sources-'));
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

function arrived(system: System, environment: string, checks: GoalWatchInput[]): void {
  system.store.watches.ingestGoalWatch('issue:12', checks);
  system.store.environments.recordGoalArrival({
    goalRef: 'issue:12',
    environment,
    arrivedAt: new Date(Date.now() - 60_000).toISOString(),
  });
}

const ANSWERS = {
  'no-timeouts:presence': JSON.stringify([watchRow('no-timeouts', { runs: 96 })]),
  'no-timeouts:signal': '[]',
  'orders-landed:measure': JSON.stringify([watchRow('orders-landed', { value: 40 })]),
};

test('a check reads the source it names, with LUBBDUBB_WATCH_SOURCE and its language beside the query', async () => {
  const observer = new FakeEnvironmentObserver(ANSWERS);
  const system = build(observer, [TWO_SOURCES]);
  arrived(system, 'liveUk', [{ ...SIGNAL, source: 'logs' }, MEASURE]);

  await system.harness.runCycle();

  assert.deepEqual(
    observer.asked.map((a) => [a.checkId, a.kind, a.source, a.language]),
    [
      ['no-timeouts', 'presence', 'logs', 'kql'],
      ['no-timeouts', 'signal', 'logs', 'kql'],
      ['orders-landed', 'measure', 'sql', 'sql'],
    ],
  );
  assert.deepEqual(
    system.store.watches.listWatchReadings().map((r) => [r.checkId, r.verdict]),
    [
      ['no-timeouts', 'clean'],
      ['orders-landed', 'clean'],
    ],
  );
  system.store.close();
});

test('an environment without the source a check names reads it unknown there, naming the source', async () => {
  const observer = new FakeEnvironmentObserver(ANSWERS);
  const system = build(observer, [LOGS_ONLY]);
  arrived(system, 'liveEu', [SIGNAL, MEASURE]);

  await system.harness.runCycle();

  const readings = system.store.watches.listWatchReadings();
  const measure = readings.find((r) => r.checkId === 'orders-landed');
  assert.equal(measure?.verdict, 'unknown', 'never clean, and never a refusal of the whole watch');
  assert.equal(measure?.detail, 'liveEu has no `sql` source');
  assert.equal(readings.find((r) => r.checkId === 'no-timeouts')?.verdict, 'clean', 'the rest is read as ever');
  assert.ok(!observer.asked.some((a) => a.checkId === 'orders-landed'), 'nothing is put to a source that is not there');
  system.store.close();
});

test('a check naming no source on an environment declaring several reads unknown, naming them', () => {
  const resolved = resolveWatchSource(TWO_SOURCES, { source: null, kind: 'signal' });
  assert.equal(resolved.source, null);
  assert.match(resolved.refusal ?? '', /liveUk declares 2 sources \(`logs`, `sql`\) and this check names none/);
  assert.equal(resolveWatchSource(LOGS_ONLY, { source: null, kind: 'signal' }).source?.name, 'logs');
});

test('an operator-run source spawns nothing yet, and its checks read unknown saying so', async () => {
  const observer = new FakeEnvironmentObserver(ANSWERS);
  const operator: EnvironmentConfig = {
    name: 'liveUk',
    at: 'echo unused',
    watch: { sources: { sql: { language: 'sql', runBy: 'operator' } } },
  };
  const system = build(observer, [operator]);
  arrived(system, 'liveUk', [MEASURE]);

  await system.harness.runCycle();

  assert.deepEqual(observer.asked, []);
  const [reading] = system.store.watches.listWatchReadings();
  assert.equal(reading?.verdict, 'unknown');
  assert.match(reading?.detail ?? '', /operator-run sources are not read yet/);
  system.store.close();
});

const METRICS: EnvironmentConfig = {
  name: 'liveUk',
  at: 'echo unused',
  watch: { sources: { metrics: { language: 'promql', runBy: 'harness', observe: './prom.sh' } } },
};

test('a promql source takes measures only: a signal naming it is refused where it is saved, and unknown where it is read', async () => {
  const system = build(new FakeEnvironmentObserver(ANSWERS), [METRICS]);
  const { app } = await buildApp(system);
  const res = await app.inject({
    method: 'PUT',
    url: '/api/issues/12/watch/checks/no-timeouts',
    payload: {
      kind: 'signal',
      id: 'no-timeouts',
      title: SIGNAL.title,
      query: SIGNAL.query,
      presence: SIGNAL.presence,
      tolerate: 0,
      source: 'metrics',
    },
  });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /promql source, which takes measures only/);
  assert.deepEqual(system.store.watches.listGoalWatches(), []);
  await app.close();
  system.store.close();

  const observer = new FakeEnvironmentObserver(ANSWERS);
  const reading = build(observer, [METRICS]);
  arrived(reading, 'liveUk', [{ ...SIGNAL, source: 'metrics' }]);
  await reading.harness.runCycle();
  assert.deepEqual(observer.asked, [], 'the planner wrote it, and nothing is put to the source');
  assert.match(reading.store.watches.listWatchReadings()[0]?.detail ?? '', /takes measures only/);
  reading.store.close();
});

test('the id projection is appended to kql alone; every other language relies on the wrapper', () => {
  const kql = preparedQuery(
    SIGNAL.query,
    { since: '2026-01-01T00:00:00Z', until: '2026-01-02T00:00:00Z' },
    'no-timeouts',
    'signal',
    'kql',
  );
  assert.match(kql.query ?? '', /\| extend lubbdubbWatchId = "no-timeouts"$/);
  for (const language of ['sql', 'promql', 'other'] as const) {
    const put = preparedQuery(
      MEASURE.query,
      { since: '2026-01-01T00:00:00Z', until: '2026-01-02T00:00:00Z' },
      'orders-landed',
      'measure',
      language,
    );
    assert.equal(
      put.query,
      'select count(*) as value from orders where created_at > 2026-01-01T00:00:00Z and created_at <= 2026-01-02T00:00:00Z',
      language,
    );
  }
});

test('the command is told which source it is asked of', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-watch-source-cmd-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const observer = new CommandEnvironmentObserver(dir, 5_000);
    const result = await observer.observe({
      environment: 'liveUk',
      command: `node -e 'process.stdout.write(JSON.stringify([{value: 1, source: process.env.LUBBDUBB_WATCH_SOURCE, q: process.env.LUBBDUBB_WATCH_QUERY, ${JSON.stringify(WATCH_ID_COLUMN)}: process.env.LUBBDUBB_WATCH_ID}]))'`,
      source: 'sql',
      language: 'sql',
      checkId: 'orders-landed',
      query: MEASURE.query,
      kind: 'measure',
      since: '2026-01-01T00:00:00Z',
      until: '2026-01-02T00:00:00Z',
    });
    assert.equal(result.verdict, 'answered', 'the wrapper echoed the id, which is the verification for sql');
    assert.equal(result.rows?.[0]?.['source'], 'sql');
    assert.ok(!String(result.rows?.[0]?.['q']).includes('extend'), 'no pipeline segment on a sql query');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the dry run puts a check to the first environment that declares its source', async () => {
  const observer = new FakeEnvironmentObserver(ANSWERS);
  const system = build(observer, [LOGS_ONLY, TWO_SOURCES]);
  system.store.watches.ingestGoalWatch('issue:12', [SIGNAL, MEASURE]);

  await system.watch.run('issue:12');

  const checks = system.store.watches.listGoalWatches();
  assert.equal(checks.find((c) => c.id === 'no-timeouts')?.dryRunEnvironment, 'liveEu');
  assert.equal(checks.find((c) => c.id === 'orders-landed')?.dryRunEnvironment, 'liveUk');
  system.store.close();
});

test("the bench row fences each query in its source's language, and links through that source", () => {
  const window = {
    goalRef: 'issue:12',
    environment: 'liveUk',
    openedAt: '2026-01-01T00:00:00Z',
    settlesAt: '2026-01-03T00:00:00Z',
    settledAt: null,
    extendedAt: null,
    exposedAt: null,
  };
  const check = (input: GoalWatchInput) => ({
    ...input,
    originRef: 'issue:12',
    dryRunEnvironment: null,
    dryRunAt: null,
    dryRunVerdict: null,
    dryRunPresence: null,
    dryRunRows: null,
    dryRunDetail: null,
    baselineValue: null,
    baselineAt: null,
    live: true,
    proposal: null,
    authored: 'plan' as const,
  });
  const regressed = (checkId: string) => ({
    goalRef: 'issue:12',
    environment: 'liveUk',
    checkId,
    readAt: '2026-01-01T01:00:00Z',
    verdict: 'regressed' as const,
    rows: 3,
    value: null,
    detail: 'it fired',
  });
  const [step] = watchFindings({
    readings: watchWindowReadings({
      windows: [window],
      checks: [check({ ...SIGNAL, source: 'logs' }), check(MEASURE)],
      readings: [regressed('no-timeouts'), regressed('orders-landed')],
      environments: [TWO_SOURCES],
    }),
    existing: [],
  });
  assert.equal(step?.kind, 'file');
  const detail = step?.kind === 'file' ? step.detail : '';
  assert.match(detail, /```kql\ntraces/);
  assert.match(detail, /```sql\nselect count/);
  assert.equal(detail.match(/Run it on liveUk/g)?.length, 1, 'only the source that names a queryUrl links');
});

test('the authoring note lists each environment’s sources, their language and who runs them', () => {
  const note = watchNote([
    TWO_SOURCES,
    { name: 'liveEu', watch: { sources: { sql: { language: 'sql', runBy: 'operator' } } } },
  ]);
  assert.match(note, /\*\*liveUk\*\*: `logs` \(kql, run by the harness\), `sql` \(sql, run by the harness\)/);
  assert.match(note, /\*\*liveEu\*\*: `sql` \(sql, run by the operator\)/);
  assert.match(note, /run by the harness costs nothing/);
  assert.match(note, /run by the operator costs a person's time/);
  assert.match(watchNote([METRICS]), /promql source takes \*\*measures only\*\*/);
});
