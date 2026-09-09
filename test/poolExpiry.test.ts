import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { FakePoolTransport } from '../src/integrations/fake/fakePool.js';
import { foldPoolDigest } from '../src/pool/aggregate.js';
import { POOL_SCHEMA_VERSION, POOL_STALE_DAYS, parsePoolDocument } from '../src/pool/document.js';
import { PoolDesk } from '../src/pool/poolDesk.js';
import type { PoolDigestDocument } from '../src/types.js';

// → docs/spec/28-cross-fleet-pool.md#a-mirrored-fleet-expires-after-a-week

const SCOPED = { pullRequests: true, issues: true };

const DAY = 24 * 60 * 60 * 1000;

function digest(fleetId: string, publishedAt: string): PoolDigestDocument {
  return {
    pool: POOL_SCHEMA_VERSION,
    kind: 'digest',
    fleetId,
    project: 'acme-api',
    publishedAt,
    harnessVersion: '0.1.0',
    byPhase: [{ day: publishedAt.slice(0, 10), key: 'build', count: 4, costUsd: 8, partial: false }],
    byCause: [],
    byCheck: [],
    unaccounted: [],
    unmeasured: [],
    byUsage: [],
    byThroughput: [],
    poolableThroughput: ['reply-sent'],
    byFault: [],
  };
}

function clock(start: string): { now: () => string; advance: (days: number) => void } {
  let at = new Date(start).getTime();
  return {
    now: () => new Date(at).toISOString(),
    advance: (days) => void (at += days * DAY),
  };
}

function harness(start = '2026-08-24T12:00:00.000Z'): {
  s: Store;
  transport: FakePoolTransport;
  desk: PoolDesk;
  advance: (days: number) => void;
} {
  const c = clock(start);
  const s = new Store(':memory:', c.now);
  const transport = new FakePoolTransport();
  const desk = new PoolDesk({
    store: s,
    transport,
    fleetId: 'alice@acme-api',
    project: 'acme-api',
    harnessVersion: '0.1.0',
    now: c.now,
    digestIntervalMs: 60 * 60 * 1000,
    closedPrWindowMs: 6 * 60 * 60 * 1000,
    worldScope: SCOPED,
  });
  return { s, transport, desk, advance: c.advance };
}

test('the expiry window is a stated constant, never a config key', () => {
  assert.equal(POOL_STALE_DAYS, 7);
});

test("a renamed fleet's abandoned document stops being summed a week after its last digest", async () => {
  const { s, transport, desk, advance } = harness();
  transport.seed(digest('bob-old@acme-api', '2026-08-24T09:00:00.000Z'));
  await desk.run();
  assert.equal(
    foldPoolDigest(s.listPoolDigestRows('acme-api'), { project: 'acme-api' }).byPhase[0]?.count,
    4,
    'inside the window it is an ordinary fleet',
  );

  // The file stays in the pool, so it is re-fetched on every poll: only the
  // publisher's own stamp stops advancing when the fleet behind it does.
  advance(8);
  await desk.run();

  assert.deepEqual(s.listPoolDigestRows('acme-api'), [], 'its rows count in no total');
  const rollup = foldPoolDigest(s.listPoolDigestRows('acme-api'), { project: 'acme-api' });
  assert.deepEqual(rollup.byPhase, []);
  assert.deepEqual(rollup.fleets, []);

  const fleet = s.listPoolFleets().find((f) => f.fleetId === 'bob-old@acme-api');
  assert.ok(fleet, 'the fleet is still named, never dropped without a word');
  assert.equal(fleet.stale, true);
  assert.equal(fleet.digestAt, '2026-08-24T09:00:00.000Z', 'with the last digest it did publish');
});

test('an expired document is not re-landed, so the sweep does not fight the poll', async () => {
  const { s, transport, desk, advance } = harness();
  transport.seed(digest('bob-old@acme-api', '2026-08-24T09:00:00.000Z'));
  advance(8);
  await desk.run();
  await desk.run();
  assert.deepEqual(s.listPoolDigestRows(null), []);
});

test('a failed fetch never expires anything', async () => {
  const { s, transport, desk, advance } = harness();
  transport.seed(digest('bob-old@acme-api', '2026-08-24T09:00:00.000Z'));
  await desk.run();
  assert.equal(s.listPoolDigestRows(null).length, 1);

  advance(8);
  transport.fetchError = new Error('the pool is unreachable');
  await desk.run();
  assert.equal(
    s.listPoolDigestRows(null).length,
    1,
    'an outage leaves the last-known-good mirror in place — it is never read as an expiry',
  );
});

test('republishing brings an expired fleet back, with no tombstone to clear', async () => {
  const { s, transport, desk, advance } = harness();
  transport.seed(digest('bob@acme-api', '2026-08-24T09:00:00.000Z'));
  advance(8);
  await desk.run();
  assert.deepEqual(s.listPoolDigestRows(null), []);

  transport.seed(digest('bob@acme-api', '2026-09-01T09:00:00.000Z'));
  await desk.run();
  assert.equal(s.listPoolDigestRows('acme-api').length, 1);
  assert.equal(s.listPoolFleets().find((f) => f.fleetId === 'bob@acme-api')?.stale, false);
});

test('a fleet ahead of this build ages on seenAt, the only stamp it has', async () => {
  const { s, transport, desk, advance } = harness();
  transport.seedText('carol@acme-api', 'fleets/carol@acme-api/digest.json', {
    addressedTo: 'carol@acme-api',
    text: JSON.stringify({ ...digest('carol@acme-api', '2026-08-24T09:00:00.000Z'), pool: POOL_SCHEMA_VERSION + 1 }),
  });
  advance(8);
  await desk.run();
  const fleet = s.listPoolFleets().find((f) => f.fleetId === 'carol@acme-api');
  assert.equal(fleet?.ahead, true);
  assert.equal(fleet?.stale, false, 'it is still publishing — this build simply cannot read it');
  assert.deepEqual(s.listPoolDigestRows(null), [], 'and it contributes nothing either way');
});

test('a publishedAt that is not a timestamp is malformed rather than an ageless document', () => {
  const parsed = parsePoolDocument(
    JSON.stringify({ ...digest('bob@acme-api', '2026-08-24T09:00:00.000Z'), publishedAt: 'whenever' }),
  );
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok === false && parsed.reason === 'malformed' ? parsed.detail : '', /not a timestamp/);
});
