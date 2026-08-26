import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitPoolTransport } from '../src/integrations/pool/gitPool.js';
import { POOL_SCHEMA_VERSION } from '../src/pool/document.js';
import { poolMarkdownPath, renderPoolMarkdown } from '../src/pool/markdown.js';
import type { PoolClaimsDocument, PoolDigestDocument, PoolDigestRow } from '../src/types.js';
import { gitRepo } from './support/gitRepo.js';

/**
 * The human-readable companion.
 *
 * The property under test throughout is that it is **derived output and never an
 * input**: it renders the same document the JSON is serialised from, and `fetch`
 * does not read it back. A companion the importer parsed would be a second grammar
 * for one fact, free to disagree with the JSON and silent about it.
 * → `docs/spec/28-cross-fleet-pool.md#the-human-readable-companion`
 */

const NOW = '2026-08-25T09:14:02.481Z';

function claimsDoc(over: Partial<PoolClaimsDocument> = {}): PoolClaimsDocument {
  return {
    pool: POOL_SCHEMA_VERSION,
    kind: 'claims',
    fleetId: 'alice@acme-api',
    project: 'acme-api',
    publishedAt: NOW,
    harnessVersion: '0.1.0',
    claims: [],
    ...over,
  };
}

function digestDoc(over: Partial<PoolDigestDocument> = {}): PoolDigestDocument {
  return {
    pool: POOL_SCHEMA_VERSION,
    kind: 'digest',
    fleetId: 'alice@acme-api',
    project: 'acme-api',
    publishedAt: NOW,
    harnessVersion: '0.1.0',
    byPhase: [],
    byCause: [],
    byCheck: [],
    unaccounted: [],
    unmeasured: [],
    byFault: [],
    ...over,
  };
}

function row(day: string, key: string, count: number, costUsd: number | null): PoolDigestRow {
  return { day, key, count, costUsd, partial: day === '2026-08-25' };
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

test('the claims companion draws the words, where it applies and the origin counts', () => {
  const markdown = renderPoolMarkdown(
    claimsDoc({
      claims: [
        {
          id: 'fact_7Kq2',
          claim: 'The native builds need npm ci before the tests.',
          where: 'package.json',
          vouchedAt: '2026-08-19T16:02:11.000Z',
          corroborations: 4,
          disputes: 1,
          evidence: ['better-sqlite3 threw NODE_MODULE_VERSION until npm ci rebuilt it.'],
        },
      ],
    }),
  );

  assert.match(markdown, /^# acme-api — what this fleet has vouched for\n/);
  assert.match(markdown, /\*\*Fleet\*\* `alice@acme-api`/);
  assert.match(markdown, /## The native builds need npm ci before the tests\./);
  assert.match(markdown, /\*\*Where\*\* package\.json · \*\*Vouched\*\* 2026-08-19/);
  assert.match(markdown, /\*\*Corroborations\*\* 4 · \*\*Disputes\*\* 1/);
  assert.match(markdown, /- better-sqlite3 threw NODE_MODULE_VERSION until npm ci rebuilt it\./);
  // The counts are the loudest numbers on the page, and a reader who takes them for
  // a threshold has the corroboration gate backwards — so the file says which it is.
  assert.match(markdown, /a reading, and never a trigger/);
  // Nothing the reader cannot reach: no fact id, and no ref into somebody else's world.
  assert.doesNotMatch(markdown, /fact_7Kq2/);
});

/**
 * A claim is free text an agent wrote. A newline inside one would end the heading
 * it is drawn as, and the rest of the sentence would render as body text under a
 * truncated heading — which reads as a claim the fleet did not make.
 */
test('a claim written across lines is drawn on one', () => {
  const markdown = renderPoolMarkdown(
    claimsDoc({
      claims: [
        {
          id: 'f1',
          claim: 'Windows refuses rmdir\non a worktree a live process holds.',
          where: null,
          vouchedAt: '2026-08-11T10:41:55.000Z',
          corroborations: 2,
          disputes: 0,
          evidence: ['Every dispatch\nfailed EBUSY.'],
        },
      ],
    }),
  );

  assert.match(markdown, /## Windows refuses rmdir on a worktree a live process holds\.\n/);
  assert.match(markdown, /- Every dispatch failed EBUSY\.\n/);
  // `where` is null here, so the row starts at the vouch rather than drawing an empty field.
  assert.match(markdown, /^\*\*Vouched\*\* 2026-08-11/m);
});

test('a fleet that has vouched for nothing says so rather than drawing an empty page', () => {
  assert.match(renderPoolMarkdown(claimsDoc()), /This fleet has vouched for nothing yet\./);
});

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

/**
 * The companion summarises rather than transcribes: ninety days across five
 * sections is thousands of rows, and a file nobody reads defeats the one thing it
 * is for. The windows are trailing and cut on the **document's own** publish day.
 */
test('the digest companion totals the trailing windows and points at the JSON for the series', () => {
  const markdown = renderPoolMarkdown(
    digestDoc({
      byPhase: [
        row('2026-08-25', 'build', 3, 4.5),
        row('2026-08-21', 'build', 2, 3.25),
        // Outside seven days, inside thirty.
        row('2026-08-10', 'build', 10, 20),
        // Outside thirty, inside ninety.
        row('2026-07-01', 'build', 100, 200),
        row('2026-08-24', 'ci', 1, 1.5),
      ],
    }),
  );

  assert.match(markdown, /The day-by-day series is in `digest\.json` — this is the read, not the record\./);
  assert.match(markdown, /\| Phase \| Runs 7d \| Cost 7d \| Runs 30d \| Cost 30d \| Runs 90d \| Cost 90d \|/);
  assert.match(markdown, /\| Build \| 5 \| \$7\.75 \| 15 \| \$27\.75 \| 115 \| \$227\.75 \|/);
  assert.match(markdown, /\| CI \| 1 \| \$1\.50 \| 1 \| \$1\.50 \| 1 \| \$1\.50 \|/);
  // Funnel order, so the section reads as the pipeline it partitions.
  assert.ok(markdown.indexOf('| Build |') < markdown.indexOf('| CI |'), 'phases stay in funnel order');
  assert.match(markdown, /A partial day .* counts in a total and never in an average\./);
});

/**
 * `costUsd` null is a real answer — a window in which nothing was measured — and
 * `$0.00` would be a claim that the fleet worked for free. The two sections whose
 * cost is null by construction carry no cost column at all, because a column of
 * dashes is worse than no column.
 */
test('an unmeasured cost is drawn as an absence, and the countless sections carry no cost column', () => {
  const markdown = renderPoolMarkdown(
    digestDoc({
      byCheck: [row('2026-08-24', 'e2e', 2, null)],
      unaccounted: [row('2026-08-24', '', 3, null)],
      unmeasured: [row('2026-08-24', '', 4, null)],
    }),
  );

  assert.match(markdown, /\| `e2e` \| 2 \| — \| 2 \| — \| 2 \| — \|/);
  assert.match(markdown, /\| Dispatches 7d \| Dispatches 30d \| Dispatches 90d \|\n.*\n\| 3 \| 3 \| 3 \|/);
  assert.match(markdown, /\| Runs 7d \| Runs 30d \| Runs 90d \|\n.*\n\| 4 \| 4 \| 4 \|/);
  assert.doesNotMatch(markdown, /\$0\.00/);
});

test('a section with nothing in it says so rather than drawing an empty table', () => {
  const markdown = renderPoolMarkdown(digestDoc());
  assert.equal(markdown.match(/Nothing recorded in the last ninety days\./g)?.length, 6);
  assert.doesNotMatch(markdown, /\|/);
});

/**
 * A cause key is drawn in the words the local panels already use, from
 * `src/remedies/remedies.ts` — two spellings of one vocabulary is how a fleet's
 * page and its file come to disagree.
 */
test('a cause key is drawn in the operator’s words rather than as its key', () => {
  const markdown = renderPoolMarkdown(digestDoc({ byCause: [row('2026-08-24', 'ci/flake/unpreventable', 2, 0.8)] }));
  assert.match(markdown, /\| CI · /);
  assert.doesNotMatch(markdown, /ci\/flake\/unpreventable/);
});

/**
 * The faults section: what went wrong in the harness, counted per source per day.
 *
 * It carries no cost column — a fault has no dollar figure anywhere in the harness
 * — and it carries its caveat under the table, because the fault log is a list an
 * operator clears and an empty table would otherwise read as a clean quarter.
 * → `docs/spec/28-cross-fleet-pool.md#the-faults-section`
 */
test('the faults section counts by source, carries no cost column, and says what a clear costs it', () => {
  const markdown = renderPoolMarkdown(
    digestDoc({
      byFault: [
        row('2026-08-24', 'provider', 3, null),
        row('2026-08-24', 'agent', 1, null),
        row('2026-07-01', 'provider', 9, null),
      ],
    }),
  );

  assert.match(markdown, /\| Source \| Faults 7d \| Faults 30d \| Faults 90d \|/);
  // The 90-day window is the only one the July row falls in.
  assert.match(markdown, /\| provider \| 3 \| 3 \| 12 \|/);
  assert.match(markdown, /\| agent \| 1 \| 1 \| 1 \|/);
  assert.doesNotMatch(markdown, /Faults 7d \| Cost/);
  assert.match(markdown, /a quiet quarter here may be a cleared one/);
});

/** The caveat rides the empty table too — which is exactly what a cleared log looks like. */
test('an empty faults section still says a clear costs it its rows', () => {
  assert.match(renderPoolMarkdown(digestDoc()), /a quiet quarter here may be a cleared one/);
});

/** Same document in, same bytes out: the companion holds no state and reads no clock. */
test('rendering is pure', () => {
  const document = digestDoc({ byPhase: [row('2026-08-24', 'build', 1, 1)] });
  assert.equal(renderPoolMarkdown(document), renderPoolMarkdown(document));
});

// ---------------------------------------------------------------------------
// The git transport
// ---------------------------------------------------------------------------

process.env.GIT_AUTHOR_NAME ??= 'Test';
process.env.GIT_AUTHOR_EMAIL ??= 'test@example.com';
process.env.GIT_COMMITTER_NAME ??= 'Test';
process.env.GIT_COMMITTER_EMAIL ??= 'test@example.com';

/** A bare repository with `main` and one commit on it, standing in for the pool's remote. */
function poolRemote(): string {
  const bare = mkdtempSync(join(tmpdir(), 'lubbdubb-poolmd-remote-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: bare });
  const seed = gitRepo('lubbdubb-poolmd-seed-');
  execFileSync('git', ['push', '-q', bare, 'main'], { cwd: seed });
  return bare;
}

/** What the remote holds, read through a throwaway clone rather than plumbing. */
function remoteFile(remote: string, path: string): string | null {
  const reader = mkdtempSync(join(tmpdir(), 'lubbdubb-poolmd-read-'));
  execFileSync('git', ['clone', '-q', '--branch', 'main', remote, reader]);
  try {
    return readFileSync(join(reader, ...path.split('/')), 'utf8');
  } catch {
    return null;
  }
}

test('the git transport publishes the companion beside the document, under the prefix', async () => {
  const remote = poolRemote();
  const root = join(mkdtempSync(join(tmpdir(), 'lubbdubb-poolmd-root-')), 'pool');
  const transport = new GitPoolTransport({
    root,
    remote,
    branch: 'main',
    path: 'engineering/fleet-pool',
    fleetId: 'alice@acme-api',
  });

  await transport.publish(claimsDoc({ claims: [] }));

  const markdown = remoteFile(remote, 'engineering/fleet-pool/fleets/alice@acme-api/claims.md');
  assert.notEqual(remoteFile(remote, 'engineering/fleet-pool/fleets/alice@acme-api/claims.json'), null);
  assert.notEqual(markdown, null, 'the companion reached the pool too');
  assert.match(markdown ?? '', /^# acme-api — what this fleet has vouched for/);
  assert.equal(poolMarkdownPath('alice@acme-api', 'claims'), 'fleets/alice@acme-api/claims.md');
});

/**
 * **The companion is never read back.** `fetch` names the `.json` by name, so a
 * markdown file — this fleet's own, another fleet's, or one a person wrote by hand
 * in a wiki the pool shares — is not a document. A fetch that walked the directory
 * would try to parse it and record an error for it every pulse.
 */
test('fetch reads the documents and never their companions', async () => {
  const remote = poolRemote();
  const root = join(mkdtempSync(join(tmpdir(), 'lubbdubb-poolmd-fetch-')), 'pool');
  const transport = new GitPoolTransport({ root, remote, branch: 'main', path: '', fleetId: 'alice@acme-api' });

  await transport.publish(claimsDoc());
  await transport.publish(digestDoc());
  // A hand-written file in the same directory, as a shared wiki would have.
  const notes = join(root, 'fleets', 'bob@acme-api');
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, 'claims.md'), '# notes somebody wrote\n', 'utf8');

  const fetched = await transport.fetch();

  assert.equal(fetched.length, 2, 'the two documents, and neither companion');
  for (const entry of fetched) assert.ok(entry.text.trimStart().startsWith('{'), 'every fetched document is JSON');
});

test('a re-publish of unchanged content commits nothing, companion included', async () => {
  const remote = poolRemote();
  const root = join(mkdtempSync(join(tmpdir(), 'lubbdubb-poolmd-idle-')), 'pool');
  const transport = new GitPoolTransport({ root, remote, branch: 'main', path: '', fleetId: 'alice@acme-api' });

  await transport.publish(claimsDoc());
  const before = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  await transport.publish(claimsDoc());
  const after = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  assert.equal(after, before, 'identical bytes are not a commit');
  assert.equal(
    execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    '',
    'and nothing is left staged or dirty',
  );
});
