import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeEnvironmentObserver, watchRow } from '../src/environments/fakeObserver.js';
import { WatchDryRun } from '../src/environments/watchDryRun.js';
import { type EnvironmentConfig } from '../src/environments/policy.js';
import { WatchCheckSchema, WatchSchema, watchCheckInput } from '../src/validation/watchDocument.js';

const TEST_UK: EnvironmentConfig = {
  name: 'testUk',
  at: 'echo unused',
  watch: { observe: './scripts/telemetry.sh testUk' },
};

const SIGNAL = {
  id: 'no-timeouts',
  title: 'Job X stops timing out',
  query: "traces | where message has 'job X timed out'",
  presence: "traces | where operation_Name == 'job X'",
  tolerate: 0,
};

function build(observer: FakeEnvironmentObserver): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-watch-agg-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    environments: [TEST_UK],
  });
  return buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    environmentObserver: observer,
    errorMirror: () => {},
  });
}

function refusal(query: string, presence = SIGNAL.presence): string {
  const parsed = WatchSchema.safeParse({ signals: [{ ...SIGNAL, query, presence }] });
  assert.equal(parsed.success, false, `an aggregating query was accepted: ${query}`);
  return parsed.error!.issues.map((issue) => issue.message).join(' ');
}

test('an aggregating signal query is refused at ingestion, and the refusal says what to write instead', () => {
  const message = refusal("traces | where message has 'job X timed out' | count");
  assert.match(message, /one row carrying the count/);
  assert.match(message, /tolerate/, 'the refusal names the field that does the counting');
  assert.match(message, /Drop the "\| count"/);

  refusal("traces | where message has 'x' | summarize count()");
  refusal("traces | where message has 'x' | summarize value = count()");
  refusal("traces | where message has 'x' | make-series c = count() on t step 1h");
  refusal("select count(*) from traces where message like '%x%'");
});

test('an aggregating presence query is refused too — a count can never answer zero', () => {
  const message = refusal(SIGNAL.query, "traces | where operation_Name == 'job X' | count");
  assert.match(message, /can never answer zero/);
});

test('a query that aggregates by a key still answers one row per group, and is accepted', () => {
  assert.equal(
    WatchSchema.safeParse({
      signals: [{ ...SIGNAL, query: "traces | where message has 'x' | summarize n = count() by role" }],
    }).success,
    true,
  );
  assert.equal(WatchSchema.safeParse({ signals: [SIGNAL] }).success, true);
});

test('a measure is meant to aggregate and is left alone', () => {
  assert.equal(
    WatchSchema.safeParse({
      measures: [
        {
          id: 'orders-p95',
          title: 'p95',
          query: 'requests | summarize value = percentile(duration, 95)',
          expect: { noWorseThan: 'baseline' },
        },
      ],
    }).success,
    true,
  );
});

test("the operator's own edit is held to the same rule, through the same one", () => {
  const parsed = WatchCheckSchema.safeParse({ ...SIGNAL, kind: 'signal', query: `${SIGNAL.query} | count` });
  assert.equal(parsed.success, false);
  assert.equal(WatchCheckSchema.safeParse({ ...SIGNAL, kind: 'signal' }).success, true);
});

test('the fake observer answers an aggregating query as an engine does — one row, whatever was scripted', async () => {
  const observer = new FakeEnvironmentObserver({
    'no-timeouts:presence': JSON.stringify([watchRow('no-timeouts', { runs: 96 })]),
    'no-timeouts:signal': '[]',
  });
  const system = build(observer);
  const aggregating = { ...SIGNAL, query: `${SIGNAL.query} | count` };
  system.store.watches.ingestGoalWatch('issue:12', [watchCheckInput({ ...aggregating, kind: 'signal' }, 1)]);

  const refusals = await new WatchDryRun({
    store: system.store,
    environments: [TEST_UK],
    observer,
  }).run('issue:12');

  const check = system.store.watches.listGoalWatches()[0]!;
  assert.equal(check.dryRunRows, 1, 'nothing matched, and the aggregate still answered one row');
  assert.equal(refusals.length, 1, 'the dry run notices the scalar shape rather than reading it as one occurrence');
  assert.match(refusals[0]!, /one row carrying one number/);
  system.store.close();
});

test('a signal answering rows is untouched by any of it', async () => {
  const observer = new FakeEnvironmentObserver({
    'no-timeouts:presence': JSON.stringify([watchRow('no-timeouts', { runs: 96 })]),
    'no-timeouts:signal': JSON.stringify([watchRow('no-timeouts', { role: 'worker', message: 'timed out' })]),
  });
  const system = build(observer);
  system.store.watches.ingestGoalWatch('issue:12', [watchCheckInput({ ...SIGNAL, kind: 'signal' }, 1)]);
  const refusals = await new WatchDryRun({ store: system.store, environments: [TEST_UK], observer }).run('issue:12');
  assert.deepEqual(refusals, []);
  assert.equal(system.store.watches.listGoalWatches()[0]!.dryRunRows, 1);
  system.store.close();
});
