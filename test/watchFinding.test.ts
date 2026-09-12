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
import { watchQueryUrl } from '../src/environments/watchQueryUrl.js';
import { gunzipSync } from 'node:zlib';

const PROBE_MS = 5 * 60 * 1000;

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

const REGRESSED = {
  'no-timeouts:presence': JSON.stringify([watchRow('no-timeouts', { runs: 96 })]),
  'no-timeouts:signal': JSON.stringify([watchRow('no-timeouts', { role: 'worker' })]),
};
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

function arrived(system: System, environment = 'testUk'): void {
  system.store.watches.ingestGoalWatch('issue:12', [SIGNAL]);
  system.store.environments.recordGoalArrival({
    goalRef: 'issue:12',
    environment,
    arrivedAt: new Date(Date.now() - 60_000).toISOString(),
  });
}

function delivered(system: System): void {
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Job X keeps timing out' });
  system.store.verdicts.recordDelivery({ originRef: 'issue:12', summary: 'PR #40 landed it', by: 'assessor' });
}

test('a settled-regressed watch files one row, and a second reading files no second one', async () => {
  const observer = new FakeEnvironmentObserver(REGRESSED);
  const system = build(observer, [OPEN]);
  arrived(system);

  await system.harness.runCycle();
  const filed = system.store.humanTasks.listHumanTasksOfKind('watch');
  assert.equal(filed.length, 1);
  assert.match(filed[0]!.title, /watch on testUk/);
  assert.equal(filed[0]!.originRef, 'issue:12');
  assert.match(filed[0]!.detail ?? '', /Job X stops timing out/);
  assert.match(filed[0]!.detail ?? '', /answered 1 row where the check declared none at all/);

  system.store.watches.recordWatchReading({
    goalRef: 'issue:12',
    environment: 'testUk',
    checkId: 'no-timeouts',
    verdict: 'regressed',
    rows: 4,
    value: null,
    detail: 'testUk answered 4 rows where the check declared none at all.',
  });
  await system.harness.runCycle();

  const after = system.store.humanTasks.listHumanTasksOfKind('watch');
  assert.equal(after.length, 1, 'one row per window, never one per reading');
  assert.equal(after[0]!.id, filed[0]!.id);
  assert.match(after[0]!.detail ?? '', /4 rows/, 'and its detail states what the watch says now');
  system.store.close();
});

test('a settled-unknown watch files nothing — it is not a finding', async () => {
  const observer = new FakeEnvironmentObserver(UNKNOWN);
  const system = build(observer, [SETTLES_AT_ONCE]);
  arrived(system);

  await system.harness.runCycle();
  await system.harness.runCycle();

  assert.notEqual(system.store.watches.listWatchWindows()[0]?.settledAt, null, 'settled, and settled unread');
  assert.deepEqual(system.store.humanTasks.listHumanTasksOfKind('watch'), []);
  system.store.close();
});

test('a reading that comes back clean retracts the row, and a later regression brings it back', async () => {
  const observer = new FakeEnvironmentObserver(REGRESSED);
  const system = build(observer, [OPEN]);
  arrived(system);
  await system.harness.runCycle();
  const [row] = system.store.humanTasks.listHumanTasksOfKind('watch');
  assert.equal(row?.status, 'open');

  system.store.watches.recordWatchReading({
    goalRef: 'issue:12',
    environment: 'testUk',
    checkId: 'no-timeouts',
    verdict: 'clean',
    rows: 0,
    value: null,
    detail: null,
  });
  await system.harness.runCycle();
  const settled = system.store.humanTasks.getHumanTask(row!.id)!;
  assert.equal(settled.status, 'done');
  assert.match(settled.resolution ?? '', /Settled by the harness/);

  system.store.watches.recordWatchReading({
    goalRef: 'issue:12',
    environment: 'testUk',
    checkId: 'no-timeouts',
    verdict: 'regressed',
    rows: 2,
    value: null,
    detail: 'testUk answered 2 rows where the check declared none at all.',
  });
  await system.harness.runCycle();
  const back = system.store.humanTasks.getHumanTask(row!.id)!;
  assert.equal(back.status, 'open', 'reopened rather than re-filed');
  assert.equal(system.store.humanTasks.listHumanTasksOfKind('watch').length, 1);
  system.store.close();
});

test('the close-out carries what the watch says and does not hold it, with holds absent', async () => {
  const observer = new FakeEnvironmentObserver(REGRESSED);
  const system = build(observer, [OPEN]);
  arrived(system);
  delivered(system);

  await system.harness.runCycle();
  await system.harness.runCycle();

  const [row] = system.store.humanTasks.listHumanTasksOfKind('close_out');
  assert.ok(row, 'a watch holds nothing by default — the row is filed while it is open');
  assert.equal(row.status, 'open');
  assert.match(row.detail ?? '', /testUk is answering outside what was declared/);
  assert.match(row.detail ?? '', /holds nothing/);
  system.store.close();
});

test('a goal delivered with a watch still open closes in front of the reading, not past it', async () => {
  const observer = new FakeEnvironmentObserver(CLEAN);
  const system = build(observer, [OPEN]);
  arrived(system);
  delivered(system);

  await system.harness.runCycle();
  await system.harness.runCycle();
  const [row] = system.store.humanTasks.listHumanTasksOfKind('close_out');
  assert.match(row!.detail ?? '', /read every declared check clean/);
  assert.match(row!.detail ?? '', /still open, and holds nothing/);

  system.store.watches.recordWatchReading({
    goalRef: 'issue:12',
    environment: 'testUk',
    checkId: 'no-timeouts',
    verdict: 'unknown',
    rows: null,
    value: null,
    detail: 'the watch could not read testUk',
  });
  await system.harness.runCycle();
  assert.match(system.store.humanTasks.getHumanTask(row!.id)!.detail ?? '', /could not be read/);
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
    system.store.humanTasks.listHumanTasksOfKind('close_out'),
    [],
    'the stricter thing a team opts into — and it withholds from the delivery, not from the arrival',
  );

  system.store.watches.settleWatchWindow('issue:12', 'testUk');
  await system.harness.runCycle();
  const [row] = system.store.humanTasks.listHumanTasksOfKind('close_out');
  assert.ok(row, 'a settled watch has said what it is going to say');
  assert.match(row.detail ?? '', /read every declared check clean/);
  system.store.close();
});

test('extend re-opens the settled window, and the verdict it fixed is still readable', async () => {
  const observer = new FakeEnvironmentObserver(REGRESSED);
  const system = build(observer, [SETTLES_AT_ONCE]);
  arrived(system);
  await system.harness.runCycle();

  system.store.watches.recordWatchReading({
    goalRef: 'issue:12',
    environment: 'testUk',
    checkId: 'no-timeouts',
    verdict: 'regressed',
    rows: 1,
    value: null,
    detail: 'testUk answered 1 row where the check declared none at all.',
  });
  const before = system.store.watches.listWatchWindows()[0]!;
  assert.notEqual(before.settledAt, null);

  const extended = system.store.watches.extendWatchWindow(
    'issue:12',
    'testUk',
    new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  );

  assert.equal(system.store.watches.listWatchWindows().length, 1, 'one window, not two');
  assert.equal(extended?.settledAt, null, 'watching again');
  assert.notEqual(extended?.extendedAt, null, 'and stamped, so the card can say why its end is not the arrival’s');
  assert.equal(extended?.openedAt, before.openedAt, 'and nothing else moved');
  assert.deepEqual(
    system.store.watches.listWatchReadings().map((r) => r.verdict),
    ['regressed'],
    'the verdict that was fixed is still readable',
  );
  system.store.close();
});

test('extend answers nothing for a goal or environment with no window', () => {
  const observer = new FakeEnvironmentObserver(CLEAN);
  const system = build(observer, [OPEN]);
  const at = new Date(Date.now() + 1000).toISOString();
  assert.equal(system.store.watches.extendWatchWindow('issue:12', 'testUk', at), null);
  assert.deepEqual(system.store.watches.listWatchWindows(), []);
  system.store.close();
});

test('the extend route refuses a window that is not there, and an environment that asks nothing', async () => {
  const observer = new FakeEnvironmentObserver(CLEAN);
  const system = build(observer, [OPEN, { name: 'liveUk', at: 'echo unused' }]);
  arrived(system);
  await system.harness.runCycle();

  const { app } = await buildApp(system);
  const missing = await app.inject({ method: 'POST', url: '/api/issues/99/watch/testUk/extend' });
  assert.equal(missing.statusCode, 404);
  const unwatched = await app.inject({ method: 'POST', url: '/api/issues/12/watch/liveUk/extend' });
  assert.equal(unwatched.statusCode, 409);

  const extended = await app.inject({ method: 'POST', url: '/api/issues/12/watch/testUk/extend' });
  assert.equal(extended.statusCode, 200);
  assert.notEqual(system.store.watches.listWatchWindows()[0]?.extendedAt, null);
  await app.close();
  system.store.close();
});

test('nothing a finding does is written as a WorldEvent', async () => {
  const observer = new FakeEnvironmentObserver(REGRESSED);
  const system = build(observer, [OPEN]);
  arrived(system);
  delivered(system);

  await system.harness.runCycle();
  await system.harness.runCycle();
  assert.equal(system.store.humanTasks.listHumanTasksOfKind('watch').length, 1, 'the finding did happen');

  const events = system.store.world.listWorldEvents();
  assert.deepEqual(
    events.filter((e) => /watch|regress/i.test(`${e.kind} ${e.summary}`)),
    [],
    'watch readings have their own table and their own wire list, merged at the feed’s door',
  );
  system.store.close();
});

test('the row carries the declaration the reading is measured against, so it can be acted on from the row', async () => {
  const observer = new FakeEnvironmentObserver(REGRESSED);
  const system = build(observer, [OPEN]);
  system.store.watches.ingestGoalWatch('issue:12', [{ ...SIGNAL, why: 'job X timing out is what the fix was for' }]);
  system.store.environments.recordGoalArrival({
    goalRef: 'issue:12',
    environment: 'testUk',
    arrivedAt: new Date(Date.now() - 60_000).toISOString(),
  });

  await system.harness.runCycle();
  const detail = system.store.humanTasks.listHumanTasksOfKind('watch')[0]?.detail ?? '';

  assert.match(detail, /^### Job X stops timing out$/m, 'the check\u2019s title is a heading, not another paragraph');
  assert.match(detail, /Why it was declared:\*\* job X timing out is what the fix was for/);
  assert.match(
    detail,
    /```kql\ntraces \| where message has 'job X timed out'\n```/,
    'the query, verbatim and runnable, in a fence that names what it is',
  );
  assert.match(detail, /\*\*Raise a bug\*\*/, 'and what each of the row\u2019s three answers says');
  assert.match(detail, /\*\*Decline\*\*/);
  system.store.close();
});

test('a queryUrl puts a link to run the query on the row, and no template draws no link', async () => {
  const observer = new FakeEnvironmentObserver(REGRESSED);
  const linked: EnvironmentConfig = {
    ...OPEN,
    watch: { ...OPEN.watch!, queryUrl: 'https://portal.example/logs?q={query}' },
  };
  const system = build(observer, [linked]);
  arrived(system);

  await system.harness.runCycle();
  const detail = system.store.humanTasks.listHumanTasksOfKind('watch')[0]?.detail ?? '';

  assert.match(
    detail,
    /\[Run it on testUk \u2197\]\(https:\/\/portal\.example\/logs\?q=traces%20%7C%20where%20message%20has%20'job%20X%20timed%20out'\)/,
    'the declared query, encoded into the operator\u2019s own template',
  );
  system.store.close();

  const plain = build(new FakeEnvironmentObserver(REGRESSED), [OPEN]);
  arrived(plain);
  await plain.harness.runCycle();
  assert.doesNotMatch(
    plain.store.humanTasks.listHumanTasksOfKind('watch')[0]?.detail ?? '',
    /Run it on/,
    'an environment that named no template draws no link rather than a dead one',
  );
  plain.store.close();
});

test('a check that declared no why still carries its query, and says nothing where there is nothing to say', async () => {
  const observer = new FakeEnvironmentObserver(REGRESSED);
  const system = build(observer, [OPEN]);
  arrived(system);

  await system.harness.runCycle();
  const detail = system.store.humanTasks.listHumanTasksOfKind('watch')[0]?.detail ?? '';

  assert.doesNotMatch(detail, /Why it was declared/);
  assert.match(detail, /To see the rows yourself/);
  system.store.close();
});

test('watchQueryUrl fills both substitutions, and a gzipped one round-trips', () => {
  const query = "traces | where message has 'job X timed out'";
  assert.equal(watchQueryUrl(undefined, query), null, 'no template is no link');
  assert.equal(watchQueryUrl('  ', query), null);
  assert.equal(
    watchQueryUrl('https://p.example/logs?q={query}', query),
    `https://p.example/logs?q=${encodeURIComponent(query)}`,
  );

  const gzipped = watchQueryUrl('https://p.example#q={queryGzip}', query) ?? '';
  const encoded = decodeURIComponent(gzipped.slice(gzipped.indexOf('#q=') + 3));
  assert.equal(
    gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8'),
    query,
    'the portal that unpacks it gets the declared query, character for character',
  );
});
