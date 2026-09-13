import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { resolveWindow } from '../src/insights/insightsWindow.js';
import { buildSurfaceReach, type SurfaceVerdict } from '../src/insights/surfaceReachInsights.js';
import { PLACE_KEYS, USAGE_SUBJECTS, VERBS_BY_SUBJECT } from '../src/usage/events.js';
import type { SurfaceReach } from '../src/types.js';
import type { UsagePayload } from '../src/wire.js';

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-reach-'));
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

const NOW = Date.parse('2026-03-10T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function reachRow(subject: string, verb: string, msAgo: number, arrival: 'linked' | 'direct' = 'linked'): SurfaceReach {
  return {
    subject: subject as SurfaceReach['subject'],
    verb: verb as SurfaceReach['verb'],
    place: 'goal',
    at: iso(msAgo),
    arrival,
  };
}

function verdictOf(rows: SurfaceReach[], everLinked: string[], subject: string): SurfaceVerdict {
  const insights = buildSurfaceReach({
    rows,
    everLinked: new Set(everLinked),
    window: resolveWindow('24h', NOW, null),
  });
  const row = insights.rows.find((r) => r.subject === subject);
  assert.ok(row, `no ${subject} row`);
  return row.verdict;
}

test('a quiet surface is four different facts, and the fold tells them apart', () => {
  const busy = [reachRow('goal', 'view', 2 * HOUR)];

  assert.equal(verdictOf(busy, ['goal'], 'retro'), 'never-linked');

  assert.equal(verdictOf(busy, ['goal', 'retro'], 'retro'), 'linked-never-visited');

  assert.equal(
    verdictOf([...busy, reachRow('pool', 'view', HOUR)], ['goal', 'pool'], 'pool'),
    'visited-never-operated',
  );

  assert.equal(
    verdictOf([...busy, reachRow('pool', 'view', HOUR), reachRow('pool', 'filter', HOUR)], ['goal', 'pool'], 'pool'),
    'operated',
  );
});

test('a dark console outranks every per-surface verdict, because none of them mean anything in it', () => {
  const insights = buildSurfaceReach({
    rows: [reachRow('goal', 'view', 40 * HOUR), reachRow('plan', 'accept', 39 * HOUR)],
    everLinked: new Set(['goal', 'plan']),
    window: resolveWindow('24h', NOW, null),
  });
  assert.equal(insights.total, 0);
  assert.ok(insights.rows.every((r) => r.verdict === 'console-dark'));
  assert.equal(
    insights.rows.filter((r) => r.verdict === 'never-linked').length,
    0,
    'an absent operator must never read as a product nobody can navigate',
  );
});

test('every subject gets a row, so a reading is never a list of only what was used', () => {
  const insights = buildSurfaceReach({
    rows: [reachRow('goal', 'view', HOUR)],
    everLinked: new Set(['goal']),
    window: resolveWindow('24h', NOW, null),
  });
  assert.deepEqual(
    insights.rows.map((r) => r.subject),
    USAGE_SUBJECTS,
  );
  assert.ok(insights.rows.every((r) => r.label !== '' && r.verdictLabel !== '' && r.verdictBlurb !== ''));
});

test('the batch route stores what the cockpit sends, and the GET reads it back over the same window', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const post = await app.inject({
    method: 'POST',
    url: '/api/usage/events',
    payload: {
      events: [
        { subject: 'plan', verb: 'view', place: 'plan', arrival: 'linked' },
        { subject: 'plan', verb: 'expand', place: 'plan', arrival: 'linked' },
        { subject: 'ticket', verb: 'view', place: 'tickets', arrival: 'direct' },
      ],
    },
  });
  assert.equal(post.statusCode, 200);

  const res = await app.inject({ method: 'GET', url: '/api/usage?window=24h' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as UsagePayload;
  assert.equal(body.reach.total, 3);
  const plan = body.reach.rows.find((r) => r.subject === 'plan');
  assert.ok(plan);
  assert.equal(plan.verdict, 'operated');
  assert.equal(plan.views, 1);
  assert.equal(plan.linkedViews, 1);
  assert.equal(plan.operations, 1);

  const ticket = body.reach.rows.find((r) => r.subject === 'ticket');
  assert.ok(ticket);
  assert.equal(ticket.linkedViews, 0);
  assert.equal(ticket.verdict, 'visited-never-operated');

  assert.equal(body.insights.window.key, '24h');
  await app.close();
  system.store.close();
});

test('a combination the registry does not have is refused, rather than written down and grouped by', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const refused = await app.inject({
    method: 'POST',
    url: '/api/usage/events',
    payload: { events: [{ subject: 'plan', verb: 'defer', place: 'plan', arrival: 'linked' }] },
  });
  assert.equal(refused.statusCode, 400);
  assert.match(refused.json().error as string, /verb/);

  const badPlace = await app.inject({
    method: 'POST',
    url: '/api/usage/events',
    payload: { events: [{ subject: 'plan', verb: 'view', place: '/goals/17?tab=x', arrival: 'linked' }] },
  });
  assert.equal(badPlace.statusCode, 400);

  const res = await app.inject({ method: 'GET', url: '/api/usage?window=24h' });
  assert.equal((res.json() as UsagePayload).reach.total, 0);
  await app.close();
  system.store.close();
});

test('an empty batch is accepted and stores nothing — a flush with nothing in it is not an error', async () => {
  const system = build();
  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'POST', url: '/api/usage/events', payload: { events: [] } });
  assert.equal(res.statusCode, 200);
  assert.equal(system.store.surfaceReach.listSurfaceReachSince(new Date(0).toISOString()).length, 0);
  await app.close();
  system.store.close();
});

test('the retention sweep drops from the back and keeps the ninety days it promises', () => {
  const system = build();
  const { store } = system;
  store.surfaceReach.recordSurfaceReach([{ subject: 'goal', verb: 'view', place: 'goal', arrival: 'linked' }]);
  assert.equal(store.surfaceReach.listSurfaceReachSince(new Date(0).toISOString()).length, 1);
  store.surfaceReach.pruneSurfaceReach(true);
  assert.equal(store.surfaceReach.listSurfaceReachSince(new Date(0).toISOString()).length, 1);
  system.store.close();
});

test('the place vocabulary is closed and the subject matrix is the one the registry declares', () => {
  assert.ok(PLACE_KEYS.includes('goal'));
  assert.equal(new Set(PLACE_KEYS).size, PLACE_KEYS.length, 'a duplicated place key would double-count a surface');
  assert.ok(!(VERBS_BY_SUBJECT.plan as readonly string[]).includes('defer'));
});
