import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitPoolTransport } from '../src/integrations/pool/gitPool.js';
import { POOL_SCHEMA_VERSION } from '../src/pool/document.js';
import { poolMarkdownPath, renderPoolMarkdown } from '../src/pool/markdown.js';
import type { PoolDigestDocument, PoolDigestRow } from '../src/types.js';
import { gitRepo } from './support/gitRepo.js';

const NOW = '2026-08-25T09:14:02.481Z';

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
    byUsage: [],
    byThroughput: [],
    byFault: [],
    ...over,
  };
}

function row(day: string, key: string, count: number, costUsd: number | null): PoolDigestRow {
  return { day, key, count, costUsd, partial: day === '2026-08-25' };
}

test('the digest companion totals the trailing windows and points at the JSON for the series', () => {
  const markdown = renderPoolMarkdown(
    digestDoc({
      byPhase: [
        row('2026-08-25', 'build', 3, 4.5),
        row('2026-08-21', 'build', 2, 3.25),
        row('2026-08-10', 'build', 10, 20),
        row('2026-07-01', 'build', 100, 200),
        row('2026-08-24', 'ci', 1, 1.5),
      ],
    }),
  );

  assert.match(markdown, /The day-by-day series is in `digest\.json` — this is the read, not the record\./);
  assert.match(markdown, /\| Phase \| Runs 7d \| Cost 7d \| Runs 30d \| Cost 30d \| Runs 90d \| Cost 90d \|/);
  assert.match(markdown, /\| Build \| 5 \| \$7\.75 \| 15 \| \$27\.75 \| 115 \| \$227\.75 \|/);
  assert.match(markdown, /\| CI \| 1 \| \$1\.50 \| 1 \| \$1\.50 \| 1 \| \$1\.50 \|/);
  assert.ok(markdown.indexOf('| Build |') < markdown.indexOf('| CI |'), 'phases stay in funnel order');
  assert.match(markdown, /A partial day .* counts in a total and never in an average\./);
});

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
  assert.equal(markdown.match(/Nothing recorded in the last ninety days\./g)?.length, 8);
  assert.doesNotMatch(markdown, /\|/);
});

test('a cause key is drawn in the operator’s words rather than as its key', () => {
  const markdown = renderPoolMarkdown(digestDoc({ byCause: [row('2026-08-24', 'ci/flake/unpreventable', 2, 0.8)] }));
  assert.match(markdown, /\| CI · /);
  assert.doesNotMatch(markdown, /ci\/flake\/unpreventable/);
});

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
  assert.match(markdown, /\| provider \| 3 \| 3 \| 12 \|/);
  assert.match(markdown, /\| agent \| 1 \| 1 \| 1 \|/);
  assert.doesNotMatch(markdown, /Faults 7d \| Cost/);
  assert.match(markdown, /a quiet quarter here may be a cleared one/);
});

test('an empty faults section still says a clear costs it its rows', () => {
  assert.match(renderPoolMarkdown(digestDoc()), /a quiet quarter here may be a cleared one/);
});

test('rendering is pure', () => {
  const document = digestDoc({ byPhase: [row('2026-08-24', 'build', 1, 1)] });
  assert.equal(renderPoolMarkdown(document), renderPoolMarkdown(document));
});

process.env.GIT_AUTHOR_NAME ??= 'Test';
process.env.GIT_AUTHOR_EMAIL ??= 'test@example.com';
process.env.GIT_COMMITTER_NAME ??= 'Test';
process.env.GIT_COMMITTER_EMAIL ??= 'test@example.com';

function poolRemote(): string {
  const bare = mkdtempSync(join(tmpdir(), 'lubbdubb-poolmd-remote-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: bare });
  const seed = gitRepo('lubbdubb-poolmd-seed-');
  execFileSync('git', ['push', '-q', bare, 'main'], { cwd: seed });
  return bare;
}

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

  await transport.publish(digestDoc());

  const markdown = remoteFile(remote, 'engineering/fleet-pool/fleets/alice@acme-api/digest.md');
  assert.notEqual(remoteFile(remote, 'engineering/fleet-pool/fleets/alice@acme-api/digest.json'), null);
  assert.notEqual(markdown, null, 'the companion reached the pool too');
  assert.match(markdown ?? '', /^# acme-api — daily digest/);
  assert.equal(poolMarkdownPath('alice@acme-api', 'digest'), 'fleets/alice@acme-api/digest.md');
});

test('fetch reads the documents and never their companions', async () => {
  const remote = poolRemote();
  const root = join(mkdtempSync(join(tmpdir(), 'lubbdubb-poolmd-fetch-')), 'pool');
  const transport = new GitPoolTransport({ root, remote, branch: 'main', path: '', fleetId: 'alice@acme-api' });

  await transport.publish(digestDoc());
  const notes = join(root, 'fleets', 'bob@acme-api');
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, 'digest.md'), '# notes somebody wrote\n', 'utf8');

  const fetched = await transport.fetch();

  assert.equal(fetched.length, 1, 'the one document, and neither companion');
  for (const entry of fetched) assert.ok(entry.text.trimStart().startsWith('{'), 'every fetched document is JSON');
});

test('a re-publish of unchanged content commits nothing, companion included', async () => {
  const remote = poolRemote();
  const root = join(mkdtempSync(join(tmpdir(), 'lubbdubb-poolmd-idle-')), 'pool');
  const transport = new GitPoolTransport({ root, remote, branch: 'main', path: '', fleetId: 'alice@acme-api' });

  await transport.publish(digestDoc());
  const before = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  await transport.publish(digestDoc());
  const after = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  assert.equal(after, before, 'identical bytes are not a commit');
  assert.equal(
    execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    '',
    'and nothing is left staged or dirty',
  );
});
