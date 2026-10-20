import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/config.js';
import { buildSystem } from '../src/system/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeAppErrorReader } from '../src/appErrors/fakeReader.js';
import { appErrorKey } from '../src/appErrors/key.js';
import { MAX_LOOKBACK_MS } from '../src/appErrors/groups.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { AppErrorsPayload } from '../src/wire.js';

const ENVIRONMENTS: EnvironmentConfig[] = [
  { name: 'test', at: 'unused', errors: { list: './errors.sh test {since}' } },
  { name: 'liveUk', at: 'unused', group: 'prod', errors: { list: './errors.sh uk {since}' } },
  { name: 'liveEu', at: 'unused', group: 'prod', errors: { list: './errors.sh eu {since}' } },
  { name: 'hallway', at: 'unused' },
];

function build(
  reader: FakeAppErrorReader,
  prober: FakeEnvironmentProber,
  over: { appErrorIntervalMs?: number; appErrorIgnore?: string[] } = {},
) {
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    dbPath: ':memory:',
    heartbeatIntervalMs: 60_000,
    environments: ENVIRONMENTS,
    environmentProbeIntervalMs: 0,
    pool: { project: 'acme-api' },
    appErrorIntervalMs: over.appErrorIntervalMs ?? 0,
    appErrorIgnore: over.appErrorIgnore ?? [],
  });
  return buildSystem(config, {
    backend: new FakePtyBackend(),
    worktrees: new FakeWorktreeManager(),
    environmentProber: prober,
    appErrorReader: reader,
  });
}

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const HOUR = 60 * 60 * 1000;

function row(fingerprint: string, count: number, firstSeen: string, lastSeen: string) {
  return {
    fingerprint,
    title: `${fingerprint} failed`,
    count,
    firstSeen,
    lastSeen,
    operation: 'POST /orders',
    frames: ['src/Orders/OrderService.cs:118'],
    link: 'https://portal.azure.com/x',
  };
}

test('every environment that declares errors is read, bounded by {since}, and a failed read is unknown', async () => {
  const reader = new FakeAppErrorReader({
    test: JSON.stringify([row('Orders.Submit', 5, ago(2 * HOUR), ago(HOUR))]),
    liveUk: JSON.stringify([]),
    liveEu: 'Error: AADSTS700024 — the credential expired',
  });
  const heads: Record<string, string[]> = { test: ['aaa'], liveUk: ['bbb'], liveEu: ['bbb'] };
  const system = build(reader, new FakeEnvironmentProber(heads));

  await system.harness.runCycle();

  assert.deepEqual(
    reader.asked.map((r) => r.environment),
    ['test', 'liveUk', 'liveEu'],
    'hallway declares no errors command and is not asked',
  );
  const first = reader.asked[0]!;
  assert.equal(first.command, `./errors.sh test ${first.since}`);
  assert.ok(
    Math.abs(Date.parse(first.since) - (Date.now() - MAX_LOOKBACK_MS)) < 60_000,
    'a first read looks back a fortnight',
  );

  const reads = new Map(system.store.appErrors.listReads().map((r) => [r.environment, r]));
  assert.equal(reads.get('test')?.status, 'ok');
  const firstHead = system.store.environments.getEnvironmentHead('test');
  assert.equal(firstHead?.sha, 'aaa', 'the probe records the head even with no landing due');
  assert.equal(firstHead?.changedAt, null, 'the first head read is no deploy');
  assert.equal(system.store.environments.getEnvironmentHead('hallway'), null, 'nothing reads hallway’s head');
  assert.equal(reads.get('liveUk')?.status, 'ok', 'an empty list is an answer: no errors');
  assert.equal(reads.get('liveEu')?.status, 'unknown', 'a broken query is never "no errors"');
  assert.equal(reads.get('liveEu')?.okAt, null);
  assert.match(reads.get('liveEu')?.detail ?? '', /did not answer with JSON/);

  const groups = system.store.appErrors.listGroups();
  assert.deepEqual(
    groups.map((g) => [g.environment, g.fingerprint, g.daily.reduce((n, d) => n + d.count, 0)]),
    [['test', 'Orders.Submit', 5]],
  );

  reader.script('test', JSON.stringify([row('Orders.Submit', 2, ago(10 * 60_000), ago(5 * 60_000))]));
  heads['test'] = ['ccc'];
  await system.harness.runCycle();

  const second = reader.asked.filter((r) => r.environment === 'test')[1]!;
  assert.equal(second.since, reads.get('test')?.okAt, 'the next read starts where the last answered one did');
  const after = system.store.environments.getEnvironmentHead('test');
  assert.equal(after?.sha, 'ccc');
  assert.equal(after?.previousSha, 'aaa');
  assert.notEqual(after?.changedAt, null, 'a head that moved is a deploy');
  const held = system.store.appErrors.listGroups().find((g) => g.environment === 'test')!;
  assert.equal(
    held.daily.reduce((n, d) => n + d.count, 0),
    7,
    'counts accumulate across reads',
  );
});

test('an unknown read leaves what was known standing, and the next read reaches back past it', async () => {
  const reader = new FakeAppErrorReader({ test: JSON.stringify([row('Orders.Submit', 3, ago(HOUR), ago(HOUR))]) });
  const prober = new FakeEnvironmentProber({ test: ['aaa'] });
  const system = build(reader, prober);
  await system.harness.runCycle();
  const okAt = system.store.appErrors.getRead('test')?.okAt;

  reader.script('test', '');
  await system.harness.runCycle();
  reader.script('test', '[]');
  await system.harness.runCycle();

  const tests = reader.asked.filter((r) => r.environment === 'test');
  assert.equal(tests[2]?.since, okAt, 'the failed read did not move {since}');
  assert.equal(system.store.appErrors.listGroups().filter((g) => g.environment === 'test').length, 1);
});

test('an environment is not read again inside appErrorIntervalMs', async () => {
  const reader = new FakeAppErrorReader({ test: '[]', liveUk: '[]', liveEu: '[]' });
  const system = build(reader, new FakeEnvironmentProber(), { appErrorIntervalMs: HOUR });
  await system.harness.runCycle();
  await system.harness.runCycle();
  assert.equal(reader.asked.length, 3);
});

test('GET /api/app-errors draws each environment, its moved groups first, and the band roll-up', async () => {
  const reader = new FakeAppErrorReader({
    test: JSON.stringify([
      row('Orders.Submit', 5, ago(2 * HOUR), ago(HOUR)),
      row('Cart.Load', 1, ago(HOUR), ago(HOUR)),
    ]),
    liveUk: JSON.stringify([row('Orders.Submit', 9, ago(3 * HOUR), ago(HOUR))]),
    liveEu: '',
  });
  const prober = new FakeEnvironmentProber({ test: ['aaa'], liveUk: ['bbb'], liveEu: ['bbb'] });
  const system = build(reader, prober, { appErrorIgnore: ['Cart.Load'] });
  await system.harness.runCycle();

  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'GET', url: '/api/app-errors' });
  assert.equal(res.statusCode, 200);
  const body = res.json<AppErrorsPayload>();

  assert.equal(body.project, 'acme-api');
  assert.deepEqual(
    body.environments.map((e) => [e.environment, e.band, e.reading?.status]),
    [
      ['test', 'test', 'ok'],
      ['liveUk', 'prod', 'ok'],
      ['liveEu', 'prod', 'unknown'],
    ],
  );
  const onTest = body.environments[0]!.groups;
  assert.deepEqual(
    onTest.map((g) => [g.fingerprint, g.state, g.count, g.ignored]),
    [
      ['Orders.Submit', 'new', 5, false],
      ['Cart.Load', 'steady', 1, true],
    ],
  );
  const submit = onTest[0]!;
  assert.equal(submit.key, appErrorKey('acme-api', 'Orders.Submit'));
  assert.equal(submit.url, 'https://portal.azure.com/x');
  assert.equal(submit.operation, 'POST /orders');
  assert.deepEqual(submit.frames, ['src/Orders/OrderService.cs:118']);
  assert.equal(submit.daily.length, 14, 'the series is dense over the retained fortnight');
  assert.equal(
    submit.daily.reduce((n, d) => n + d.count, 0),
    submit.count,
    'the count is the series it ships',
  );
  assert.equal(body.environments[0]!.head?.sha, 'aaa');
  assert.equal(body.environments[0]!.head?.changedAt, null);
  assert.equal(submit.link?.goalRef, null, 'no goal has landed, so there is nothing to link to');
  assert.equal(submit.link?.candidates, 0);
  assert.equal(onTest[1]!.link, null, 'a muted group is not linked');
  assert.equal(submit.tracker, null, 'the tracker lock is not built yet');

  const prod = body.bands.find((b) => b.band === 'prod')!;
  assert.equal(prod.declared, true);
  assert.deepEqual(prod.environments, ['liveUk', 'liveEu']);
  assert.equal(prod.status, 'unknown', 'one member that could not answer is a band that could not answer');
  assert.deepEqual(
    prod.groups.map((g) => [g.key, g.environments, g.count]),
    [[submit.key, ['liveUk'], 9]],
    'one fingerprint on two environments is one key',
  );
  await app.close();
});

test('an errors command that is not bounded by {since} is refused at boot', () => {
  assert.throws(
    () => loadConfig({ environments: [{ name: 'live', at: 'x', errors: { list: './errors.sh live' } }] }),
    /carries no \{since\}/,
  );
  assert.throws(() => loadConfig({ environments: [{ name: 'live', at: 'x', errors: { list: ' ' } }] }), /non-empty/);
  assert.throws(() => loadConfig({ appErrorMinCount: 0 }), /appErrorMinCount/);
});
