import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeAppErrorDetailRunner, FakeAppErrorReader } from '../src/appErrors/fakeReader.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { parseAppErrorReport } from '../src/appErrors/report.js';
import {
  capDetailOutput,
  CommandAppErrorDetailRunner,
  detailRequest,
  MAX_DETAIL_OUTPUT_CHARS,
} from '../src/appErrors/detailCommand.js';
import { MAX_LOOKBACK_MS } from '../src/appErrors/groups.js';
import { triageBriefing } from '../src/appErrors/triage.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { AppErrorsPayload, AppErrorGroupView } from '../src/wire.js';

// → docs/spec/39-app-errors.md#the-output-contract, docs/spec/39-app-errors.md#the-detail-query

const ROW = {
  fingerprint: 'Orders.Submit',
  title: 'NullReferenceException in OrderService.Submit',
  count: 4,
  firstSeen: '2026-10-19T10:00:00Z',
  lastSeen: '2026-10-19T11:00:00Z',
};

test('the object form carries the query and its link beside the groups; the list form is unchanged', () => {
  const list = parseAppErrorReport(JSON.stringify([ROW]));
  assert.equal(list.status, 'ok');
  if (list.status === 'ok') assert.deepEqual([list.query, list.queryLink, list.rows.length], [null, null, 1]);

  const object = parseAppErrorReport(
    JSON.stringify({ query: '  exceptions | take 10  ', queryLink: 'https://portal.azure.com/#q', groups: [ROW] }),
  );
  assert.equal(object.status, 'ok');
  if (object.status !== 'ok') return;
  assert.equal(object.query, 'exceptions | take 10');
  assert.equal(object.queryLink, 'https://portal.azure.com/#q');
  assert.equal(object.rows[0]?.fingerprint, 'Orders.Submit');
  assert.deepEqual(object.refused, []);

  const bare = parseAppErrorReport(JSON.stringify({ groups: [] }));
  assert.ok(bare.status === 'ok' && bare.rows.length === 0 && bare.query === null, 'no query is not a refusal');

  const long = parseAppErrorReport(JSON.stringify({ query: 'x'.repeat(9_000), groups: [] }));
  assert.equal(long.status === 'ok' ? long.query?.length : -1, 8_000, 'the query is capped');
});

test('a bad query or query link is refused by name and the reading still stands', () => {
  const report = parseAppErrorReport(
    JSON.stringify({ query: 42, queryLink: 'javascript:alert(1)', groups: [ROW, { fingerprint: '' }] }),
  );
  assert.equal(report.status, 'ok');
  if (report.status !== 'ok') return;
  assert.equal(report.rows.length, 1);
  assert.equal(report.query, null);
  assert.equal(report.queryLink, null);
  assert.equal(report.refused.length, 3);
  assert.match(report.refused[0]!, /^row 1:/, 'row refusals come first');
  assert.ok(report.refused.some((r) => /"query" must be a string/.test(r)));
  assert.ok(report.refused.some((r) => /"queryLink" must be an absolute http\(s\) URL/.test(r)));

  const relative = parseAppErrorReport(JSON.stringify({ queryLink: '/logs', groups: [] }));
  assert.ok(relative.status === 'ok' && relative.queryLink === null && relative.refused.length === 1);
});

test('an object without a list of groups is unknown, never no errors', () => {
  for (const stdout of ['{}', '{"groups": {}}', '{"query": "q"}', '"text"', '42']) {
    assert.equal(parseAppErrorReport(stdout).status, 'unknown', stdout);
  }
  const refusedAll = parseAppErrorReport(JSON.stringify({ queryLink: 'nope', groups: [{}] }));
  assert.ok(refusedAll.status === 'unknown' && /^every row .* — row 0:/.test(refusedAll.detail));
});

test('errors.detail is refused empty, and refused with a {fingerprint} placeholder', () => {
  const env = (detail: unknown) => ({
    environments: [{ name: 'live', at: 'x', errors: { list: './e.sh {since}', detail } }],
  });
  assert.throws(() => loadConfig(env(' ') as never), /"errors.detail" must be a non-empty command/);
  assert.throws(() => loadConfig(env(7) as never), /"errors.detail" must be a non-empty command/);
  assert.throws(
    () => loadConfig(env('./detail.sh live {fingerprint}') as never),
    /carries \{fingerprint\}.*LUBBDUBB_ERROR_FINGERPRINT/s,
  );
  assert.doesNotThrow(() => loadConfig(env('./detail.sh live') as never));
});

test('the detail query reaches back to the group’s first sighting, never past fourteen days, and is capped', () => {
  const now = Date.parse('2026-11-14T12:00:00.000Z');
  const recent = detailRequest({
    environment: 'live',
    detail: './d.sh live {since}',
    fingerprint: "x'; rm -rf / #",
    firstSeen: '2026-11-13T00:00:00.000Z',
    now,
  });
  assert.equal(recent.since, '2026-11-13T00:00:00.000Z');
  assert.equal(recent.command, './d.sh live 2026-11-13T00:00:00.000Z', 'the fingerprint is never in the text');
  const old = detailRequest({ environment: 'live', detail: './d.sh', fingerprint: 'f', firstSeen: '2026-01-01', now });
  assert.equal(old.since, new Date(now - MAX_LOOKBACK_MS).toISOString());

  const capped = capDetailOutput('y'.repeat(MAX_DETAIL_OUTPUT_CHARS + 10));
  assert.ok(capped.ok && capped.truncated && capped.text.length === MAX_DETAIL_OUTPUT_CHARS);
  assert.deepEqual(capDetailOutput(' fine \n'), { ok: true, text: 'fine', truncated: false });
  assert.equal(capDetailOutput('  ').ok, false, 'silence is not an answer');
});

test('a detail query that prints past its buffer is stopped there and answers its prefix, truncated', async () => {
  const runner = new CommandAppErrorDetailRunner(process.cwd(), 10_000);
  const request = (command: string) => ({
    environment: 'live',
    command,
    fingerprint: 'f',
    since: '2026-11-01T00:00:00.000Z',
  });
  const flood = await runner.detail(request(`node -e "process.stdout.write('z'.repeat(1_000_000))"`));
  assert.ok(flood.ok && flood.truncated && flood.text === 'z'.repeat(MAX_DETAIL_OUTPUT_CHARS));
  const failed = await runner.detail(request(`node -e "console.error('az login required'); process.exit(1)"`));
  assert.deepEqual(failed, { ok: false, failure: 'the detail query exited 1: az login required' });
});

test('the briefing carries each environment’s query and link, and each group’s telemetry link', () => {
  const group = {
    environment: 'live',
    fingerprint: 'fp',
    title: 'Boom',
    operation: null,
    version: null,
    frames: [],
    hasDetail: false,
    url: 'https://portal.azure.com/group',
    firstSeen: '2026-11-01T00:00:00.000Z',
    lastSeen: '2026-11-01T00:00:00.000Z',
    returnedAt: null,
    daily: [],
    key: 'err:shop:aaaa1111',
    state: 'new',
    count: 3,
    ignored: false,
    spike: null,
    link: null,
    tracker: null,
    triage: null,
  } satisfies AppErrorGroupView;
  const brief = triageBriefing([{ group, anchor: group.firstSeen, candidates: [] }], {
    readings: [
      {
        environment: 'live',
        status: 'ok',
        detail: null,
        readAt: '',
        okAt: '',
        query: 'exceptions | where x == "```"',
        queryLink: 'https://portal.azure.com/query',
      },
      { environment: 'other', status: 'ok', detail: null, readAt: '', okAt: '', query: 'unrelated', queryLink: null },
    ],
    detailQueries: new Set(['live']),
  });
  assert.match(brief, /In the telemetry: https:\/\/portal\.azure\.com\/group/);
  assert.match(brief, /## How these errors were found/);
  assert.match(brief, /Open it in the telemetry: https:\/\/portal\.azure\.com\/query/);
  assert.match(brief, /````\nexceptions \| where x == "```"\n````/, 'the fence outruns any backticks in the query');
  assert.ok(!brief.includes('unrelated'), 'only the environments of the run’s groups');
  assert.match(brief, /Detail query: declared on live/);
});

const ENVIRONMENTS: EnvironmentConfig[] = [
  { name: 'live', at: 'unused', errors: { list: './errors.sh live {since}', detail: './detail.sh live {since}' } },
];

function build(reader: FakeAppErrorReader, details: FakeAppErrorDetailRunner, backend = new FakePtyBackend()): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-errq-'));
  return buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      environments: ENVIRONMENTS,
      environmentProbeIntervalMs: 0,
      pool: { project: 'shop' },
      appErrorIntervalMs: 0,
      appErrorTriagePerDay: 0,
    }),
    {
      backend,
      worktrees: new FakeWorktreeManager(),
      environmentProber: new FakeEnvironmentProber({ live: ['f'.repeat(40)] }),
      appErrorReader: reader,
      appErrorDetailRunner: details,
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
    },
  );
}

async function payload(system: System): Promise<AppErrorsPayload> {
  const { app } = await buildApp(system);
  try {
    return (await app.inject({ method: 'GET', url: '/api/app-errors' })).json<AppErrorsPayload>();
  } finally {
    await app.close();
  }
}

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const HOUR = 3_600_000;

test('the query a reading ran rides the wire, and an unknown read keeps the last answered one', async () => {
  const reader = new FakeAppErrorReader({
    live: JSON.stringify({
      query: 'exceptions | summarize count() by problemId',
      queryLink: 'https://portal.azure.com/#logs',
      groups: [{ ...ROW, firstSeen: ago(2 * HOUR), lastSeen: ago(HOUR) }],
    }),
  });
  const system = build(reader, new FakeAppErrorDetailRunner());
  try {
    await system.harness.runCycle();
    const read = (await payload(system)).environments[0]!.reading;
    assert.equal(read?.query, 'exceptions | summarize count() by problemId');
    assert.equal(read?.queryLink, 'https://portal.azure.com/#logs');

    reader.script('live', 'not json');
    await system.harness.runCycle();
    const failed = (await payload(system)).environments[0]!.reading;
    assert.equal(failed?.status, 'unknown');
    assert.equal(failed?.queryLink, 'https://portal.azure.com/#logs', 'the last answered read’s query stands');

    reader.script('live', '[]');
    await system.harness.runCycle();
    const plain = (await payload(system)).environments[0]!.reading;
    assert.deepEqual([plain?.query, plain?.queryLink], [null, null], 'an answered read with no query clears it');
  } finally {
    system.store.close();
  }
});

test('app_error_detail runs the environment’s detail query through the seam, fingerprint in the env only', async () => {
  const reader = new FakeAppErrorReader({
    live: JSON.stringify([{ ...ROW, count: 9, firstSeen: ago(3 * HOUR), lastSeen: ago(HOUR), message: 'stored' }]),
  });
  const details = new FakeAppErrorDetailRunner({ live: 'occurrence 1: timeout\noccurrence 2: timeout' });
  const backend = new FakePtyBackend();
  const system = build(reader, details, backend);
  try {
    await system.harness.runCycle();
    const pressed = await system.appErrorTriage.request('live', 'Orders.Submit');
    assert.ok(pressed.ok);
    assert.match(system.store.appErrorTriage.pendingRun()!.briefing, /Detail query: declared on live/);
    await system.harness.runCycle('manual');
    const task = system.store.tasks.listTasks().find((t) => t.rule === 'app-error-triage')!;
    const agentId = system.store.tasks.getTask(task.id)!.agentId!;
    const key = pressed.run.subjects[0]!.key;

    const read = await system.agents.readAppErrorDetail(agentId, key);
    assert.ok(read.ok);
    assert.equal(read.message, 'stored');
    assert.deepEqual(read.query, { ok: true, text: 'occurrence 1: timeout\noccurrence 2: timeout', truncated: false });
    assert.equal(details.asked.length, 1);
    const asked = details.asked[0]!;
    assert.equal(asked.environment, 'live');
    assert.equal(asked.fingerprint, 'Orders.Submit');
    assert.ok(!asked.command.includes('Orders.Submit'), 'the fingerprint is never put into the command text');
    assert.equal(asked.command, `./detail.sh live ${asked.since}`);
    const firstSeen = (await payload(system)).environments[0]!.groups[0]!.firstSeen;
    assert.equal(asked.since, firstSeen, 'bounded by the group’s first sighting');

    let triage = (await payload(system)).environments[0]!.groups[0]!.triage;
    assert.ok(triage?.detailReadAt);
    assert.equal(triage?.detailQuery?.ok, true, 'the row says the agent ran the detail query');

    details.script('live', { ok: false, failure: 'the detail query exited 1: az login required' });
    const failed = await system.agents.readAppErrorDetail(agentId, key);
    assert.ok(failed.ok && failed.query !== null && !failed.query.ok);
    assert.match(failed.query.ok ? '' : failed.query.failure, /az login required/);
    assert.ok(
      system.store.errors.listErrors().some((e) => e.message.includes('errors.detail query for live failed')),
      'a failed query is recorded',
    );
    triage = (await payload(system)).environments[0]!.groups[0]!.triage;
    assert.equal(triage?.detailQuery?.ok, false);
  } finally {
    system.store.close();
  }
});
