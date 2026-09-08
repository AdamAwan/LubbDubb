import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { foldPoolDigest } from '../src/pool/aggregate.js';
import { buildDigestDocument } from '../src/pool/digestArm.js';
import { POOL_SCHEMA_VERSION, parsePoolDocument } from '../src/pool/document.js';
import { renderPoolMarkdown } from '../src/pool/markdown.js';
import { poolableThroughputMeasures, throughputMeasureLabel } from '../src/throughputInsights.js';
import type { PoolDigestDocument } from '../src/types.js';
import { INTEGRATION_PROVIDERS, VIEWER_SCOPED, worldScope } from '../src/integrations/registry.js';
import { loadConfig, type Config } from '../src/config.js';

const SCOPED = { pullRequests: true, issues: true };

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
    poolableThroughput: ['reply-sent'],
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
    scope: SCOPED,
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
    scope: SCOPED,
  });
  assert.ok(document.byThroughput.every((r) => r.costUsd === null));

  const older = { ...document } as Record<string, unknown>;
  delete older.byThroughput;
  const parsed = parsePoolDocument(JSON.stringify(older));
  assert.equal(parsed.ok, true, 'an additive section never makes an older document unreadable');
  assert.deepEqual(parsed.ok && parsed.document.byThroughput, []);
});

test('what may be summed is what the publishing fleet declared, and it declares what scoped it', () => {
  assert.deepEqual(
    [...poolableThroughputMeasures({ pullRequests: false, issues: false })],
    ['reply-sent'],
    'an unfiltered world publishes only the record the fleet keeps itself',
  );
  assert.deepEqual(
    [...poolableThroughputMeasures({ pullRequests: true, issues: false })],
    ['pr-opened', 'pr-merged', 'pr-closed', 'pr-approved', 'review-received', 'reply-sent'],
    'the GitHub default: pull requests are filtered to the operator, issues are the whole repository',
  );
  assert.equal(
    poolableThroughputMeasures({ pullRequests: true, issues: true }).length,
    8,
    'a world filtered on both axes is this fleet’s alone, and all of it sums',
  );
});

test('a measure the publisher did not declare is dropped at the mirror, not at the fold', () => {
  const store = new Store(':memory:', () => NOW);
  store.replacePoolFleetDigest(
    'alice@acme-api',
    'acme-api',
    digestDoc({
      fleetId: 'alice@acme-api',
      // A GitHub fleet: its pull requests were filtered to it, its issues were not.
      poolableThroughput: ['pr-merged', 'reply-sent'],
      byThroughput: [
        { day: '2026-08-23', key: 'pr-merged', count: 9, costUsd: null, partial: false },
        { day: '2026-08-23', key: 'issue-closed', count: 30, costUsd: null, partial: false },
        { day: '2026-08-23', key: 'reply-sent', count: 22, costUsd: null, partial: false },
      ],
    }),
  );

  const rollup = foldPoolDigest(store.listPoolDigestRows('acme-api'), { project: 'acme-api', since: null });
  assert.deepEqual(
    rollup.byThroughput.map((r) => [r.key, r.count]).sort(),
    [
      ['pr-merged', 9],
      ['reply-sent', 22],
    ],
    'the issues every fleet on this repository also saw never reach a summable table',
  );
  assert.equal(rollup.byThroughput.find((r) => r.key === 'pr-merged')?.label, throughputMeasureLabel('pr-merged'));
});

test('four fleets that could not scope their world do not multiply one repository’s merges', () => {
  const store = new Store(':memory:', () => NOW);
  for (const id of ['a', 'b', 'c', 'd']) {
    store.replacePoolFleetDigest(
      `${id}@acme-api`,
      'acme-api',
      digestDoc({
        fleetId: `${id}@acme-api`,
        // `ownWorkOnly` off: this fleet's world is the whole repository, so it
        // declares only its own record as summable.
        poolableThroughput: ['reply-sent'],
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
  assert.match(text, /count watchers rather than work/, 'the caveat says why the rest does not cross');
  assert.match(text, /poolableThroughput/, 'and names the field that says which rows this fleet published');
  assert.ok(!/\| Cost \|/.test(text.split('What came out')[1]?.split('##')[0] ?? ''), 'no cost column on this section');
});

test('every provider the registry can build declares whether its slice is filtered to the operator', () => {
  // The scoping table is read to decide what a fleet may publish as its own, so a
  // provider added without an entry would silently default to "unfiltered" — safe,
  // but it would drop that fleet's output from the pool with nothing red. This is
  // the assertion that makes adding one a deliberate act.
  for (const capability of ['sourceControl', 'issues'] as const) {
    for (const provider of Object.keys(INTEGRATION_PROVIDERS[capability])) {
      assert.equal(
        typeof VIEWER_SCOPED[capability][provider],
        'boolean',
        `${capability}/${provider} does not say whether its slice is filtered to the operator`,
      );
    }
  }
});

test('the scope follows ownWorkOnly, and GitHub issues are never this fleet’s alone', () => {
  const ctx = (over: Partial<Config>) => ({
    store: new Store(':memory:', () => NOW),
    config: loadConfig({ userId: 'alice', ownWorkOnly: true, ...over }),
    now: () => NOW,
  });

  assert.deepEqual(
    worldScope({ sourceControl: 'github', issues: 'github', pool: 'fake' }, ctx({})),
    { pullRequests: true, issues: false },
    'GitHub sweeps every open issue in the repository however the fleet is configured',
  );
  assert.deepEqual(
    worldScope({ sourceControl: 'azure', issues: 'azure', pool: 'fake' }, ctx({})),
    { pullRequests: true, issues: true },
    'Azure filters work items by assignee as well as pull requests by author',
  );
  assert.deepEqual(
    worldScope({ sourceControl: 'github', issues: 'github', pool: 'fake' }, ctx({ ownWorkOnly: false })),
    { pullRequests: false, issues: false },
    'ownWorkOnly off is a fleet watching the whole repository: none of it is its own',
  );
  assert.deepEqual(
    worldScope({ sourceControl: 'github', issues: 'github', pool: 'fake' }, ctx({ userId: undefined })),
    { pullRequests: false, issues: false },
    'ownWorkOnly with nobody to filter to is not a filter',
  );
});
