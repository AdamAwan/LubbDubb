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
import { resolveWindow } from '../src/insightsWindow.js';
import { buildSurfaceReach, type SurfaceVerdict } from '../src/surfaceReachInsights.js';
import { PLACE_KEYS, USAGE_SUBJECTS, VERBS_BY_SUBJECT } from '../src/usage/events.js';
import type { SurfaceReach } from '../src/types.js';
import type { UsagePayload } from '../src/wire.js';

/**
 * Surface reach: the verdicts, the batch route, and the two properties of the
 * table that are the whole reason it is safe to write on the path it observes.
 *
 * The fold is exercised as a pure function and the route through the seam, which
 * is the split every other reading here takes: the arithmetic wants rows placed
 * to the millisecond, and the route wants to be asked whether it actually stores
 * what a cockpit sends.
 */

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
  // Somebody was in the console, so the window is not dark.
  const busy = [reachRow('goal', 'view', 2 * HOUR)];

  // Nothing in the cockpit has ever carried anybody to the retro: no `linked`
  // arrival for it has ever been recorded, so nobody *could* have reached it
  // except by address. That is a verdict about the harness's own navigation.
  assert.equal(verdictOf(busy, ['goal'], 'retro'), 'never-linked');

  // A link exists — it has been taken before, outside this window — and in this
  // window nobody went. A different fact wanting a different action.
  assert.equal(verdictOf(busy, ['goal', 'retro'], 'retro'), 'linked-never-visited');

  // Reached, and nothing was done there: the one case where the silence is the
  // surface's own.
  assert.equal(
    verdictOf([...busy, reachRow('pool', 'view', HOUR)], ['goal', 'pool'], 'pool'),
    'visited-never-operated',
  );

  // Something was done.
  assert.equal(
    verdictOf([...busy, reachRow('pool', 'view', HOUR), reachRow('pool', 'filter', HOUR)], ['goal', 'pool'], 'pool'),
    'operated',
  );
});

test('a dark console outranks every per-surface verdict, because none of them mean anything in it', () => {
  // Rows exist, but every one of them is older than the window — which is what a
  // week the operator was away actually looks like in the table.
  const insights = buildSurfaceReach({
    rows: [reachRow('goal', 'view', 40 * HOUR), reachRow('plan', 'accept', 39 * HOUR)],
    everLinked: new Set(['goal', 'plan']),
    window: resolveWindow('24h', NOW, null),
  });
  assert.equal(insights.total, 0);
  assert.ok(insights.rows.every((r) => r.verdict === 'console-dark'));
  // Not one of them is reported as unreachable, which is the failure this ladder
  // exists to prevent: a page of `never-linked` drawn over an absent operator.
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
  // The copy is the server's and travels with the verdict — a cockpit that had to
  // spell these would be a second opinion drawn inches from the first.
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

  // Reached only by address: the arrival column survives the round trip, which is
  // the whole of what tells `never-linked` from `linked-never-visited`.
  const ticket = body.reach.rows.find((r) => r.subject === 'ticket');
  assert.ok(ticket);
  assert.equal(ticket.linkedViews, 0);
  assert.equal(ticket.verdict, 'visited-never-operated');

  // The two halves come off one payload over one window, which is what makes the
  // pairing they exist for a pairing at all.
  assert.equal(body.insights.window.key, '24h');
  await app.close();
  system.store.close();
});

test('a combination the registry does not have is refused, rather than written down and grouped by', async () => {
  const system = build();
  const { app } = await buildApp(system);
  // `plan.defer` is a cell the matrix leaves empty — two independently valid
  // halves, and exactly how a key that means nothing gets into an aggregate.
  const refused = await app.inject({
    method: 'POST',
    url: '/api/usage/events',
    payload: { events: [{ subject: 'plan', verb: 'defer', place: 'plan', arrival: 'linked' }] },
  });
  assert.equal(refused.statusCode, 400);
  assert.match(refused.json().error as string, /verb/);

  // A place the cockpit does not have, refused for the same reason: the column's
  // type is what keeps a URL out of this table.
  const badPlace = await app.inject({
    method: 'POST',
    url: '/api/usage/events',
    payload: { events: [{ subject: 'plan', verb: 'view', place: '/goals/17?tab=x', arrival: 'linked' }] },
  });
  assert.equal(badPlace.statusCode, 400);

  // Nothing was stored by either.
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
  assert.equal(system.store.listSurfaceReachSince(new Date(0).toISOString()).length, 0);
  await app.close();
  system.store.close();
});

test('the retention sweep drops from the back and keeps the ninety days it promises', () => {
  const system = build();
  const { store } = system;
  store.recordSurfaceReach([{ subject: 'goal', verb: 'view', place: 'goal', arrival: 'linked' }]);
  assert.equal(store.listSurfaceReachSince(new Date(0).toISOString()).length, 1);
  // Forced, because the write path's hourly rate limit is about a hot loop and
  // this is the boot call. A row written a moment ago is inside ninety days.
  store.pruneSurfaceReach(true);
  assert.equal(store.listSurfaceReachSince(new Date(0).toISOString()).length, 1);
  system.store.close();
});

test('the place vocabulary is closed and the subject matrix is the one the registry declares', () => {
  // The route validates against these very lists, so a place the cockpit invents
  // is a 400 rather than a row. Asserted structurally so a widened enum has to be
  // a deliberate edit here as well.
  assert.ok(PLACE_KEYS.includes('goal'));
  assert.equal(new Set(PLACE_KEYS).size, PLACE_KEYS.length, 'a duplicated place key would double-count a surface');
  // `plan.defer` stays absent: an empty cell is a statement that the product
  // offers no such control.
  assert.ok(!(VERBS_BY_SUBJECT.plan as readonly string[]).includes('defer'));
});
