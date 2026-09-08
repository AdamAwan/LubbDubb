import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { foldPoolDigest, poolUsageLabel } from '../src/pool/aggregate.js';
import { buildDigestDocument } from '../src/pool/digestArm.js';
import { POOL_SCHEMA_VERSION, parsePoolDocument, serialisePoolDocument } from '../src/pool/document.js';
import { renderPoolMarkdown } from '../src/pool/markdown.js';
import { USAGE_COPY } from '../src/usage/events.js';
import type { PoolDigestDocument } from '../src/types.js';

const NOW = '2026-08-24T12:00:00.000Z';

function digestDoc(over: Partial<PoolDigestDocument>): PoolDigestDocument {
  return {
    pool: POOL_SCHEMA_VERSION,
    kind: 'digest',
    fleetId: 'bob@acme-api',
    project: 'acme-api',
    publishedAt: NOW,
    harnessVersion: '0.1.0',
    byPhase: [],
    byCause: [],
    byCheck: [],
    unaccounted: [],
    unmeasured: [],
    byUsage: [],
    byThroughput: [],
    byFault: [],
    ...over,
  };
}

test('the usage section is keyed on subject and verb, bucketed by UTC day, and the current day is partial', () => {
  const store = new Store(':memory:', () => NOW);
  store.recordSurfaceReach([
    { subject: 'plan', verb: 'view', place: 'plan', arrival: 'linked' },
    { subject: 'plan', verb: 'view', place: 'overview', arrival: 'direct' },
    { subject: 'plan', verb: 'expand', place: 'plan', arrival: 'linked' },
  ]);
  const document = buildDigestDocument(store, {
    fleetId: 'alice@acme-api',
    project: 'acme-api',
    harnessVersion: '0.1.0',
    now: NOW,
  });

  assert.deepEqual(
    document.byUsage,
    [
      { day: '2026-08-24', key: 'plan.expand', count: 1, costUsd: null, partial: true },
      { day: '2026-08-24', key: 'plan.view', count: 2, costUsd: null, partial: true },
    ],
    'two views on two different places are one key: the place is local and never reaches the digest',
  );

  const text = serialisePoolDocument(document);
  assert.ok(!text.includes('"place"'), 'no place column crosses the wire');
  assert.ok(!text.includes('overview'), 'no place key crosses the wire');
});

test('a usage row carries no cost, and a document from a build without the section reads as empty', () => {
  const store = new Store(':memory:', () => NOW);
  store.recordSurfaceReach([{ subject: 'goal', verb: 'view', place: 'goal', arrival: 'linked' }]);
  const document = buildDigestDocument(store, {
    fleetId: 'alice@acme-api',
    project: 'acme-api',
    harnessVersion: '0.1.0',
    now: NOW,
  });
  assert.deepEqual(
    document.byUsage.map((r) => r.costUsd),
    [null],
  );

  const older = { ...document } as Record<string, unknown>;
  delete older.byUsage;
  const parsed = parsePoolDocument(JSON.stringify(older));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok && parsed.document.byUsage, [], 'an older fleet is one with no rows, never an error');
});

test('the mirror stores the usage section and the aggregator ships the event count beside the fleet count', () => {
  const store = new Store(':memory:', () => NOW);
  store.replacePoolFleetDigest(
    'busy@acme-api',
    'acme-api',
    digestDoc({
      fleetId: 'busy@acme-api',
      byUsage: [{ day: '2026-08-23', key: 'plan.expand', count: 40, costUsd: null, partial: false }],
    }),
  );
  for (const id of ['a', 'b', 'c', 'd']) {
    store.replacePoolFleetDigest(
      `${id}@acme-api`,
      'acme-api',
      digestDoc({
        fleetId: `${id}@acme-api`,
        byUsage: [{ day: '2026-08-23', key: 'plan.view', count: 10, costUsd: null, partial: false }],
      }),
    );
  }

  const rollup = foldPoolDigest(store.listPoolDigestRows('acme-api'), { project: 'acme-api', since: null });
  const expand = rollup.byUsage.find((r) => r.key === 'plan.expand');
  const view = rollup.byUsage.find((r) => r.key === 'plan.view');
  assert.deepEqual(
    [expand?.count, expand?.fleets],
    [40, 1],
    'forty events, one person — the count alone would read as the whole pool',
  );
  assert.deepEqual([view?.count, view?.fleets], [40, 4], 'the same forty events, four people');
  assert.equal(rollup.fleets.length, 5);
  assert.equal(expand?.costUsd, null, 'a usage row never carries money');
  assert.equal(expand?.label, USAGE_COPY['plan.expand'].label, 'the copy comes from the registry, never restated');
  assert.equal(poolUsageLabel('plan.made-up'), 'plan.made-up', 'a key this build has no copy for is drawn as the key');
});

test('the usage section sums across projects: both its axes are the harness’s own, so it takes no project argument', () => {
  const store = new Store(':memory:', () => NOW);
  for (const [fleet, project] of [
    ['a@one', 'one'],
    ['b@two', 'two'],
  ] as const) {
    store.replacePoolFleetDigest(
      fleet,
      project,
      digestDoc({
        fleetId: fleet,
        project,
        byUsage: [{ day: '2026-08-23', key: 'validation.expand', count: 3, costUsd: null, partial: false }],
      }),
    );
  }
  const all = foldPoolDigest(store.listPoolDigestRows(null), { project: null, since: null });
  const row = all.byUsage.find((r) => r.key === 'validation.expand');
  assert.deepEqual([row?.count, row?.fleets], [6, 2]);
  assert.equal(all.byCheck, null);
});

test('a pair the registry does not have is dropped rather than published', () => {
  const store = new Store(':memory:', () => NOW);
  store.recordSurfaceReach([
    { subject: 'pr', verb: 'expand', place: 'pr', arrival: 'linked' },
    { subject: 'pr', verb: 'view', place: 'pr', arrival: 'linked' },
  ] as never);
  const document = buildDigestDocument(store, {
    fleetId: 'alice@acme-api',
    project: 'acme-api',
    harnessVersion: '0.1.0',
    now: NOW,
  });
  assert.deepEqual(
    document.byUsage.map((r) => r.key),
    ['pr.view'],
    'pr.expand is an empty cell: the pull request page draws no disclosure',
  );
});

test('the companion summarises the section rather than transcribing it, and draws no cost column', () => {
  const text = renderPoolMarkdown(
    digestDoc({
      byUsage: [
        { day: '2026-08-24', key: 'plan.view', count: 4, costUsd: null, partial: true },
        { day: '2026-08-20', key: 'plan.view', count: 7, costUsd: null, partial: false },
        { day: '2026-06-01', key: 'goal.view', count: 90, costUsd: null, partial: false },
      ],
    }),
  );
  assert.ok(text.includes('## What a person did'));
  assert.ok(text.includes('| Subject · verb | Times 7d | Times 30d | Times 90d |'), text);
  assert.ok(text.includes(`| ${USAGE_COPY['plan.view'].label} | 11 | 11 | 11 |`), text);
  assert.ok(text.includes(`| ${USAGE_COPY['goal.view'].label} | 0 | 0 | 90 |`), text);
  assert.ok(!text.includes('Cost 7d'), 'a column of dashes is worse than no column');
});
