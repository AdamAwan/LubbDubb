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
import { gitRepo } from './support/gitRepo.js';

/**
 * The cross-fleet pool (docs/spec/28-cross-fleet-pool.md).
 *
 * Most of what is asserted here is **negative**, for the reason `test/obstacleIntake.test.ts`
 * gives one level down: this subsystem's failure mode is a claim nobody vouched for
 * reaching every agent, now with a machine boundary in the middle of it. So the
 * properties that matter are that an arrival lands with exactly *one* corroboration
 * whatever the origin's count says, that re-polling the same document forever does
 * not climb, that a notice and a `check:` scope never leave the machine at all, and
 * that a failure anywhere leaves the harness working exactly as a fleet without a
 * pool.
 */

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
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

test('a document from a newer harness is skipped per document, not per fetch', () => {
  const ahead = parsePoolDocument(JSON.stringify({ ...envelopeDoc(), pool: POOL_SCHEMA_VERSION + 1 }));
  assert.equal(ahead.ok, false);
  assert.equal(ahead.ok === false && ahead.reason, 'ahead');
  // The fleet id is still read off the envelope, so the page can say *which* fleet
  // is ahead of you rather than reporting a fleet that has published nothing.
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

// ---------------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------------

test('the digest buckets by UTC day and marks the current one partial', () => {
  const s = store();
  const document = buildDigestDocument(s, {
    fleetId: 'alice@acme-api',
    project: 'acme-api',
    harnessVersion: '0.1.0',
    now: NOW,
  });
  assert.equal(document.kind, 'digest');
  // Every section is present on an empty fleet, `unaccounted` and `unmeasured`
  // included: an optional field makes every aggregate silently partial.
  assert.deepEqual(
    Object.keys(document)
      .filter((k) => Array.isArray((document as unknown as Record<string, unknown>)[k]))
      .sort(),
    ['byCause', 'byCheck', 'byFault', 'byPhase', 'unaccounted', 'unmeasured'],
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
    byFault: [{ day: '2026-08-23', key: 'provider', count: 5, costUsd: null, partial: false }],
  });
  const s = store();
  s.replacePoolFleetDigest(
    'alice@acme-api',
    'acme-api',
    digest('alice@acme-api', [
      { day: '2026-08-22', key: 'build', count: 2, costUsd: 10, partial: false },
      // The current day: counts in the total, and never in the average.
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

  // And the reading that only exists inside one project.
  assert.equal(rollup.byCheck?.length, 1);
  assert.equal(foldPoolDigest(s.listPoolDigestRows(null), { project: null }).byCheck, null);
});

/**
 * Faults ride the digest so the companion can draw them from the document it
 * renders — and they go no further than this fleet's own file.
 * → `docs/spec/28-cross-fleet-pool.md#the-faults-section`
 */
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

  // A clear takes them with it: the log is a list an operator clears, which is the
  // caveat the companion prints under the table.
  s.clearErrors();
  assert.deepEqual(
    buildDigestDocument(s, { fleetId: 'alice@acme-api', project: 'acme-api', harnessVersion: '0.1.0', now: NOW })
      .byFault,
    [],
  );
});

/**
 * The one omission in `digestSections`, asserted rather than trusted to a comment:
 * a fault is this harness on this machine, comparable to nothing on anybody else's,
 * so it is published for a person to read and never mirrored for a page to sum.
 */
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
    byFault: [{ day: '2026-08-23', key: 'provider', count: 40, costUsd: null, partial: false }],
  });

  const mirrored = s.listPoolDigestRows('acme-api');
  assert.ok(mirrored.length > 0, 'the rest of the document did land');
  assert.deepEqual(
    mirrored.filter((r) => r.key === 'provider'),
    [],
  );
});

// ---------------------------------------------------------------------------
// The desk
// ---------------------------------------------------------------------------

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

  // Nothing has changed, so the hash matches and the desk writes nothing — which is
  // what stops every idle fleet committing an identical file twenty-four times a day.
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

  // And the retry is the next pulse: no backoff, because a recovered pool taking an
  // hour to be noticed is worse than one error record per failure.
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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

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

/**
 * The fleet's own name is the one pool key a boot refusal was wrong about.
 *
 * The coordinates above arrive in the committed `lubbdubb.project.json`, so a
 * missing one is a mis-committed file every clone shares — but `fleetId` is the
 * deployment's, and refusing to start over it handed every operator on a team that
 * committed the pool a harness that would not boot, over a key the cockpit is where
 * you set. So it boots, the row on **Needs you** asks
 * (`test/setup.test.ts`), and the desk sits out until it is answered — never
 * publishing to `fleets//claims.json`, which every other fleet reads as a document
 * with no author.
 */
test('a pool selected before the fleet is named boots, and publishes nothing until it is', () => {
  const selected = {
    integrations: { sourceControl: 'fake' as const, issues: 'fake' as const, pool: 'git' as const },
    pool: { project: 'acme-api', remote: 'https://git.example/eng/wiki.git', branch: 'main' },
    dbPath: ':memory:',
  };
  const unnamed = loadConfig(selected);
  assert.equal(unnamed.fleetId, undefined);
  assert.equal(buildSystem(unnamed).pool, undefined, 'no desk, so nothing is published under an empty address');

  const named = loadConfig({ ...selected, fleetId: 'alice@acme-api' });
  assert.equal(buildSystem(named).pool?.status().fleetId, 'alice@acme-api');
});

test('a pool path that escapes the clone is refused at config load, not at write time', () => {
  for (const path of ['/etc', '../../elsewhere', 'engineering/../../..', 'C:\\\\wiki']) {
    assert.throws(() => loadConfig({ pool: { path } }), /escapes the pool's clone/, path);
  }
  // A prefix inside the repository is the whole point: a team's existing wiki hosts
  // the pool in a folder rather than having its root written into.
  assert.equal(loadConfig({ pool: { path: 'engineering/fleet-pool' } }).pool?.path, 'engineering/fleet-pool');
  assert.equal(loadConfig().pool?.path, undefined, 'empty is the repository root');
});

// ---------------------------------------------------------------------------
// The git transport, against real git
// ---------------------------------------------------------------------------

/**
 * An identity for the commits the transport makes.
 *
 * `gitRepo` configures one on the repository it creates, but the pool clone is made
 * by the transport itself — so there is nothing for a test to configure it on, and a
 * runner with no global identity fails the commit for the author rather than for
 * anything under test. The environment is the one place that reaches a clone nobody
 * has created yet. `??=` so a developer's own identity is left alone.
 */
process.env.GIT_AUTHOR_NAME ??= 'Test';
process.env.GIT_AUTHOR_EMAIL ??= 'test@example.com';
process.env.GIT_COMMITTER_NAME ??= 'Test';
process.env.GIT_COMMITTER_EMAIL ??= 'test@example.com';

/**
 * A bare repository with `main` and one commit on it, standing in for the pool's
 * remote. Bare because that is what a remote is, and seeded because
 * `clone --branch main` on an empty one names a branch that does not exist yet.
 */
function poolRemote(): string {
  const bare = mkdtempSync(join(tmpdir(), 'lubbdubb-pool-remote-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: bare });
  const seed = gitRepo('lubbdubb-pool-seed-');
  execFileSync('git', ['push', '-q', bare, 'main'], { cwd: seed });
  return bare;
}

/** What the remote holds, read through a throwaway clone rather than plumbing. */
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

/**
 * The regression that shipped: `rev-parse --git-dir` walks *up*, so a pool root
 * inside another repository's working tree reported that repository's git dir and
 * the guard returned early — never cloning, and writing the fleet's document into
 * the enclosing checkout instead. This is the default configuration and not an
 * exotic one: `poolRoot` is `<deskRoot>/pool` and `deskRoot` resolves against
 * `repoRoot`, so the pool root is always inside the target repository.
 */
test('the git transport clones its own root even when that root sits inside another repository', async () => {
  const remote = poolRemote();
  const enclosing = gitRepo('lubbdubb-pool-enclosing-');
  const root = join(enclosing, '.lubbdubb', 'desk', 'pool');
  mkdirSync(root, { recursive: true });

  const transport = new GitPoolTransport({ root, remote, branch: 'main', path: '', fleetId: 'alice@acme-api' });
  await transport.publish(envelopeDoc({ fleetId: 'alice@acme-api' }));

  assert.equal(gitOut(root, ['rev-parse', '--show-toplevel']), realpathSync(root), 'the pool root is its own clone');
  assert.notEqual(remoteFile(remote, 'fleets/alice@acme-api/digest.json'), null, 'the document reached the pool');
  // The worse outcome of the same bug, and the silent one: where the enclosing
  // repository does not happen to ignore the path, `git add` succeeds and the
  // harness commits a pool document into the operator's repository on a schedule.
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

  // Re-derivable by construction — the put is a whole replace — so the directory the
  // transport owns is cleared rather than merged into the clone.
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

/**
 * The file a retired kind left behind.
 *
 * `claims.json` was a second clock document until the claims arm went
 * (28-cross-fleet-pool). The type narrowed to `digest` and the parser stopped
 * having a grammar for it, but the transport went on naming it in every fleet's
 * directory — so a pool that had ever run the old build fetched its own stale file
 * and recorded `unknown document kind "claims"` on every pulse, for as long as the
 * file existed. `fetch` names the kinds that exist, and nothing else in the
 * namespace is read.
 */
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

/**
 * And the file itself goes, on the next publish.
 *
 * Nobody else can remove it — one writer per namespace cuts both ways — so a pool
 * heals as its fleets upgrade, each clearing its own. The companion matters as much
 * as the document: a wiki that keeps a page about an arm that is gone is a wiki
 * that describes a harness nobody is running.
 */
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

  // The second publish finds nothing to clear: `git add` on a path that never
  // existed is a fatal pathspec error, so a deployment that predates nothing must
  // not be paying one.
  await transport.publish(envelopeDoc({ fleetId: 'alice@acme-api', publishedAt: '2026-01-02T00:00:00.000Z' }));
});
