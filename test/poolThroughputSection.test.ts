import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { foldPoolDigest } from '../src/pool/aggregate.js';
import { buildDigestDocument } from '../src/pool/digestArm.js';
import { POOL_SCHEMA_VERSION, parsePoolDocument } from '../src/pool/document.js';
import { renderPoolMarkdown } from '../src/pool/markdown.js';
import { POOLED_THROUGHPUT_MEASURES, throughputMeasureLabel } from '../src/throughputInsights.js';
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

function fleetWithWork(): Store {
  const store = new Store(':memory:', () => NOW);
  store.recordWorldEvents([
    { kind: 'pr_opened', ref: 'pr:1', summary: 'PR #1 opened: a change' },
    { kind: 'pr_merged', ref: 'pr:1', summary: 'PR #1 merged' },
    { kind: 'pr_comment', ref: 'pr:1', summary: 'PR #1: someone commented' },
    { kind: 'issue_closed', ref: 'issue:1', summary: 'Issue #1 closed' },
    { kind: 'pr_mergeable', ref: 'pr:1', summary: 'PR #1 is mergeable' },
  ]);
  store.recordPrReplySent(1, 'thread-1', 'comment-1');
  return store;
}

test('the digest carries every measure, keyed by measure and bucketed by UTC day', () => {
  const document = buildDigestDocument(fleetWithWork(), {
    fleetId: 'alice@acme-api',
    project: 'acme-api',
    harnessVersion: '0.1.0',
    now: NOW,
  });

  assert.deepEqual(
    document.byThroughput.map((r) => [r.key, r.count, r.costUsd, r.partial]),
    [
      ['issue-closed', 1, null, true],
      ['pr-merged', 1, null, true],
      ['pr-opened', 1, null, true],
      ['reply-sent', 1, null, true],
      ['review-received', 1, null, true],
    ],
    'one row per measure, no cost on any of them, and the publish day is partial',
  );
  assert.ok(
    !document.byThroughput.some((r) => r.key === 'pr_mergeable'),
    'a world event with no measure is not published under its own kind',
  );
});

test('a throughput row carries no cost, and a document from a build without the section reads as empty', () => {
  const document = buildDigestDocument(fleetWithWork(), {
    fleetId: 'alice@acme-api',
    project: 'acme-api',
    harnessVersion: '0.1.0',
    now: NOW,
  });
  assert.ok(document.byThroughput.every((r) => r.costUsd === null));

  const older = { ...document } as Record<string, unknown>;
  delete older.byThroughput;
  const parsed = parsePoolDocument(JSON.stringify(older));
  assert.equal(parsed.ok, true, 'an additive section never makes an older document unreadable');
  assert.deepEqual(parsed.ok && parsed.document.byThroughput, []);
});

test('only what a fleet did itself reaches the mirror — the repository’s facts stay in the document', () => {
  const store = new Store(':memory:', () => NOW);
  store.replacePoolFleetDigest(
    'alice@acme-api',
    'acme-api',
    digestDoc({
      fleetId: 'alice@acme-api',
      byThroughput: [
        { day: '2026-08-23', key: 'pr-merged', count: 9, costUsd: null, partial: false },
        { day: '2026-08-23', key: 'review-received', count: 30, costUsd: null, partial: false },
        { day: '2026-08-23', key: 'reply-sent', count: 22, costUsd: null, partial: false },
      ],
    }),
  );

  const rollup = foldPoolDigest(store.listPoolDigestRows('acme-api'), { project: 'acme-api', since: null });
  assert.deepEqual(
    rollup.byThroughput.map((r) => r.key),
    ['reply-sent'],
    'the merges and the review the world did are a property of the repository and never sum',
  );
  assert.equal(rollup.byThroughput[0]?.count, 22);
  assert.equal(rollup.byThroughput[0]?.label, throughputMeasureLabel('reply-sent'));
  assert.deepEqual([...POOLED_THROUGHPUT_MEASURES], ['reply-sent'], 'the poolable set is the `ours` flag, not a list');
});

test('four fleets on one project do not multiply one repository’s merges', () => {
  const store = new Store(':memory:', () => NOW);
  for (const id of ['a', 'b', 'c', 'd']) {
    store.replacePoolFleetDigest(
      `${id}@acme-api`,
      'acme-api',
      digestDoc({
        fleetId: `${id}@acme-api`,
        byThroughput: [
          // Every fleet watching the repository saw the same twelve merges.
          { day: '2026-08-23', key: 'pr-merged', count: 12, costUsd: null, partial: false },
          { day: '2026-08-23', key: 'reply-sent', count: 5, costUsd: null, partial: false },
        ],
      }),
    );
  }

  const rollup = foldPoolDigest(store.listPoolDigestRows('acme-api'), { project: 'acme-api', since: null });
  assert.equal(
    rollup.byThroughput.find((r) => r.key === 'pr-merged'),
    undefined,
    'summed, this would report 48 merges of a repository that had 12',
  );
  const replies = rollup.byThroughput.find((r) => r.key === 'reply-sent');
  assert.deepEqual([replies?.count, replies?.fleets], [20, 4], 'four fleets each sent their own five replies');
});

test('the fleet’s own companion carries every measure, and says which of them crosses', () => {
  const text = renderPoolMarkdown(
    digestDoc({
      byThroughput: [
        { day: '2026-08-23', key: 'pr-merged', count: 9, costUsd: null, partial: false },
        { day: '2026-08-23', key: 'reply-sent', count: 22, costUsd: null, partial: false },
      ],
    }),
  );
  assert.match(text, /What came out/);
  assert.match(text, /PRs merged/, 'the whole section is readable for one fleet, where no double count can arise');
  assert.match(text, /Replies sent/);
  assert.match(text, /counts watchers, not work/, 'the caveat says why the rest does not cross');
  assert.ok(!/\| Cost \|/.test(text.split('What came out')[1]?.split('##')[0] ?? ''), 'no cost column on this section');
});
