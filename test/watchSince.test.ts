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
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { preparedQuery } from '../src/environments/watchResult.js';
import { WatchCheckSchema, WatchSchema } from '../src/validation/watchDocument.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { GoalWatchInput } from '../src/types.js';

/**
 * The time bound. A watch query with none answers about the whole retention
 * period, which contains the very occurrences the work was for — so the check
 * reports the defect it fixed, for ever, and the numbers are right.
 * → docs/spec/29-post-deploy-watch.md#every-query-carries-since
 */

const TEST_UK: EnvironmentConfig = {
  name: 'testUk',
  at: 'echo unused',
  watch: { observe: './scripts/telemetry.sh testUk' },
};

const BOUND = "traces | where timestamp > datetime({since}) | where message has 'job X timed out'";

const SIGNAL: GoalWatchInput = {
  id: 'no-timeouts',
  seq: 1,
  kind: 'signal',
  title: 'Job X stops timing out',
  query: BOUND,
  presence: "traces | where timestamp > datetime({since}) | where operation_Name == 'job X'",
  tolerate: 0,
  expectUnder: null,
  expectOver: null,
  expectBaseline: false,
  unit: null,
  why: null,
};

const FIRING = {
  'no-timeouts:presence': JSON.stringify([watchRow('no-timeouts', { runs: 96 })]),
  'no-timeouts:signal': JSON.stringify([watchRow('no-timeouts', { role: 'worker' })]),
};

function build(observer: FakeEnvironmentObserver, environments: EnvironmentConfig[] = [TEST_UK]): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-watch-since-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    environmentProbeIntervalMs: 5 * 60 * 1000,
    environments,
  });
  return buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    environmentObserver: observer,
    environmentProber: new FakeEnvironmentProber(),
    gitObserver: new FakeGitObserver(),
    errorMirror: () => {},
  });
}

function arrived(system: System, checks: GoalWatchInput[] = [SIGNAL]): void {
  system.store.ingestGoalWatch('issue:12', checks);
  system.store.recordGoalArrival({
    goalRef: 'issue:12',
    environment: 'testUk',
    arrivedAt: new Date(Date.now() - 60_000).toISOString(),
  });
}

test('a window’s reading is bounded to the arrival that opened it', async () => {
  const observer = new FakeEnvironmentObserver(FIRING);
  const system = build(observer);
  arrived(system);

  await system.harness.runCycle();

  const [window] = system.store.listWatchWindows();
  assert.ok(window !== undefined);
  assert.deepEqual(
    [...new Set(observer.asked.map((a) => a.since))],
    [window.openedAt],
    'the instant the work arrived, and not the instant the pass ran',
  );
  const put = preparedQuery(SIGNAL.query, window.openedAt, SIGNAL.id, 'signal');
  assert.ok(put.query?.includes(`datetime(${window.openedAt})`), 'substituted before it reaches a shell');
  assert.ok(!put.query?.includes('{since}'));
  system.store.close();
});

test('a query nothing bounds is unknown, never the regression it would otherwise report', async () => {
  const observer = new FakeEnvironmentObserver(FIRING);
  const system = build(observer);
  arrived(system, [
    {
      ...SIGNAL,
      query: "traces | where message has 'job X timed out'",
      presence: "traces | where operation_Name == 'job X'",
    },
  ]);

  await system.harness.runCycle();

  const [reading] = system.store.listWatchReadings();
  assert.equal(reading?.verdict, 'unknown', 'not regressed — the rows it counted are from before the work');
  assert.match(reading!.detail!, /\{since\}/, 'and it says what is missing');
  assert.deepEqual(system.store.listHumanTasksOfKind('watch'), [], 'an unknown files nothing');
  system.store.close();
});

test('a dry run reads one window’s length back, which is the span the baseline is taken over', async () => {
  const observer = new FakeEnvironmentObserver(FIRING);
  const system = build(observer, [{ ...TEST_UK, watch: { ...TEST_UK.watch!, forMs: 60 * 60 * 1000 } }]);
  system.store.ingestGoalWatch('issue:12', [SIGNAL]);

  await system.watch.run('issue:12');

  const since = observer.asked[0]?.since;
  assert.ok(since !== undefined, 'the dry run put the query to an environment');
  const back = Date.now() - Date.parse(since);
  assert.ok(back > 59 * 60 * 1000 && back < 61 * 60 * 1000, `an hour back, not ${String(back)}ms`);
  system.store.close();
});

test('a declaration carrying no time bound is refused at ingestion, on every query of every kind', () => {
  const signal = {
    id: 'no-timeouts',
    title: 'Job X stops timing out',
    query: "traces | where message has 'job X timed out'",
    presence: "traces | where operation_Name == 'job X'",
  };
  const refusals = WatchSchema.safeParse({ signals: [signal] });
  assert.equal(refusals.success, false);
  const messages = refusals.error!.issues.map((i) => i.message);
  assert.equal(messages.length, 2, 'the query and the presence query are each refused on their own terms');
  assert.match(messages[0]!, /carries no "\{since\}"/);
  assert.match(messages[1]!, /running now/, 'and a presence query is told why its own bound matters');

  const measure = WatchSchema.safeParse({
    measures: [
      {
        id: 'orders-p95',
        title: 'No slower than it was',
        query: 'requests | summarize value = percentile(duration, 95)',
        expect: { noWorseThan: 'baseline' },
      },
    ],
  });
  assert.equal(measure.success, false, 'a measure is not exempt: the number would be about the period before');

  const operator = WatchCheckSchema.safeParse({ ...signal, kind: 'signal', tolerate: 0 });
  assert.equal(operator.success, false, 'and the operator’s own edit is held to it, through the same rule');

  assert.equal(WatchSchema.safeParse({ signals: [{ ...signal, query: BOUND, presence: BOUND }] }).success, true);
});
