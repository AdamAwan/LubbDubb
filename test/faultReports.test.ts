import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystem } from '../src/system/system.js';
import { loadConfig } from '../src/config/config.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeUpstreamIssues } from '../src/tickets/fakeUpstream.js';
import { composeFaultReports, findLeak, leakTerms } from '../src/faultReports/compose.js';
import { harnessFrames, scrubText } from '../src/faultReports/scrub.js';
import type { ErrorLogEntry } from '../src/types.js';
import type { FaultReports } from '../src/wire.js';

const VOCAB = new Set(
  [
    'filing',
    'an',
    'issue',
    'failed',
    'spawn',
    'for',
    'agent',
    'in',
    'the',
    'cycle',
    'harness',
    'run',
    'Cycle',
    'json',
    'plan',
    'is',
    'invalid',
  ]
    .map((w) => w.toLowerCase())
    .concat(['src', 'ts', 'harness', 'runcycle']),
);
const ROOT = '/opt/lubbdubb';
const NEW_ISSUE = 'https://github.com/AdamAwan/LubbDubb/issues/new';

function entry(
  message: string,
  detail: string | null = null,
  source: ErrorLogEntry['source'] = 'cycle',
): ErrorLogEntry {
  return { id: `err_${message.length}`, source, message, detail, createdAt: '2026-11-18T00:00:00.000Z' };
}

const CTX = {
  root: ROOT,
  vocabulary: VOCAB,
  leaks: leakTerms(['acme', 'widgets', '/home/adam/acme-widgets', 'adam-laptop'], VOCAB),
  build: '0.1.0',
  runtime: 'node 22 · linux',
  now: '2026-11-19T00:00:00.000Z',
};

test('a word survives scrubbing only if LubbDubb’s own source contains it', () => {
  assert.equal(
    scrubText("filing an issue failed for 'acme/widgets' at https://acme.io/x in /home/adam/acme #42", VOCAB),
    'filing an issue failed for ‹…› in ‹path› #‹n›',
  );
  assert.equal(scrubText('spawn failed for acmeCorp', VOCAB), 'spawn failed for ‹…›', 'an unknown word is dropped');
  assert.equal(scrubText('plan.json is invalid', VOCAB), 'plan.json is invalid', 'a dotted name of known words stays');
});

test('only frames inside LubbDubb’s own tree are kept, as repo-relative paths', () => {
  const detail = [
    'TypeError: cannot read acme',
    `    at Harness.runCycle (${ROOT}/src/harness.ts:12:5)`,
    '    at acmeHelper (/home/adam/acme-widgets/src/x.ts:1:1)',
    `    at file://${ROOT}/node_modules/x/index.js:3:3`,
    '    at node:internal/process:1:1',
  ].join('\n');
  assert.deepEqual(harnessFrames(detail, ROOT, VOCAB), [{ file: 'src/harness.ts', line: 12, fn: 'Harness.runCycle' }]);
});

test('identical faults group, and nothing of the instance reaches the report', () => {
  const reports = composeFaultReports(
    [
      entry('filing an issue failed for acme/widgets'),
      entry('filing an issue failed for acme/other'),
      entry('spawn failed for agent in /home/adam/acme-widgets', null, 'agent'),
    ],
    CTX,
  );
  assert.equal(reports.length, 2);
  assert.equal(reports[0]!.count, 2);
  for (const r of reports) {
    assert.equal(r.withheld, null);
    assert.doesNotMatch(`${r.title}\n${r.body}\n${r.issueUrl?.slice(NEW_ISSUE.length)}`, /acme|widgets|adam/i);
    assert.ok(r.issueUrl?.startsWith(NEW_ISSUE));
  }
});

test('a report that still names the instance is withheld, not sent', () => {
  assert.deepEqual(leakTerms(['plan-secretproject'], VOCAB), ['secretproject'], 'a word of LubbDubb’s own is no leak');
  assert.equal(findLeak('a secretproject fault', ['secretproject']), 'secretproject');
  const [report] = composeFaultReports([entry('filing failed')], {
    ...CTX,
    build: '0.1.0+acme',
  });
  assert.ok(report);
  assert.equal(report.body, '');
  assert.equal(report.issueUrl, null);
  assert.notEqual(report.withheld, null);
});

test('GET /api/errors/reports scrubs the fault log of this install', async () => {
  const config = loadConfig({
    auth: { enabled: false } as never,
    dbPath: ':memory:',
    labelPrefix: 'zqxprefix',
    agentMode: 'raw',
    heartbeatIntervalMs: 999_999,
    startPaused: true,
  });
  const system = buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
    upstream: new FakeUpstreamIssues(),
  });
  system.errors.record({ source: 'provider', message: 'the zqxprefix-label sweep failed for zqxcorp/zqxrepo' });
  const { app } = await buildApp(system);
  try {
    const res = await app.inject({ method: 'GET', url: '/api/errors/reports' });
    assert.equal(res.statusCode, 200);
    const body = res.json<FaultReports>();
    assert.equal(body.unavailable, null);
    assert.equal(body.reports.length, 1);
    assert.doesNotMatch(JSON.stringify(body), /zqx/);
  } finally {
    await app.close();
    system.store.close();
  }
});
