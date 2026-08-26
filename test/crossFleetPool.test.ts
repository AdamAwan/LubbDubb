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
import { buildClaimsDocument, importClaims, type ClaimArrival } from '../src/pool/claimsArm.js';
import { buildDigestDocument, POOL_RETENTION_DAYS, utcDay } from '../src/pool/digestArm.js';
import {
  POOL_SCHEMA_VERSION,
  parsePoolDocument,
  poolContentHash,
  poolDocumentPath,
  serialisePoolDocument,
} from '../src/pool/document.js';
import { PoolDesk } from '../src/pool/poolDesk.js';
import { secretRefusal } from '../src/pool/secrets.js';
import { distinctCorroborators } from '../src/knowledge/knowledge.js';
import type { FactObservation, PoolClaimsDocument, PoolDigestDocument } from '../src/types.js';
import { gitRepo } from './support/gitRepo.js';

/**
 * The cross-fleet pool (docs/spec/28-cross-fleet-pool.md).
 *
 * Most of what is asserted here is **negative**, for the reason `test/knowledge.test.ts`
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
  return new Store(':memory:', () => now, 'acme-api');
}

/** A claim vouched for: proposed, then ruled on, which is what makes it publishable. */
function vouched(s: Store, claim: string, observer: Partial<FactObservation> = {}): string {
  const outcome = s.proposeFact(
    {
      claim,
      scope: 'fleet',
      lifetime: 'standing',
      expiresInHours: null,
      evidence: 'What I actually saw.',
      supersedes: null,
      resolvesWhen: null,
      aboutRef: null,
      where: null,
    },
    { agentId: 'a1', taskId: 't1', goalRef: 'issue:1', sessionId: null, words: 'What I saw.', ...observer },
  );
  assert.notEqual(outcome.outcome, 'barred');
  const fact = outcome.outcome === 'barred' ? null : outcome.fact;
  s.setFactReach(fact!.id, 'lookup');
  return fact!.id;
}

function claimsDoc(over: Partial<PoolClaimsDocument> = {}): PoolClaimsDocument {
  return {
    pool: POOL_SCHEMA_VERSION,
    kind: 'claims',
    fleetId: 'bob@acme-api',
    project: 'acme-api',
    publishedAt: NOW,
    harnessVersion: '0.1.0',
    claims: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// What leaves
// ---------------------------------------------------------------------------

test('only a vouched, standing, fleet-scoped claim leaves the machine', () => {
  const s = store();
  const published = vouched(s, 'The native builds need npm ci before the tests will run at all.');

  // Two agents agreeing carries a claim to `lookup` and no further, and **no
  // operator has read it** — which is exactly the awkward case `ruled_at` closes.
  const unruled = s.proposeFact(
    {
      claim: 'Two agents agreed about this and nobody has looked at it.',
      scope: 'fleet',
      lifetime: 'standing',
      expiresInHours: null,
      evidence: 'One.',
      supersedes: null,
      resolvesWhen: null,
      aboutRef: null,
      where: null,
    },
    { agentId: 'a1', taskId: 't1', goalRef: 'issue:9', sessionId: null, words: 'One.' },
  );
  s.proposeFact(
    {
      claim: 'Two agents agreed about this and nobody has looked at it.',
      scope: 'fleet',
      lifetime: 'standing',
      expiresInHours: null,
      evidence: 'Two.',
      supersedes: null,
      resolvesWhen: null,
      aboutRef: null,
      where: null,
    },
    { agentId: 'a2', taskId: 't2', goalRef: 'issue:10', sessionId: null, words: 'Two.' },
  );
  assert.equal(unruled.outcome === 'barred' ? null : unruled.fact.reach, 'proposal');

  // A notice: an expiring fact whose resolution condition names a check on a pull
  // request in a repository the reader cannot see.
  const notice = s.proposeFact(
    {
      claim: 'test (windows) has been timing out at the install step since about 09:00 today.',
      scope: 'fleet',
      lifetime: 'expiring',
      expiresInHours: 8,
      evidence: 'Saw it twice.',
      supersedes: null,
      resolvesWhen: null,
      aboutRef: null,
      where: null,
    },
    { agentId: 'a3', taskId: 't3', goalRef: 'issue:11', sessionId: null, words: 'Saw it.' },
  );
  s.setFactReach(notice.outcome === 'barred' ? '' : notice.fact.id, 'injected');

  // A check-scoped claim: another fleet's pipeline, named in a provider's own words.
  const scoped = s.proposeFact(
    {
      claim: 'This particular check is configured with no retry at all, which is why it reads as flaky.',
      scope: 'check:test (windows)',
      lifetime: 'standing',
      expiresInHours: null,
      evidence: 'Read the workflow.',
      supersedes: null,
      resolvesWhen: null,
      aboutRef: null,
      where: null,
    },
    { agentId: 'a4', taskId: 't4', goalRef: 'issue:12', sessionId: null, words: 'Read it.' },
  );
  s.setFactReach(scoped.outcome === 'barred' ? '' : scoped.fact.id, 'lookup');

  const { document } = buildClaimsDocument(s, {
    fleetId: 'alice@acme-api',
    project: 'acme-api',
    harnessVersion: '0.1.0',
    now: NOW,
  });
  assert.deepEqual(
    document.claims.map((c) => c.id),
    [published],
    'the vouch, the standing lifetime and the fleet scope are each a gate, and each of the three others fails one',
  );
});

test('keepLocal withholds a claim, and putting it back publishes it again', () => {
  const s = store();
  const id = vouched(s, 'A claim that quotes a customer configuration, say.');
  const context = { fleetId: 'alice@acme-api', project: 'acme-api', harnessVersion: '0.1.0', now: NOW };
  assert.equal(buildClaimsDocument(s, context).document.claims.length, 1);

  s.setFactKeepLocal(id, true);
  assert.equal(
    buildClaimsDocument(s, context).document.claims.length,
    0,
    'withdrawal is one click and needs no tombstone — the claim is simply not in the next whole-document put',
  );
  // And it is not a ruling: the claim is still exactly where the operator left it.
  assert.equal(s.getFact(id)?.reach, 'lookup');

  s.setFactKeepLocal(id, false);
  assert.equal(buildClaimsDocument(s, context).document.claims.length, 1);
});

test('the secret backstop refuses and never rewrites', () => {
  const s = store();
  vouched(s, 'Set GITHUB_TOKEN to ghp_abcdefghijklmnopqrstuvwxyz0123456789 and the fetch works.');
  vouched(s, 'A perfectly ordinary claim about the toolchain that mentions no credential.');

  const derived = buildClaimsDocument(s, {
    fleetId: 'alice@acme-api',
    project: 'acme-api',
    harnessVersion: '0.1.0',
    now: NOW,
  });
  assert.equal(derived.document.claims.length, 1, 'the ordinary claim still crosses');
  assert.equal(derived.refusals.length, 1);
  // The reason names the *shape* and never quotes the match: echoing the secret into
  // the cockpit and the error log would be the control creating the exposure.
  assert.match(derived.refusals[0]!.reason, /GitHub token/);
  assert.ok(!derived.refusals[0]!.reason.includes('ghp_'));
  // Nothing was rewritten — a scrub that mostly works publishes looking clean, which
  // is the failure direction this shape exists to avoid.
  assert.match(s.getFact(derived.refusals[0]!.factId)!.claim, /ghp_/);
});

test('the secret backstop is high-confidence structure only', () => {
  assert.equal(secretRefusal('Acme Corporation asked us to raise the timeout.'), null, 'no expression matches a noun');
  assert.match(secretRefusal('-----BEGIN RSA PRIVATE KEY-----') ?? '', /private key/);
  assert.match(secretRefusal('https://user:hunter2@git.internal.example/x.git') ?? '', /credentials/);
});

// ---------------------------------------------------------------------------
// What arriving means
// ---------------------------------------------------------------------------

test('an arrival lands with exactly one corroboration, never the origin count', () => {
  const s = store();
  const local = vouched(s, 'The native builds need npm ci before the tests will run.');
  // Demote it back to a one-voice proposal, so what the arrival does is visible.
  const arrivals = importClaims(
    s,
    claimsDoc({
      claims: [
        {
          id: 'fact_remote',
          claim: 'The native builds need npm ci before the tests will run.',
          where: null,
          vouchedAt: NOW,
          // Five at origin. A fleet arriving with five would arrive already past
          // `lookup`, which is auto-promotion crossing a machine boundary.
          corroborations: 5,
          disputes: 2,
          evidence: ['better-sqlite3 and node-pty are native builds.'],
        },
      ],
    }),
    { project: 'acme-api', now: NOW },
  );
  assert.equal(arrivals[0]!.outcome, 'corroborated');
  assert.equal(arrivals[0]!.localFactId, local);

  const voices = s.listCorroborations(local);
  assert.equal(voices.length, 2, 'one local agent and one fleet — not one local agent and five');
  assert.deepEqual(
    voices.map((v) => v.fleetId),
    [null, 'bob@acme-api'],
  );
  // The origin's counts ride as provenance, in the class that is a reading and never
  // a trigger. The dispute count is the more useful of the two — *the fleet that
  // vouched for this has since had two agents contradict it*.
  assert.equal(arrivals[0]!.disputes, 2);
  assert.equal(arrivals[0]!.corroborations, 5);
});

test('re-polling the same document forever does not climb', () => {
  const s = store();
  const local = vouched(s, 'Windows refuses rmdir on a directory a live process holds as its cwd.');
  const document = claimsDoc({
    claims: [
      {
        id: 'fact_remote',
        claim: 'Windows refuses rmdir on a directory a live process holds as its cwd.',
        where: null,
        vouchedAt: NOW,
        corroborations: 1,
        disputes: 0,
        evidence: ['Every dispatch onto that branch then failed EBUSY.'],
      },
    ],
  });
  // Two hundred and eighty-eight polls is a day at the default heartbeat. An append
  // here would add one voice each time, cross to `lookup` on the first, and go on
  // climbing — with nothing erroring, and looking exactly like the design working.
  for (let i = 0; i < 20; i++) importClaims(s, document, { project: 'acme-api', now: NOW });
  const voices = s.listCorroborations(local);
  assert.equal(
    voices.filter((v) => v.fleetId === 'bob@acme-api').length,
    1,
    'upserted on (fact, fleet), never appended',
  );
});

test('one fleet is one voice however many entries it publishes', () => {
  // Two pooled rows from one fleet fold into the same union `distinctCorroborators`
  // takes over goal and session, rather than becoming two counts beside it.
  assert.equal(
    distinctCorroborators([
      { id: 'a', goalRef: null, sessionId: null, fleetId: 'bob@acme-api' },
      { id: 'b', goalRef: null, sessionId: null, fleetId: 'bob@acme-api' },
    ]),
    1,
  );
  assert.equal(
    distinctCorroborators([
      { id: 'a', goalRef: 'issue:1', sessionId: null, fleetId: null },
      { id: 'b', goalRef: null, sessionId: null, fleetId: 'bob@acme-api' },
    ]),
    2,
    'a local voice and a pooled one are two — which is what carries a proposal to lookup',
  );
});

test('the project name decides only whether a non-matching arrival is proposed', () => {
  const matching = 'The native builds need npm ci before the tests will run.';
  const unmatched = 'This project pins its lint configuration in a file nothing else reads.';

  // Same project, matching nothing local → proposed, awaiting a ruling.
  const same = store();
  assert.deepEqual(
    outcomes(importClaims(same, claimsDoc({ claims: [claim(unmatched)] }), { project: 'acme-api', now: NOW })),
    ['proposed'],
  );

  // Different project, matching nothing local → held in the mirror, proposed to
  // nobody. Proposing everything to everybody is a triage page nobody opens.
  const other = store();
  assert.deepEqual(
    outcomes(
      importClaims(other, claimsDoc({ project: 'other-api', claims: [claim(unmatched)] }), {
        project: 'acme-api',
        now: NOW,
      }),
    ),
    ['held'],
  );
  assert.equal(other.listFacts().length, 0, 'nothing reached knowledge_facts');
  assert.equal(other.listMirroredClaims().length, 0, 'and the mirror is written by the desk, not the importer');

  // Different project, **matching** a standing local claim → corroborates. Two
  // fleets on two projects saying one sentence is itself the evidence that the
  // sentence does not depend on the project.
  const crossing = store();
  const local = vouched(crossing, matching);
  assert.deepEqual(
    outcomes(
      importClaims(crossing, claimsDoc({ project: 'other-api', claims: [claim(matching)] }), {
        project: 'acme-api',
        now: NOW,
      }),
    ),
    ['corroborated'],
  );
  assert.equal(crossing.listCorroborations(local).length, 2);
});

test("a claim this fleet's operator rejected stays rejected however many fleets vouch for it", () => {
  const s = store();
  const id = vouched(s, 'A claim this operator has read and killed.');
  s.setFactReach(id, 'rejected');
  const arrivals = importClaims(s, claimsDoc({ claims: [claim('A claim this operator has read and killed.')] }), {
    project: 'acme-api',
    now: NOW,
  });
  assert.equal(arrivals[0]!.outcome, 'barred');
  assert.equal(arrivals[0]!.localFactId, null, 'the bar is not a way around one operator’s own ruling');
});

function claim(text: string) {
  return {
    id: `fact_${text.length}`,
    claim: text,
    where: null,
    vouchedAt: NOW,
    corroborations: 1,
    disputes: 0,
    evidence: [text],
  };
}

function outcomes(arrivals: ClaimArrival[]): string[] {
  return arrivals.map((a) => a.outcome);
}

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

test('a document from a newer harness is skipped per document, not per fetch', () => {
  const ahead = parsePoolDocument(JSON.stringify({ ...claimsDoc(), pool: POOL_SCHEMA_VERSION + 1 }));
  assert.equal(ahead.ok, false);
  assert.equal(ahead.ok === false && ahead.reason, 'ahead');
  // The fleet id is still read off the envelope, so the page can say *which* fleet
  // is ahead of you rather than reporting a fleet that has published nothing.
  assert.equal(ahead.ok === false && ahead.reason === 'ahead' && ahead.fleetId, 'bob@acme-api');
});

test('a fleet publishing under another fleet’s name is discarded', () => {
  const parsed = parsePoolDocument(serialisePoolDocument(claimsDoc({ fleetId: 'mallory@acme-api' })), 'bob@acme-api');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.ok === false && parsed.reason, 'mismatched-fleet');
});

test('the content hash ignores publishedAt, so an idle fleet writes nothing', () => {
  const a = claimsDoc({ publishedAt: '2026-08-24T09:00:00.000Z' });
  const b = claimsDoc({ publishedAt: '2026-08-24T10:00:00.000Z' });
  assert.equal(poolContentHash(a), poolContentHash(b));
  assert.notEqual(poolContentHash(a), poolContentHash(claimsDoc({ claims: [claim('Something new.')] })));
});

test('an address is fleets/<fleetId>/<kind>.json', () => {
  assert.equal(poolDocumentPath('alice@acme-api', 'claims'), 'fleets/alice@acme-api/claims.json');
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
  });
}

test('the first pass publishes both documents, and an idle fleet then writes nothing', async () => {
  const s = store();
  vouched(s, 'A claim somebody has ruled on.');
  const transport = new FakePoolTransport();
  const d = desk(s, transport);

  await d.run();
  assert.deepEqual(transport.published.map((p) => p.kind).sort(), ['claims', 'digest'], 'boot runs the backstop');

  // Nothing has changed, so the hash matches and the desk writes nothing — which is
  // what stops every idle fleet committing an identical file twenty-four times a day.
  await d.run();
  await d.run();
  assert.equal(transport.published.length, 2);
});

test('a ruling marks the document dirty and the next pulse publishes it', async () => {
  const s = store();
  const transport = new FakePoolTransport();
  const d = desk(s, transport);
  await d.run();
  const after = transport.published.length;

  vouched(s, 'A fresh claim an operator has just vouched for.');
  s.markPoolDirty('claims');
  await d.run();
  assert.equal(transport.published.length, after + 1);
  assert.equal(transport.published.at(-1)!.kind, 'claims');
});

test('a failed publish leaves the document dirty and nothing else stops', async () => {
  const s = store();
  vouched(s, 'A claim somebody has ruled on.');
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
    errors: { record: (e: { message: string }) => void errors.push(e.message) } as never,
  });

  await d.run();
  assert.equal(s.getPoolPublication('claims').dirty, true, 'there is nothing to queue — it simply stays dirty');
  assert.equal(s.getPoolPublication('claims').contentHash, null);
  assert.ok(
    errors.some((m) => /Could not publish/.test(m)),
    'recorded, never swallowed',
  );

  // And the retry is the next pulse: no backoff, because a recovered pool taking an
  // hour to be noticed is worse than one error record per failure.
  transport.publishError = null;
  await d.run();
  assert.equal(s.getPoolPublication('claims').dirty, false);
});

test('a failed fetch leaves the last-known-good mirror in place', async () => {
  const s = store();
  const transport = new FakePoolTransport();
  transport.seed(claimsDoc({ claims: [claim('A claim from somebody else entirely.')] }));
  const d = desk(s, transport);
  await d.run();
  assert.equal(s.listMirroredClaims().length, 1);

  transport.fetchError = new Error('the pool is unreachable');
  await d.run();
  assert.equal(s.listMirroredClaims().length, 1, 'an outage is never folded into "nobody has published anything"');
  assert.equal(s.listPoolFleets().length, 1);
});

test('a withdrawal at origin empties the mirror row without touching the local fact', async () => {
  const s = store();
  const local = vouched(s, 'The native builds need npm ci before the tests will run.');
  const transport = new FakePoolTransport();
  transport.seed(claimsDoc({ claims: [claim('The native builds need npm ci before the tests will run.')] }));
  const d = desk(s, transport);
  await d.run();
  assert.equal(s.mirroredClaimsForFact(local).length, 1);

  // Retired at origin, so it is simply not in the next document. No tombstone.
  transport.withdraw('bob@acme-api', 'claims');
  transport.seed(claimsDoc({ claims: [] }));
  await d.run();
  assert.equal(s.mirroredClaimsForFact(local).length, 0);
  assert.ok(s.getFact(local), 'deleting on a remote operator’s ruling would let one person prune another’s store');
  assert.equal(s.listCorroborations(local).length, 2, 'and the voice that was already counted stays counted');
});

test('a publish-only substrate runs no poller and holds no mirror', async () => {
  const s = store();
  const transport = new FakePoolTransport(false);
  transport.seed(claimsDoc({ claims: [claim('Something another fleet knows.')] }));
  await desk(s, transport).run();
  assert.equal(s.listMirroredClaims().length, 0, 'degraded explicitly, and never a fleet that believes it is reading');
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
      }),
    /no fleetId is set/,
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
// Persistence
// ---------------------------------------------------------------------------

test('the project stamp is written as the fact is, and a deployment with no name stamps nothing', () => {
  const named = new Store(':memory:', () => NOW, 'acme-api');
  assert.equal(named.getFact(vouched(named, 'A claim learned about this project.'))?.project, 'acme-api');

  const unnamed = new Store(':memory:', () => NOW);
  assert.equal(
    unnamed.getFact(vouched(unnamed, 'A claim learned about this project.'))?.project,
    null,
    'null spells *no project*, which is the honest answer rather than a guess',
  );
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
  await transport.publish(claimsDoc({ fleetId: 'alice@acme-api' }));

  assert.equal(gitOut(root, ['rev-parse', '--show-toplevel']), realpathSync(root), 'the pool root is its own clone');
  assert.notEqual(remoteFile(remote, 'fleets/alice@acme-api/claims.json'), null, 'the document reached the pool');
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
  writeFileSync(join(stray, 'claims.json'), '{"stray":true}', 'utf8');

  const transport = new GitPoolTransport({ root, remote, branch: 'main', path: '', fleetId: 'alice@acme-api' });
  await transport.publish(claimsDoc({ fleetId: 'alice@acme-api' }));

  // Re-derivable by construction — the put is a whole replace — so the directory the
  // transport owns is cleared rather than merged into the clone.
  assert.notEqual(readFileSync(join(stray, 'claims.json'), 'utf8'), '{"stray":true}');
  assert.notEqual(remoteFile(remote, 'fleets/alice@acme-api/claims.json'), null);
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
  await assert.rejects(() => transport.publish(claimsDoc({ fleetId: 'alice@acme-api' })), /not the configured remote/);
  assert.equal(remoteFile(other, 'fleets/alice@acme-api/claims.json'), null, 'and nothing reached the wrong pool');
});
