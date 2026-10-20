import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeAppErrorReader } from '../src/appErrors/fakeReader.js';
import { appErrorKey, bodyCarriesKey } from '../src/appErrors/key.js';
import { AppErrorTrackerDesk, keysOwed, settleSearch } from '../src/appErrors/tracker.js';
import { FakeUpstreamIssues } from '../src/tickets/fakeUpstream.js';
import { Store } from '../src/store/store.js';
import type { ActionSink, IssueKeyHit, IssueKeySink } from '../src/sink/actionSink.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { AppErrorRead } from '../src/types.js';
import type { AppErrorGroupView, AppErrorPressPayload, AppErrorsPayload } from '../src/wire.js';

const ENVIRONMENTS: EnvironmentConfig[] = [{ name: 'test', at: 'unused', errors: { list: './errors.sh {since}' } }];
const HOUR = 60 * 60 * 1000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const KEY = appErrorKey('shop', 'Orders.Submit');

function errorsOn(fingerprint: string, count = 5): string {
  return JSON.stringify([
    {
      fingerprint,
      title: `${fingerprint} threw NullReferenceException`,
      count,
      firstSeen: ago(2 * HOUR),
      lastSeen: ago(HOUR),
      operation: 'POST /orders',
      frames: ['src/Orders/OrderService.cs:118', 'src/Orders/Api.cs:40'],
      link: 'https://portal.azure.com/problem/1',
    },
  ]);
}

/**
 * A system whose sink can be made to fail its searches: everything forwards to the real connector,
 * read through a proxy because the connector exists only once the system is built.
 */
function build(): { system: System; failSearch: (why: string | null) => void } {
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    dbPath: ':memory:',
    heartbeatIntervalMs: 60_000,
    environments: ENVIRONMENTS,
    environmentProbeIntervalMs: 0,
    pool: { project: 'shop' },
    appErrorIntervalMs: 0,
    labelPrefix: 'lubbdubb',
  });
  let failure: string | null = null;
  let target: System['connector'] | null = null;
  const sink = new Proxy({} as ActionSink, {
    get(_, prop: string) {
      if (prop === 'findIssuesByKeys' && failure !== null) return () => Promise.reject(new Error(failure!));
      const value = (target as unknown as Record<string, unknown>)[prop];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  const system = buildSystem(config, {
    backend: new FakePtyBackend(),
    worktrees: new FakeWorktreeManager(),
    environmentProber: new FakeEnvironmentProber({ test: ['aaa'] }),
    appErrorReader: new FakeAppErrorReader({ test: errorsOn('Orders.Submit') }),
    upstream: new FakeUpstreamIssues(),
    sink,
    errorMirror: () => {},
  });
  target = system.connector;
  system.config.integrations.issues = 'github';
  system.config.github = { owner: 'acme', repo: 'shop' };
  return {
    system,
    failSearch: (why) => {
      failure = why;
    },
  };
}

async function errorsTab(system: System): Promise<AppErrorGroupView> {
  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'GET', url: '/api/app-errors' });
  return (res.json() as AppErrorsPayload).environments[0]!.groups[0]!;
}

async function press(system: System, url: string, payload: Record<string, unknown>) {
  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'POST', url, payload });
  return { status: res.statusCode, body: res.json() as AppErrorPressPayload & { error?: string } };
}

function issues(system: System) {
  return system.connector.getState().then((w) => w.issues);
}

test('a moved group is searched for on the pulse, and the tab says no bug carries its key', async () => {
  const { system } = build();
  await system.harness.runCycle();

  const group = await errorsTab(system);
  assert.equal(group.key, KEY);
  assert.equal(group.state, 'new');
  assert.deepEqual(group.tracker, { status: 'none', ticketRef: null, note: null });
});

test('File bug searches again, files a bug carrying the key and no message, and a second press finds it', async () => {
  const { system } = build();
  await system.harness.runCycle();

  const first = await press(system, '/api/app-errors/file-bug', { environment: 'test', fingerprint: 'Orders.Submit' });
  assert.equal(first.status, 200);
  assert.equal(first.body.reused, false);
  const filed = (await issues(system)).find((i) => `issue:${i.number}` === first.body.ticketRef)!;
  assert.ok(bodyCarriesKey(filed.body, KEY), 'the key rides on the ticket, where the next search finds it');
  assert.match(filed.body, /src\/Orders\/OrderService\.cs:118/);
  assert.match(filed.body, /POST \/orders/);
  assert.match(filed.title, /^test: Orders\.Submit threw/);
  assert.deepEqual(filed.labels, [], 'File bug does not send the fleet onto it');

  const second = await press(system, '/api/app-errors/file-bug', { environment: 'test', fingerprint: 'Orders.Submit' });
  assert.equal(second.status, 200);
  assert.equal(second.body.reused, true, 'the search at the press found the open bug');
  assert.equal(second.body.ticketRef, first.body.ticketRef);
  assert.equal((await issues(system)).length, 1, 'no duplicate was filed');

  const group = await errorsTab(system);
  assert.equal(group.tracker?.status, 'open');
  assert.equal(group.tracker?.ticketRef, first.body.ticketRef);
});

test('a closed bug under a moved key reads closed and back, and Reopen reopens it', async () => {
  const { system } = build();
  await system.harness.runCycle();
  const filed = await press(system, '/api/app-errors/file-bug', { environment: 'test', fingerprint: 'Orders.Submit' });
  const number = Number(filed.body.ticketRef.split(':')[1]);
  system.connector.inject({ kind: 'issue_state', number, state: 'closed' });

  const searched = await press(system, '/api/app-errors/search', { key: KEY });
  assert.equal(searched.status, 200);
  const closed = await errorsTab(system);
  assert.equal(closed.tracker?.status, 'closed');
  assert.match(closed.tracker?.note ?? '', /^fixed \d{4}-\d{2}-\d{2}, error is back$/);

  const reopened = await press(system, '/api/app-errors/reopen', { key: KEY });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal(reopened.body.ticketRef, filed.body.ticketRef);
  assert.equal((await issues(system)).find((i) => i.number === number)?.state, 'open');
  assert.equal((await errorsTab(system)).tracker?.status, 'open');
});

test('a search that fails is unknown, never none, and File bug will not file over it unless told to', async () => {
  const { system, failSearch } = build();
  failSearch('secondary rate limit');
  await system.harness.runCycle();

  const group = await errorsTab(system);
  assert.equal(group.tracker?.status, 'unknown');
  assert.match(group.tracker?.note ?? '', /secondary rate limit/);

  const refused = await press(system, '/api/app-errors/file-bug', {
    environment: 'test',
    fingerprint: 'Orders.Submit',
  });
  assert.equal(refused.status, 502);
  assert.match(refused.body.error ?? '', /not filing what may be a duplicate/);
  assert.equal((await issues(system)).length, 0);

  const anyway = await press(system, '/api/app-errors/file-bug', {
    environment: 'test',
    fingerprint: 'Orders.Submit',
    unsearched: true,
  });
  assert.equal(anyway.status, 200);
  assert.equal((await issues(system)).length, 1);
});

test('Investigate files the bug with the watch tag and the investigate label the investigator reads', async () => {
  const { system } = build();
  await system.harness.runCycle();

  const res = await press(system, '/api/app-errors/investigate', { environment: 'test', fingerprint: 'Orders.Submit' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.investigation, { failed: [] });
  const filed = (await issues(system)).find((i) => `issue:${i.number}` === res.body.ticketRef)!;
  assert.deepEqual([...filed.labels].sort(), ['lubbdubb-investigate', 'lubbdubb-watch']);

  const again = await press(system, '/api/app-errors/investigate', {
    environment: 'test',
    fingerprint: 'Orders.Submit',
  });
  assert.equal(again.body.reused, true, 'a second fleet sees it filed and starts no second investigation');
  assert.equal((await issues(system)).length, 1);
});

test('with no tracker configured the presses refuse and nothing is searched', async () => {
  const { system } = build();
  system.config.integrations.issues = 'fake';
  await system.harness.runCycle();
  assert.equal((await errorsTab(system)).tracker, null, 'not searched is a dash, not "no bug"');
  const res = await press(system, '/api/app-errors/file-bug', { environment: 'test', fingerprint: 'Orders.Submit' });
  assert.equal(res.status, 409);
  const bad = await press(system, '/api/app-errors/reopen', { key: 'not-a-key' });
  assert.equal(bad.status, 400);
});

test('settleSearch prefers an open ticket, else the latest closed, and counts every carrier', () => {
  const hits: IssueKeyHit[] = [
    { ref: 'issue:9', state: 'closed', closedAt: '2026-10-01T00:00:00.000Z' },
    { ref: 'issue:12', state: 'closed', closedAt: '2026-10-10T00:00:00.000Z' },
  ];
  const closed = settleSearch(KEY, hits, 'now');
  assert.equal(closed.status, 'closed');
  assert.equal(closed.ticketRef, 'issue:12');
  assert.equal(closed.tickets, 2);
  const open = settleSearch(KEY, [...hits, { ref: 'issue:31', state: 'open', closedAt: null }], 'now');
  assert.equal(open.status, 'open');
  assert.equal(open.ticketRef, 'issue:31');
  assert.equal(settleSearch(KEY, [], 'now').status, 'none');
});

test('keysOwed searches moved groups only, and only once per read', () => {
  const group = (key: string, state: AppErrorGroupView['state']) => ({ key, state }) as AppErrorGroupView;
  const payload = {
    environments: [{ groups: [group('err:a:1', 'new'), group('err:a:2', 'steady'), group('err:a:3', 'spiking')] }],
  } as unknown as AppErrorsPayload;
  const reads = [{ readAt: '2026-10-20T10:00:00.000Z' }] as AppErrorRead[];
  const searched = (key: string, checkedAt: string) => ({
    key,
    status: 'none' as const,
    ticketRef: null,
    closedAt: null,
    tickets: 0,
    detail: null,
    checkedAt,
  });
  assert.deepEqual(keysOwed(payload, [], reads), ['err:a:1', 'err:a:3']);
  assert.deepEqual(
    keysOwed(
      payload,
      [searched('err:a:1', '2026-10-20T10:01:00.000Z'), searched('err:a:3', '2026-10-20T09:00:00.000Z')],
      reads,
    ),
    ['err:a:3'],
    'a key searched since the newest read is not searched again',
  );
});

test('a search that throws is recorded unknown for every key it carried', async () => {
  const store = new Store(':memory:');
  const sink = {
    canSearchIssueKeys: () => true,
    findIssuesByKeys: () => Promise.reject(new Error('ECONNRESET')),
  } as unknown as ActionSink & Partial<IssueKeySink>;
  const desk = new AppErrorTrackerDesk({
    tickets: store.appErrorTickets,
    sink,
    canFile: () => true,
    current: () => ({ project: 'shop', environments: [], bands: [] }),
    reads: () => [],
  });
  const answered = await desk.search([KEY]);
  assert.equal(answered.get(KEY)?.status, 'unknown');
  assert.match(answered.get(KEY)?.detail ?? '', /ECONNRESET/);
  assert.equal(store.appErrorTickets.listSearches()[0]?.status, 'unknown');
  store.close();
});
