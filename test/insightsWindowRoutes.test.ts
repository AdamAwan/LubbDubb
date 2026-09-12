import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { ReliabilityPayload, SpendPayload, SpendTrendPayload, ThroughputPayload } from '../src/wire.js';

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-window-'));
  return buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 3,
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
}

const ROUTES = ['/api/spend', '/api/reliability', '/api/throughput', '/api/spend/trend'] as const;

test('all three insight routes take the same window, and say which they answered for', async () => {
  const { app } = await buildApp(build());
  for (const url of ROUTES) {
    const res = await app.inject({ method: 'GET', url: `${url}?window=24h` });
    assert.equal(res.statusCode, 200, url);
    const body = res.json() as SpendPayload | ReliabilityPayload | ThroughputPayload | SpendTrendPayload;
    const window = 'trend' in body ? body.trend.window : body.insights.window;
    assert.equal(window.key, '24h', url);
    assert.equal(window.bucketLabel, '1h buckets', url);
    assert.notEqual(window.since, null, url);
  }
  await app.close();
});

test('the window defaults to the one the page opens on', async () => {
  const { app } = await buildApp(build());
  for (const url of ROUTES) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200, url);
    const body = res.json() as SpendPayload | ReliabilityPayload | ThroughputPayload | SpendTrendPayload;
    const window = 'trend' in body ? body.trend.window : body.insights.window;
    assert.equal(window.key, '7d', url);
  }
  await app.close();
});

test('`all` is answered with no lower bound at all', async () => {
  const { app } = await buildApp(build());
  const res = await app.inject({ method: 'GET', url: '/api/spend?window=all' });
  assert.equal(res.statusCode, 200);
  const { insights } = res.json() as SpendPayload;
  assert.equal(insights.window.since, null, 'all time must not quietly become a long fixed span');
  assert.ok(Date.parse(insights.window.startsAt) > 0);
  assert.ok(insights.window.buckets > 0);
});

test('a window the routes do not know is a refusal, not a fallback', async () => {
  const { app } = await buildApp(build());
  for (const url of ROUTES) {
    const res = await app.inject({ method: 'GET', url: `${url}?window=fortnight` });
    assert.equal(res.statusCode, 400, url);
    assert.match((res.json() as { error: string }).error, /window must be one of/, url);
  }
  await app.close();
});

test('the trend draws eight periods of the chosen window', async () => {
  const { app } = await buildApp(build());
  const res = await app.inject({ method: 'GET', url: '/api/spend/trend?window=24h' });
  assert.equal(res.statusCode, 200);
  const { trend } = res.json() as SpendTrendPayload;
  assert.equal(trend.periods, 8);
  assert.equal(trend.buckets.length, 8);
  assert.equal(trend.bucketMs, 24 * 60 * 60 * 1000, 'a period on a 24h window is a day');
  assert.equal(trend.buckets[7]?.partial, true);
  assert.equal(trend.buckets[0]?.partial, false);
  await app.close();
});

test('the session window is anchored off the store\u2019s own reading, on every route', async () => {
  const system = build();
  const resetsAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  system.store.rateLimits.recordRateLimits({
    fiveHour: { usedPercentage: 74, resetsAt },
    sevenDay: { usedPercentage: 31, resetsAt: null },
    capturedAt: new Date().toISOString(),
  });
  const { app } = await buildApp(system);
  for (const url of ROUTES) {
    const res = await app.inject({ method: 'GET', url: `${url}?window=session` });
    assert.equal(res.statusCode, 200, url);
    const body = res.json() as SpendPayload | ReliabilityPayload | ThroughputPayload | SpendTrendPayload;
    const window = 'trend' in body ? body.trend.window : body.insights.window;
    assert.equal(window.key, 'session', url);
    assert.equal(window.label, '5h session', url);
    assert.equal(window.session?.kind, 'anchored', `${url} must anchor off the stored reading`);
    if (window.session?.kind === 'anchored') {
      assert.equal(window.session.resetsAt, resetsAt, url);
      assert.equal(window.session.usedPercentage, 74, url);
      assert.equal(
        Date.parse(window.session.startsAt),
        Date.parse(resetsAt) - 5 * 60 * 60 * 1000,
        `${url} must open where the account says the window did`,
      );
      assert.equal(window.since, window.session.startsAt, url);
    }
  }
  await app.close();
});

test('a deployment that has never reported a window still answers, and says it is not the account\u2019s', async () => {
  const { app } = await buildApp(build());
  for (const url of ROUTES) {
    const res = await app.inject({ method: 'GET', url: `${url}?window=session` });
    assert.equal(res.statusCode, 200, url);
    const body = res.json() as SpendPayload | ReliabilityPayload | ThroughputPayload | SpendTrendPayload;
    const window = 'trend' in body ? body.trend.window : body.insights.window;
    assert.equal(window.session?.kind, 'unreported', url);
    assert.equal(window.label, 'Last 5h', url);
    assert.notEqual(window.since, null, url);
  }
  await app.close();
});
