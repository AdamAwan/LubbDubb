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
import type { ReliabilityPayload, SpendPayload, SpendTrendPayload } from '../src/wire.js';

/**
 * The window, end to end: the cockpit asks with a key and every fold under the
 * three routes measures the same stretch.
 *
 * The arithmetic is `test/insightsWindow.test.ts`'s. What is asserted here is the
 * thing that arithmetic cannot catch — that the routes actually *pass it down*,
 * and that all three answer for the same span when asked with the same key. A
 * route that resolved a window and then read the store with a constant would
 * typecheck, pass every unit test, and put two tabs of one page over two
 * different fortnights, which is the arrangement this replaced.
 */

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

const ROUTES = ['/api/spend', '/api/reliability', '/api/spend/trend'] as const;

test('all three insight routes take the same window, and say which they answered for', async () => {
  const { app } = await buildApp(build());
  for (const url of ROUTES) {
    const res = await app.inject({ method: 'GET', url: `${url}?window=24h` });
    assert.equal(res.statusCode, 200, url);
    const body = res.json() as SpendPayload | ReliabilityPayload | SpendTrendPayload;
    const window = 'trend' in body ? body.trend.window : body.insights.window;
    // Shipped back rather than assumed, because the page draws this and not the
    // key it asked with: a caption computed in the browser is free to disagree
    // with the buckets the server actually cut.
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
    const body = res.json() as SpendPayload | ReliabilityPayload | SpendTrendPayload;
    const window = 'trend' in body ? body.trend.window : body.insights.window;
    // A route reached without a window must answer for the stretch the page opens
    // on, not for whatever that route's author happened to pick.
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
  // The timeline still has two ends: a graph cannot be drawn against `null`.
  assert.ok(Date.parse(insights.window.startsAt) > 0);
  assert.ok(insights.window.buckets > 0);
});

/**
 * The one input here an operator can hand-edit. The cockpit can only ask with the
 * union, so an unrecognised key came from the address bar — and answering it for
 * some other stretch, silently, is worse than refusing it.
 */
test('a window the routes do not know is a refusal, not a fallback', async () => {
  const { app } = await buildApp(build());
  for (const url of ROUTES) {
    const res = await app.inject({ method: 'GET', url: `${url}?window=fortnight` });
    assert.equal(res.statusCode, 400, url);
    assert.match((res.json() as { error: string }).error, /window must be one of/, url);
  }
  await app.close();
});

/**
 * The trend's axis is eight windows, not one — which is what makes the page's
 * single control meaningful on the tab that is inherently about change, and what
 * makes the headline's "against the previous window" the same thing as this
 * chart's last two bars.
 */
test('the trend draws eight periods of the chosen window', async () => {
  const { app } = await buildApp(build());
  const res = await app.inject({ method: 'GET', url: '/api/spend/trend?window=24h' });
  assert.equal(res.statusCode, 200);
  const { trend } = res.json() as SpendTrendPayload;
  assert.equal(trend.periods, 8);
  assert.equal(trend.buckets.length, 8);
  assert.equal(trend.bucketMs, 24 * 60 * 60 * 1000, 'a period on a 24h window is a day');
  // The last one is the period `now` falls in, so it is still filling — and the
  // tab draws it hollow rather than letting a figure that is going to grow read
  // as a fall.
  assert.equal(trend.buckets[7]?.partial, true);
  assert.equal(trend.buckets[0]?.partial, false);
  await app.close();
});

test('the session window is anchored off the store\u2019s own reading, on every route', async () => {
  const system = build();
  // Two hours to go, so the account\u2019s window opened three hours ago — a start
  // no route could arrive at by subtracting anything from `now`, which is what
  // makes this the assertion that a route passed the reading down rather than
  // resolving the key alone.
  const resetsAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  system.store.recordRateLimits({
    fiveHour: { usedPercentage: 74, resetsAt },
    sevenDay: { usedPercentage: 31, resetsAt: null },
    capturedAt: new Date().toISOString(),
  });
  const { app } = await buildApp(system);
  for (const url of ROUTES) {
    const res = await app.inject({ method: 'GET', url: `${url}?window=session` });
    assert.equal(res.statusCode, 200, url);
    const body = res.json() as SpendPayload | ReliabilityPayload | SpendTrendPayload;
    const window = 'trend' in body ? body.trend.window : body.insights.window;
    assert.equal(window.key, 'session', url);
    assert.equal(window.label, '5h session', url);
    assert.equal(window.session?.kind, 'anchored', `${url} must anchor off the stored reading`);
    if (window.session?.kind === 'anchored') {
      assert.equal(window.session.resetsAt, resetsAt, url);
      assert.equal(window.session.usedPercentage, 74, url);
      // Three hours back, not five: a route that dropped the reading would answer
      // for the last five hours here and label it as the account\u2019s window.
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
    const body = res.json() as SpendPayload | ReliabilityPayload | SpendTrendPayload;
    const window = 'trend' in body ? body.trend.window : body.insights.window;
    // The reading is still worth having — a PTY or API-key deployment has no
    // windows at all — but the label must not claim it is the account\u2019s.
    assert.equal(window.session?.kind, 'unreported', url);
    assert.equal(window.label, 'Last 5h', url);
    assert.notEqual(window.since, null, url);
  }
  await app.close();
});
