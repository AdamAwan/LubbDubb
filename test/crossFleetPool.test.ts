import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { loadConfig } from '../src/config.js';
import { FakePoolTransport } from '../src/integrations/fake/fakePool.js';
import { GitPoolTransport } from '../src/integrations/pool/gitPool.js';
import { foldPoolDigest } from '../src/pool/aggregate.js';
import { buildDigestDocument, POOL_RETENTION_DAYS, utcDay } from '../src/pool/digestArm.js';
import {
  POOL_SCHEMA_VERSION,
  parsePoolDocument,
  poolContentHash,
  poolDocumentPath,
  serialisePoolDocument,
} from '../src/pool/document.js';
import { PoolDesk } from '../src/pool/poolDesk.js';
import type { PoolDigestDocument } from '../src/types.js';
import { buildSystem } from '../src/system.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { gitRepo } from './support/gitRepo.js';

const NOW = '2026-08-24T12:00:00.000Z';

function store(now = NOW): Store {
  return new Store(':memory:', () => now);
}

function envelopeDoc(over: Partial<PoolDigestDocument> = {}): PoolDigestDocument {
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
    byFault: [],
    unaccounted: [],
    unmeasured: [],
    byUsage: [],
    byThroughput: [],
    ...over,
  };
}

test('a document from a newer harness is skipped per document, not per fetch', () => {
  const ahead = parsePoolDocument(JSON.stringify({ ...envelopeDoc(), pool: POOL_SCHEMA_VERSION + 1 }));
  assert.equal(ahead.ok, false);
  assert.equal(ahead.ok === false && ahead.reason, 'ahead');
  assert.equal(ahead.ok === false && ahead.reason === 'ahead' && ahead.fleetId, 'bob@acme-api');
});

test('a fleet publishing under another fleet’s name is discarded', () => {
  const parsed = parsePoolDocument(serialisePoolDocument(envelopeDoc({ fleetId: 'mallory@acme-api' })), 'bob@acme-api');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.ok === false && parsed.reason, 'mismatched-fleet');
});

test('the content hash ignores publishedAt, so an idle fleet writes nothing', () => {
  const a = envelopeDoc({ publishedAt: '2026-08-24T09:00:00.000Z' });
  const b = envelopeDoc({ publishedAt: '2026-08-24T10:00:00.000Z' });
  assert.equal(poolContentHash(a), poolContentHash(b));
  assert.notEqual(
    poolContentHash(a),
    poolContentHash(
      envelopeDoc({ byPhase: [{ day: '2026-08-24', key: 'code', count: 1, costUsd: 1, partial: false }] }),
    ),
  );
});

test('an address is fleets/<fleetId>/<kind>.json', () => {
  assert.equal(poolDocumentPath('alice@acme-api', 'digest'), 'fleets/alice@acme-api/digest.json');
});

test('the digest buckets by UTC day and marks the current one partial', () => {
  const s = store();
  const document = buildDigestDocument(s, {
    fleetId: 'alice@acme-api',
    project: 'acme-api',
    harnessVersion: '0.1.0',
    now: NOW,
  });
  assert.equal(document.kind, 'digest');
  assert.deepEqual(
    Object.keys(document)
      .filter((k) => Array.isArray((document as unknown as Record<string, unknown>)[k]))
      .sort(),
    ['byCause', 'byCheck', 'byFault', 'byPhase', 'byUsage', 'unaccounted', 'unmeasured'],
  );
  assert.equal(utcDay(NOW), '2026-08-24');
  assert.equal(POOL_RETENTION_DAYS, 90, 'a stated constant, never a config key');
});

test('the aggregator takes shares from summed counts and keeps a partial day out of every average', () => {
  const digest = (fleetId: string, rows: PoolDigestDocument['byPhase']): PoolDigestDocument => ({
    pool: POOL_SCHEMA_VERSION,
    kind: 'digest',
    fleetId,
    project: 'acme-api',
    publishedAt: NOW,
    harnessVersion: '0.1.0',
    byPhase: rows,
    byCause: [],
    byCheck: [{ day: '2026-08-23', key: 'test (windows)', count: 3, costUsd: 9, partial: false }],
    unaccounted: [],
    unmeasured: [],
    byUsage: [],
    byThroughput: [],
    byFault: [{ day: '2026-08-23', key: 'provider', count: 5, costUsd: null, partial: false }],
  });
  const s = store();
  s.replacePoolFleetDigest(
    'alice@acme-api',
    'acme-api',
    digest('alice@acme-api', [
      { day: '2026-08-22', key: 'build', count: 2, costUsd: 10, partial: false },
      { day: '2026-08-24', key: 'build', count: 1, costUsd: 2, partial: true },
    ]),
  );
  s.replacePoolFleetDigest(
    'bob@acme-api',
    'acme-api',
    digest('bob@acme-api', [{ day: '2026-08-22', key: 'build', count: 4, costUsd: 30, partial: false }]),
  );

  const rollup = foldPoolDigest(s.listPoolDigestRows('acme-api'), { project: 'acme-api' });
  const build = rollup.byPhase.find((r) => r.key === 'build')!;
  assert.equal(build.count, 7);
  assert.equal(build.costUsd, 42, 'a partial day counts in a total');
  assert.equal(build.fleets, 2);
  assert.equal(build.dailyMeanCostUsd, 20, '(10 + 30) over two whole fleet-days — the partial one is out');

  assert.equal(rollup.byCheck?.length, 1);
  assert.equal(foldPoolDigest(s.listPoolDigestRows(null), { project: null }).byCheck, null);
});

test('the digest counts faults by source per day, and carries no cost for one', () => {
  const s = store();
  s.recordError({ source: 'provider', message: 'github snapshot failed' });
  s.recordError({ source: 'provider', message: 'github snapshot failed again' });
  s.recordError({ source: 'agent', message: 'spawn failed' });

  const document = buildDigestDocument(s, {
    fleetId: 'alice@acme-api',
    project: 'acme-api',
    harnessVersion: '0.1.0',
    now: NOW,
  });

  assert.deepEqual(
    document.byFault.map((r) => [r.key, r.count, r.costUsd]),
    [
      ['agent', 1, null],
      ['provider', 2, null],
    ],
  );
  assert.ok(document.byFault.every((r) => r.day === utcDay(NOW) && r.partial));

  s.clearErrors();
  assert.deepEqual(
    buildDigestDocument(s, { fleetId: 'alice@acme-api', project: 'acme-api', harnessVersion: '0.1.0', now: NOW })
      .byFault,
    [],
  );
});

test('a fleet’s faults are never mirrored, whatever its document carries', () => {
  const s = store();
  s.replacePoolFleetDigest('bob@acme-api', 'acme-api', {
    pool: POOL_SCHEMA_VERSION,
    kind: 'digest',
    fleetId: 'bob@acme-api',
    project: 'acme-api',
    publishedAt: NOW,
    harnessVersion: '0.1.0',
    byPhase: [{ day: '2026-08-23', key: 'build', count: 1, costUsd: 1, partial: false }],
    byCause: [],
    byCheck: [],
    unaccounted: [],
    unmeasured: [],
    byUsage: [],
    byThroughput: [],
    byFault: [{ day: '2026-08-23', key: 'provider', count: 40, costUsd: null, partial: false }],
  });

  const mirrored = s.listPoolDigestRows('acme-api');
  assert.ok(mirrored.length > 0, 'the rest of the document did land');
  assert.deepEqual(
    mirrored.filter((r) => r.key === 'provider'),
    [],
  );
});

function desk(s: Store, transport: FakePoolTransport, now = () => NOW): PoolDesk {
  return new PoolDesk({
    store: s,
    transport,
    fleetId: 'alice@acme-api',
    project: 'acme-api',
    harnessVersion: '0.1.0',
    now,
    digestIntervalMs: 60 * 60 * 1000,
    closedPrWindowMs: 6 * 60 * 60 * 1000,
  });
}

test('the first pass publishes the digest, and an idle fleet then writes nothing', async () => {
  const s = store();
  const transport = new FakePoolTransport();
  const d = desk(s, transport);

  await d.run();
  assert.deepEqual(
    transport.published.map((p) => p.kind),
    ['digest'],
    'boot publishes rather than waiting an hour',
  );

  await d.run();
  await d.run();
  assert.equal(transport.published.length, 1);
});

test('a failed publish leaves the document dirty and nothing else stops', async () => {
  const s = store();
  const transport = new FakePoolTransport();
  transport.publishError = new Error('the remote refused the push');
  const errors: string[] = [];
  const d = new PoolDesk({
    store: s,
    transport,
    fleetId: 'alice@acme-api',
    project: 'acme-api',
    harnessVersion: '0.1.0',
    now: () => NOW,
    digestIntervalMs: 60 * 60 * 1000,
    closedPrWindowMs: 6 * 60 * 60 * 1000,
    errors: { record: (e: { message: string }) => void errors.push(e.message) } as never,
  });

  await d.run();
  assert.equal(s.getPoolPublication('digest').dirty, true, 'there is nothing to queue — it simply stays dirty');
  assert.equal(s.getPoolPublication('digest').contentHash, null);
  assert.ok(
    errors.some((m) => /Could not publish/.test(m)),
    'recorded, never swallowed',
  );

  transport.publishError = null;
  await d.run();
  assert.equal(s.getPoolPublication('digest').dirty, false);
});

test('a failed fetch leaves the last-known-good mirror in place', async () => {
  const s = store();
  const transport = new FakePoolTransport();
  transport.seed(envelopeDoc({ byPhase: [{ day: '2026-08-24', key: 'code', count: 2, costUsd: 3, partial: false }] }));
  const d = desk(s, transport);
  await d.run();
  assert.equal(s.listPoolDigestRows('acme-api').length, 1);

  transport.fetchError = new Error('the pool is unreachable');
  await d.run();
  assert.equal(
    s.listPoolDigestRows('acme-api').length,
    1,
    'an outage is never folded into "nobody has published anything"',
  );
  assert.equal(s.listPoolFleets().length, 1);
});

test('a publish-only substrate runs no poller and holds no mirror', async () => {
  const s = store();
  const transport = new FakePoolTransport(false);
  transport.seed(envelopeDoc({ byPhase: [{ day: '2026-08-24', key: 'code', count: 2, costUsd: 3, partial: false }] }));
  await desk(s, transport).run();
  assert.equal(
    s.listPoolDigestRows(null).length,
    0,
    'degraded explicitly, and never a fleet that believes it is reading',
  );
  assert.ok(transport.published.length > 0, 'it still contributes');
});

test('the pool is off by default and refuses an incomplete target when it is on', () => {
  assert.equal(loadConfig().integrations.pool, 'fake');

  assert.throws(
    () => loadConfig({ integrations: { sourceControl: 'fake', issues: 'fake', pool: 'git' } }),
    /no pool\.project is set/,
    'there is no derivation fallback — a silent one would be a second source of truth for one string',
  );
  assert.throws(
    () =>
      loadConfig({
        integrations: { sourceControl: 'fake', issues: 'fake', pool: 'git' },
        pool: { project: 'acme-api' },
        fleetId: 'alice@acme-api',
      }),
    /pool\.remote/,
  );
});

test('a pool selected before the fleet is named boots, and publishes nothing until it is', () => {
  const selected = {
    integrations: { sourceControl: 'fake' as const, issues: 'fake' as const, pool: 'git' as const },
    pool: { project: 'acme-api', remote: 'https://git.example/eng/wiki.git', branch: 'main' },
    dbPath: ':memory:',
  };
  const unnamed = loadConfig(selected);
  assert.equal(unnamed.fleetId, undefined);
  const opts = { worktrees: new FakeWorktreeManager() };
  assert.equal(buildSystem(unnamed, opts).pool, undefined, 'no desk, so nothing is published under an empty address');

  const named = loadConfig({ ...selected, fleetId: 'alice@acme-api' });
  assert.equal(buildSystem(named, opts).pool?.status().fleetId, 'alice@acme-api');
});

test('a pool path that escapes the clone is refused at config load, not at write time', () => {
  for (const path of ['/etc', '../../elsewhere', 'engineering/../../..', 'C:\\\\wiki']) {
    assert.throws(() => loadConfig({ pool: { path } }), /escapes the pool's clone/, path);
  }
  assert.equal(loadConfig({ pool: { path: 'engineering/fleet-pool' } }).pool?.path, 'engineering/fleet-pool');
  assert.equal(loadConfig().pool?.path, undefined, 'empty is the repository root');
});

process.env.GIT_AUTHOR_NAME ??= 'Test';
process.env.GIT_AUTHOR_EMAIL ??= 'test@example.com';
process.env.GIT_COMMITTER_NAME ??= 'Test';
process.env.GIT_COMMITTER_EMAIL ??= 'test@example.com';

function poolRemote(): string {
  const bare = mkdtempSync(join(tmpdir(), 'lubbdubb-pool-remote-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: bare });
  const seed = gitRepo('lubbdubb-pool-seed-');
  execFileSync('git', ['push', '-q', bare, 'main'], { cwd: seed });
  return bare;
}

function remoteFile(remote: string, path: string): string | null {
  const reader = mkdtempSync(join(tmpdir(), 'lubbdubb-pool-read-'));
  execFileSync('git', ['clone', '-q', '--branch', 'main', remote, reader]);
  try {
    return readFileSync(join(reader, ...path.split('/')), 'utf8');
  } catch {
    return null;
  }
}

function gitOut(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('the git transport clones its own root even when that root sits inside another repository', async () => {
  const remote = poolRemote();
  const enclosing = gitRepo('lubbdubb-pool-enclosing-');
  const root = join(enclosing, '.lubbdubb', 'desk', 'pool');
  mkdirSync(root, { recursive: true });

  const transport = new GitPoolTransport({ root, remote, branch: 'main', path: '', fleetId: 'alice@acme-api' });
  await transport.publish(envelopeDoc({ fleetId: 'alice@acme-api' }));

  assert.equal(gitOut(root, ['rev-parse', '--show-toplevel']), realpathSync(root), 'the pool root is its own clone');
  assert.notEqual(remoteFile(remote, 'fleets/alice@acme-api/digest.json'), null, 'the document reached the pool');
  assert.equal(gitOut(enclosing, ['rev-list', '--count', 'HEAD']), '1', 'nothing was committed to the enclosing repo');
  assert.equal(gitOut(enclosing, ['diff', '--cached', '--name-only']), '', 'nothing was staged there either');
});

test('a stray document tree left by the unsound guard is cleared when the clone is made', async () => {
  const remote = poolRemote();
  const enclosing = gitRepo('lubbdubb-pool-stray-');
  const root = join(enclosing, '.lubbdubb', 'desk', 'pool');
  const stray = join(root, 'fleets', 'alice@acme-api');
  mkdirSync(stray, { recursive: true });
  writeFileSync(join(stray, 'digest.json'), '{"stray":true}', 'utf8');

  const transport = new GitPoolTransport({ root, remote, branch: 'main', path: '', fleetId: 'alice@acme-api' });
  await transport.publish(envelopeDoc({ fleetId: 'alice@acme-api' }));

  assert.notEqual(readFileSync(join(stray, 'digest.json'), 'utf8'), '{"stray":true}');
  assert.notEqual(remoteFile(remote, 'fleets/alice@acme-api/digest.json'), null);
});

test('a clone whose origin is not the configured remote is refused rather than written to', async () => {
  const configured = poolRemote();
  const other = poolRemote();
  const root = join(mkdtempSync(join(tmpdir(), 'lubbdubb-pool-wrong-')), 'pool');
  execFileSync('git', ['clone', '-q', '--branch', 'main', other, root]);

  const transport = new GitPoolTransport({
    root,
    remote: configured,
    branch: 'main',
    path: '',
    fleetId: 'alice@acme-api',
  });
  await assert.rejects(
    () => transport.publish(envelopeDoc({ fleetId: 'alice@acme-api' })),
    /not the configured remote/,
  );
  assert.equal(remoteFile(other, 'fleets/alice@acme-api/digest.json'), null, 'and nothing reached the wrong pool');
});

test('a document from a retired kind is not fetched, and reads as no document at all', async () => {
  const remote = poolRemote();
  const writer = mkdtempSync(join(tmpdir(), 'lubbdubb-pool-retired-'));
  execFileSync('git', ['clone', '-q', '--branch', 'main', remote, writer]);
  const namespace = join(writer, 'fleets', 'alice@acme-api');
  mkdirSync(namespace, { recursive: true });
  writeFileSync(join(namespace, 'claims.json'), '{"pool":1,"kind":"claims","fleetId":"alice@acme-api"}', 'utf8');
  writeFileSync(
    join(namespace, 'digest.json'),
    serialisePoolDocument(envelopeDoc({ fleetId: 'alice@acme-api' })),
    'utf8',
  );
  execFileSync('git', ['add', '-A'], { cwd: writer });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: writer });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: writer });

  const root = join(mkdtempSync(join(tmpdir(), 'lubbdubb-pool-retired-read-')), 'pool');
  const transport = new GitPoolTransport({ root, remote, branch: 'main', path: '', fleetId: 'bob@acme-api' });
  const fetched = await transport.fetch();

  assert.equal(fetched.length, 1, 'the stale file is not a document and is not handed up to be refused');
  assert.match(fetched[0]!.text, /"kind": "digest"/);
});

test("a publish clears what a retired kind left in this fleet's own namespace, and only its own", async () => {
  const remote = poolRemote();
  const writer = mkdtempSync(join(tmpdir(), 'lubbdubb-pool-prune-'));
  execFileSync('git', ['clone', '-q', '--branch', 'main', remote, writer]);
  for (const fleet of ['alice@acme-api', 'bob@acme-api']) {
    mkdirSync(join(writer, 'fleets', fleet), { recursive: true });
    writeFileSync(join(writer, 'fleets', fleet, 'claims.json'), '{"pool":1,"kind":"claims"}', 'utf8');
    writeFileSync(join(writer, 'fleets', fleet, 'claims.md'), '# claims\n', 'utf8');
  }
  execFileSync('git', ['add', '-A'], { cwd: writer });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: writer });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: writer });

  const root = join(mkdtempSync(join(tmpdir(), 'lubbdubb-pool-prune-clone-')), 'pool');
  const transport = new GitPoolTransport({ root, remote, branch: 'main', path: '', fleetId: 'alice@acme-api' });
  await transport.publish(envelopeDoc({ fleetId: 'alice@acme-api' }));

  assert.equal(remoteFile(remote, 'fleets/alice@acme-api/claims.json'), null);
  assert.equal(remoteFile(remote, 'fleets/alice@acme-api/claims.md'), null, 'the wiki page goes with the document');
  assert.notEqual(remoteFile(remote, 'fleets/alice@acme-api/digest.json'), null, 'the publish still published');
  assert.notEqual(
    remoteFile(remote, 'fleets/bob@acme-api/claims.json'),
    null,
    "another fleet's is not this fleet's to delete",
  );

  await transport.publish(envelopeDoc({ fleetId: 'alice@acme-api', publishedAt: '2026-01-02T00:00:00.000Z' }));
});
