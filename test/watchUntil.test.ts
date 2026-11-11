import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeEnvironmentObserver, watchRow } from '../src/environments/fakeObserver.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { CommandEnvironmentObserver } from '../src/environments/observer.js';
import { preparedQuery, WATCH_ID_COLUMN } from '../src/environments/watchResult.js';
import { goalMergedAt, unrecordedLandings } from '../src/environments/landings.js';
import { WatchCheckSchema, WatchSchema } from '../src/validation/watchDocument.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { GoalLanding, GoalWatchInput, WorldSnapshot } from '../src/types.js';

/**
 * `{until}`, and the baseline that ends at the merge. A baseline read over the
 * window before *now*, taken once the change has deployed, is the change compared
 * with itself — so the dry run reads the window that ends where the goal merged.
 * → docs/spec/29-post-deploy-watch.md#until-and-the-baseline-that-ends-at-the-merge
 */

const HOUR = 60 * 60 * 1000;

const TEST_UK: EnvironmentConfig = {
  name: 'testUk',
  at: 'echo unused',
  watch: { observe: './scripts/telemetry.sh testUk', forMs: HOUR },
};

const BOUNDED =
  'requests | where timestamp > datetime({since}) and timestamp <= datetime({until}) | summarize value = avg(duration)';
const OPEN_ENDED = 'requests | where timestamp > datetime({since}) | summarize value = avg(duration)';

function measure(query: string): GoalWatchInput {
  return {
    id: 'orders-p95',
    seq: 1,
    kind: 'measure',
    title: 'No slower than it was',
    query,
    presence: null,
    tolerate: 0,
    expectUnder: null,
    expectOver: null,
    expectBaseline: true,
    unit: 'ms',
    why: null,
  };
}

const ANSWERS = { 'orders-p95:measure': JSON.stringify([watchRow('orders-p95', { value: 8400 })]) };

function build(observer: FakeEnvironmentObserver): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-watch-until-'));
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
    environmentProber: new FakeEnvironmentProber(),
    gitObserver: new FakeGitObserver(),
    errorMirror: () => {},
  });
}

test('a measure carrying no {until} is refused at ingestion, by every writer; a signal is not', () => {
  const declared = { id: 'orders-p95', title: 'No slower', query: OPEN_ENDED, expect: { noWorseThan: 'baseline' } };
  const document = WatchSchema.safeParse({ measures: [declared] });
  assert.equal(document.success, false, 'the plan document and watch_declare both parse through WatchSchema');
  assert.match(document.error!.issues[0]!.message, /carries no "\{until\}"/);

  const operator = WatchCheckSchema.safeParse({ ...declared, kind: 'measure' });
  assert.equal(operator.success, false, 'and the operator’s own edit, through the same rule');

  assert.equal(WatchSchema.safeParse({ measures: [{ ...declared, query: BOUNDED }] }).success, true);
  const signal = {
    id: 'no-timeouts',
    title: 'Job X stops timing out',
    query: "traces | where timestamp > datetime({since}) | where message has 'timed out'",
    presence: "traces | where timestamp > datetime({since}) | where operation_Name == 'job X'",
  };
  assert.equal(WatchSchema.safeParse({ signals: [signal] }).success, true, 'a signal may carry it, and need not');
});

test('after the merge, the dry run reads the window that ends at it', async () => {
  const observer = new FakeEnvironmentObserver(ANSWERS);
  const system = build(observer);
  const merged = new Date(Date.now() - 5 * HOUR).toISOString();
  system.store.environments.recordGoalLanding({ prNumber: 7, goalRef: 'issue:12', sha: 'abc', mergedAt: merged });
  system.store.watches.ingestGoalWatch('issue:12', [measure(BOUNDED)]);

  await system.watch.run('issue:12');

  const [asked] = observer.asked;
  assert.equal(asked?.until, merged, 'the merge, not the moment the dry run happened to be taken');
  assert.equal(asked?.since, new Date(Date.parse(merged) - HOUR).toISOString(), 'one window before it');
  assert.equal(asked?.untilIsPast, true);
  const check = system.store.watches.listGoalWatches()[0]!;
  assert.equal(check.baselineValue, 8400, 'and that reading is the baseline');
  system.store.close();
});

test('before anything has merged, the dry run falls back to the window before now', async () => {
  const observer = new FakeEnvironmentObserver(ANSWERS);
  const system = build(observer);
  system.store.watches.ingestGoalWatch('issue:12', [measure(BOUNDED)]);

  const before = Date.now();
  await system.watch.run('issue:12');

  const [asked] = observer.asked;
  assert.ok(asked !== undefined);
  const until = Date.parse(asked.until);
  assert.ok(until >= before && until <= Date.now(), 'now');
  assert.equal(Date.parse(asked.since), until - HOUR);
  assert.equal(asked.untilIsPast, false);
  system.store.close();
});

test('a measure declared before {until} existed reads unknown on its dry run, never a baseline over the change', async () => {
  const observer = new FakeEnvironmentObserver(ANSWERS);
  const system = build(observer);
  system.store.environments.recordGoalLanding({
    prNumber: 7,
    goalRef: 'issue:12',
    sha: 'abc',
    mergedAt: new Date(Date.now() - 5 * HOUR).toISOString(),
  });
  system.store.watches.ingestGoalWatch('issue:12', [measure(OPEN_ENDED)]);

  const refusals = await system.watch.run('issue:12');

  const check = system.store.watches.listGoalWatches()[0]!;
  assert.equal(check.dryRunVerdict, 'unknown');
  assert.equal(check.baselineValue, null, 'no baseline rather than one read on past the merge');
  assert.match(check.dryRunDetail!, /\{until\}/, 'and it says what is missing');
  assert.equal(refusals.length, 1);

  const window = preparedQuery(
    OPEN_ENDED,
    { since: '2026-01-01T00:00:00.000Z', until: '2026-01-02T00:00:00.000Z', untilIsPast: false },
    'orders-p95',
    'measure',
  );
  assert.ok(window.query !== null, 'its window readings are unchanged: {until} would be now anyway');
  system.store.close();
});

test('the observe command is handed LUBBDUBB_WATCH_UNTIL, and the query arrives with {until} substituted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-watch-until-cmd-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const observer = new CommandEnvironmentObserver(dir, 5_000);
    const echo =
      'process.stdout.write(JSON.stringify([{until: process.env.LUBBDUBB_WATCH_UNTIL, q: process.env.LUBBDUBB_WATCH_QUERY, ' +
      `${JSON.stringify(WATCH_ID_COLUMN)}: process.env.LUBBDUBB_WATCH_ID}]))`;
    const result = await observer.observe({
      environment: 'testUk',
      command: `node -e '${echo}'`,
      checkId: 'no-timeouts',
      query: 'traces | where timestamp > datetime({since}) and timestamp <= datetime({until})',
      kind: 'signal',
      since: '2026-01-01T00:00:00.000Z',
      until: '2026-01-02T00:00:00.000Z',
      untilIsPast: true,
    });
    assert.equal(result.verdict, 'answered');
    assert.equal(result.rows![0]!['until'], '2026-01-02T00:00:00.000Z');
    assert.match(String(result.rows![0]!['q']), /timestamp <= datetime\(2026-01-02T00:00:00\.000Z\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the merge is the provider’s merge instant, the last of the goal’s, with the sighting standing in', () => {
  const landing = (over: Partial<GoalLanding>): GoalLanding => ({
    prNumber: 1,
    goalRef: 'issue:12',
    sha: 'a',
    recordedAt: '2026-03-01T12:00:00.000Z',
    onIntegration: true,
    mergedAt: null,
    ...over,
  });
  const at = (iso: string) => Date.parse(iso);
  assert.equal(goalMergedAt([], 'issue:12'), null, 'nothing merged: the caller falls back to now');
  assert.equal(
    goalMergedAt([landing({ mergedAt: '2026-03-01T11:58:00Z' })], 'issue:12'),
    at('2026-03-01T11:58:00Z'),
    'the provider’s instant, not when the sweep saw it',
  );
  assert.equal(goalMergedAt([landing({})], 'issue:12'), at('2026-03-01T12:00:00.000Z'), 'recorded_at stands in');
  assert.equal(
    goalMergedAt(
      [
        landing({ mergedAt: '2026-03-01T11:00:00Z' }),
        landing({ prNumber: 2, mergedAt: '2026-03-02T09:00:00Z' }),
        landing({ prNumber: 3, mergedAt: '2026-03-04T09:00:00Z', onIntegration: false }),
        landing({ prNumber: 4, goalRef: 'issue:13', mergedAt: '2026-03-05T09:00:00Z' }),
      ],
      'issue:12',
    ),
    at('2026-03-02T09:00:00Z'),
    'the last of this goal’s, and never a squash no environment can hold',
  );

  const world = {
    pullRequests: [],
    closedPullRequests: [
      {
        number: 7,
        title: 'Fix #12',
        branch: 'issue/12',
        baseBranch: 'main',
        merged: true,
        state: 'merged',
        closedAt: '2026-03-01T11:58:00Z',
        mergeCommitSha: 'abc',
        ciStatus: 'passing',
        unresolvedComments: [],
      },
    ],
  } as unknown as WorldSnapshot;
  const nodes = [
    { ref: 'issue:12', kind: 'issue', status: 'open', parentRef: null, baseRef: null },
    { ref: 'pr:7', kind: 'pr', status: 'merged', parentRef: 'issue:12', baseRef: null },
  ] as never;
  assert.deepEqual(
    unrecordedLandings({ world, nodes, landed: new Set(), integrationBranch: 'main' }).map((l) => l.mergedAt),
    ['2026-03-01T11:58:00Z'],
    'a landing is recorded with the moment the provider says it merged',
  );
});
