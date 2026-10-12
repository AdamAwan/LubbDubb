import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { FakePoolTransport } from '../src/integrations/fake/fakePool.js';
import { foldPoolTrends } from '../src/pool/aggregate.js';
import { buildDigestDocument } from '../src/pool/digestArm.js';
import { parsePoolDocument, POOL_SCHEMA_VERSION, serialisePoolDocument } from '../src/pool/document.js';
import { PoolDesk } from '../src/pool/poolDesk.js';
import type { PoolDigestDocument, PoolDigestRow } from '../src/types.js';

const SCOPED = { pullRequests: true, issues: true };
const NOW = '2026-08-24T12:00:00.000Z';

function digest(fleetId: string, over: Partial<PoolDigestDocument>): PoolDigestDocument {
  return {
    pool: POOL_SCHEMA_VERSION,
    kind: 'digest',
    fleetId,
    project: 'acme-api',
    publishedAt: NOW,
    harnessVersion: '0.2.0',
    byPhase: [],
    byCause: [],
    byCheck: [],
    unaccounted: [],
    unmeasured: [],
    byUsage: [],
    byThroughput: [],
    poolableThroughput: [],
    byFault: [],
    byChoice: [],
    byRule: [],
    byVersion: [],
    ...over,
  };
}

function day(offset: number): string {
  return new Date(Date.parse('2026-08-01T00:00:00Z') + offset * 86_400_000).toISOString().slice(0, 10);
}

function row(d: number, key: string, count: number, costUsd: number | null = null): PoolDigestRow {
  return { day: day(d), key, count, costUsd, partial: false };
}

test('the digest prices each dispatch rule per day, and leaves out runs no rule proposed', () => {
  let now = '2026-08-23T10:00:00.000Z';
  const s = new Store(':memory:', () => now);
  const run = (rule: string | null, cost: number) => {
    const task = s.tasks.createTask({ kind: 'code', title: 't', prompt: 'p', branch: 'b', originRef: 'pr:7', rule });
    const agent = s.agents.createAgent({ taskId: task.id, cwd: '/wt', pid: null });
    s.agents.recordAgentUsage(agent.id, {
      costUsd: cost,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      numTurns: null,
    });
    s.agents.updateAgent(agent.id, { status: 'done', endedAt: now });
  };
  run('pr-review-comment', 2);
  run('pr-review-comment', 4);
  run(null, 9);
  run('not-a-rule', 9);
  now = NOW;

  const document = buildDigestDocument(s, {
    fleetId: 'alice@acme-api',
    project: 'acme-api',
    harnessVersion: '0.2.0',
    now: NOW,
    scope: SCOPED,
  });
  assert.deepEqual(document.byRule, [
    { day: '2026-08-23', key: 'pr-review-comment', count: 2, costUsd: 6, partial: false },
  ]);
});

test('the desk records which version ran today, and the digest carries one row per day per version', async () => {
  let now = '2026-08-22T09:00:00.000Z';
  const s = new Store(':memory:', () => now);
  const transport = new FakePoolTransport();
  const desk = (version: string) =>
    new PoolDesk({
      store: s,
      transport,
      fleetId: 'alice@acme-api',
      project: 'acme-api',
      harnessVersion: version,
      now: () => now,
      digestIntervalMs: 60 * 60 * 1000,
      worldScope: SCOPED,
    });
  await desk('0.1.0').run();
  now = '2026-08-23T09:00:00.000Z';
  await desk('0.1.0').run();
  await desk('0.2.0').run();
  now = NOW;

  const document = buildDigestDocument(s, {
    fleetId: 'alice@acme-api',
    project: 'acme-api',
    harnessVersion: '0.2.0',
    now: NOW,
    scope: SCOPED,
  });
  assert.deepEqual(
    document.byVersion.map((r) => [r.day, r.key, r.count]),
    [
      ['2026-08-22', '0.1.0', 1],
      ['2026-08-23', '0.1.0', 1],
      ['2026-08-23', '0.2.0', 1],
    ],
  );
});

test('a document from before the trend sections parses with both empty', () => {
  const { byRule: _rule, byVersion: _version, ...older } = digest('bob@acme-api', {});
  const parsed = parsePoolDocument(JSON.stringify(older));
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.ok && [parsed.document.byRule, parsed.document.byVersion], [[], []]);
  const round = parsePoolDocument(
    serialisePoolDocument(digest('bob@acme-api', { byRule: [row(1, 'pr-ci-failing', 1, 3)] })),
  );
  assert.equal(round.ok && round.document.byRule[0]!.costUsd, 3);
});

test('a release is read around each fleet’s own upgrade day, and a fleet’s first version is not one', () => {
  const s = new Store(':memory:', () => NOW);
  const rules: PoolDigestRow[] = [];
  const versionsOf = (upgradeOn: number) =>
    Array.from({ length: 40 }, (_, d) => row(d, d < upgradeOn ? '0.1.0' : '0.2.0', 1));
  for (let d = 0; d < 40; d++) rules.push(row(d, 'pr-review-comment', 2, d < 20 ? 4 : 2));
  s.pool.replaceFleetDigest(
    'alice@acme-api',
    'acme-api',
    digest('alice@acme-api', { byRule: rules, byVersion: versionsOf(20) }),
  );

  const late: PoolDigestRow[] = [];
  for (let d = 0; d < 40; d++) late.push(row(d, 'pr-review-comment', 1, 3));
  s.pool.replaceFleetDigest(
    'bob@acme-api',
    'acme-api',
    digest('bob@acme-api', { byRule: late, byVersion: versionsOf(25) }),
  );

  const trends = foldPoolTrends(s.pool.listDigestRows(null));

  const review = trends.steps.find((st) => st.key === 'pr-review-comment')!;
  assert.equal(review.label, 'Unhandled review comments', 'labelled from the rule registry');
  assert.equal(review.fleets, 2);
  assert.deepEqual(
    review.releases.map((r) => [r.version, r.day]),
    [['0.2.0', day(20)]],
    '0.1.0 is where records start',
  );
  const release = review.releases[0]!;
  assert.equal(release.version, '0.2.0');
  assert.deepEqual(
    release.fleets.map((f) => [f.fleetId, f.day, f.beforePerRunUsd, f.afterPerRunUsd]),
    [
      ['alice@acme-api', day(20), 2, 1],
      ['bob@acme-api', day(25), 3, 3],
    ],
  );
  assert.equal(release.beforePerRunUsd, 2.33, '(56 + 42) / (28 + 14), pooled over both fleets’ own windows');
  assert.equal(release.afterPerRunUsd, 1.67, '(28 + 42) / (28 + 14)');
  assert.deepEqual([release.cheaper, release.dearer, release.steady], [1, 0, 1]);
});

test('a partial day is left out of every trend figure', () => {
  const s = new Store(':memory:', () => NOW);
  s.pool.replaceFleetDigest(
    'alice@acme-api',
    'acme-api',
    digest('alice@acme-api', {
      byRule: [row(0, 'pr-ci-failing', 2, 4), { ...row(1, 'pr-ci-failing', 1, 0.1), partial: true }],
    }),
  );
  const trends = foldPoolTrends(s.pool.listDigestRows(null));
  assert.deepEqual(trends.days, [day(0)]);
  assert.deepEqual(trends.steps[0]!.median, [2]);
});

test('a release too new for a whole after-window has no verdict, and a fleet that never ran the step does not date it', () => {
  const s = new Store(':memory:', () => NOW);
  const versionsOf = (upgradeOn: number) =>
    Array.from({ length: 30 }, (_, d) => row(d, d < upgradeOn ? '0.1.0' : '0.2.0', 1));
  s.pool.replaceFleetDigest(
    'alice@acme-api',
    'acme-api',
    digest('alice@acme-api', {
      byRule: Array.from({ length: 30 }, (_, d) => row(d, 'pr-ci-failing', 1, 2)),
      byVersion: versionsOf(25),
    }),
  );
  s.pool.replaceFleetDigest(
    'bob@acme-api',
    'acme-api',
    digest('bob@acme-api', { byRule: [row(0, 'pr-review-comment', 1, 1)], byVersion: versionsOf(10) }),
  );

  const ci = foldPoolTrends(s.pool.listDigestRows(null)).steps.find((st) => st.key === 'pr-ci-failing')!;
  const release = ci.releases[0]!;
  assert.equal(release.day, day(25), 'bob adopted earlier but never ran this step');
  assert.deepEqual(
    release.fleets.map((f) => f.fleetId),
    ['alice@acme-api'],
  );
  assert.equal(release.fleets[0]!.afterPerRunUsd, null, 'four whole days after is not fourteen');
  assert.equal(release.verdict, null);
  assert.deepEqual([release.cheaper, release.dearer, release.steady], [0, 0, 0]);
});

test('the desk records the running build, and keeps only the retention window of days', async () => {
  let now = '2026-01-01T09:00:00.000Z';
  const s = new Store(':memory:', () => now);
  const desk = new PoolDesk({
    store: s,
    transport: new FakePoolTransport(),
    fleetId: 'alice@acme-api',
    project: 'acme-api',
    harnessVersion: '0.1.0',
    harnessBuild: () => Promise.resolve('0.1.0+abc123def456'),
    now: () => now,
    digestIntervalMs: 60 * 60 * 1000,
    worldScope: SCOPED,
  });
  await desk.run();
  now = NOW;
  await desk.run();
  assert.deepEqual(s.pool.listHarnessDaysSince('2000-01-01'), [{ day: '2026-08-24', version: '0.1.0+abc123def456' }]);
});
