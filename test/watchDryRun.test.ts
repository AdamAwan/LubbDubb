import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeEnvironmentObserver, watchRow } from '../src/environments/fakeObserver.js';
import { validateEnvironments, type EnvironmentConfig } from '../src/environments/policy.js';
import { WatchSchema } from '../src/validation/watchDocument.js';
import { watchNote } from '../src/plans/planning.js';
import type { Agent } from '../src/types.js';

interface ToolResultText {
  isError?: boolean;
  content: { text?: string }[];
}

const TEST_UK: EnvironmentConfig = {
  name: 'testUk',
  at: 'echo unused',
  watch: { observe: './scripts/telemetry.sh testUk', schema: 'Structured logs land in `traces`.' },
};

const SIGNAL = {
  id: 'no-timeouts',
  title: 'Job X stops timing out',
  query: "traces | where message has 'job X timed out'",
  presence: "traces | where operation_Name == 'job X'",
  tolerate: 0,
};

function build(observer: FakeEnvironmentObserver, environments: EnvironmentConfig[] = [TEST_UK]): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-watch-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    environments,
  });
  return buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    environmentObserver: observer,
    errorMirror: () => {},
  });
}

function spawnPlanner(system: System): Agent {
  const task = system.store.createTask({
    kind: 'code',
    title: 'Plan issue #12',
    prompt: 'plan it',
    branch: 'issue/12/plan',
    originRef: 'issue:12:plan',
    originTitle: 'Job X keeps timing out',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function submit(system: System, agent: Agent, watch: unknown) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call('plan_submit', {
    reason: 'One part.',
    parts: [{ slug: 'fix', title: 'Fix the proc', scope: 'src/db' }],
    watch,
  })) as ToolResultText;
  return {
    isError: result.isError === true,
    payload: JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>,
  };
}

test('a signal whose presence query answers zero is unknown, not clean', async () => {
  const observer = new FakeEnvironmentObserver({
    'no-timeouts:presence': '[]',
    'no-timeouts:signal': '[]',
  });
  const system = build(observer);
  const res = await submit(system, spawnPlanner(system), { signals: [SIGNAL] });
  assert.equal(res.isError, false);

  const check = system.store.listGoalWatches().find((w) => w.id === 'no-timeouts')!;
  assert.equal(check.dryRunPresence, 'zero');
  assert.equal(check.dryRunVerdict, 'unknown', 'zero presence is unknown, never a clean reading');
  assert.match(check.dryRunDetail!, /never heard of this code path/);
  assert.deepEqual(
    observer.asked.map((a) => a.kind),
    ['presence'],
  );
  system.store.close();
});

test('a dry run that cannot resolve is returned to the author, not swallowed', async () => {
  const observer = new FakeEnvironmentObserver({
    'no-timeouts:presence': '[]',
    'no-timeouts:signal': '[]',
  });
  const system = build(observer);
  const res = await submit(system, spawnPlanner(system), { signals: [SIGNAL] });
  assert.ok(system.store.getPlanByOrigin('issue:12'), 'the plan landed');
  const refusals = res.payload['watchDryRun'] as string[];
  assert.equal(refusals.length, 1);
  assert.match(refusals[0]!, /^no-timeouts: /);
  system.store.close();
});

test('a result that omits the id echo is unknown, not clean', async () => {
  const observer = new FakeEnvironmentObserver({
    'no-timeouts:presence': JSON.stringify([{ role: 'worker' }]),
  });
  const system = build(observer);
  const res = await submit(system, spawnPlanner(system), { signals: [SIGNAL] });

  const check = system.store.listGoalWatches().find((w) => w.id === 'no-timeouts')!;
  assert.equal(check.dryRunVerdict, 'unknown');
  assert.match(check.dryRunDetail!, /without the query it was given/);
  assert.equal((res.payload['watchDryRun'] as string[]).length, 1);
  system.store.close();
});

test('an observation that answers nothing at all is unknown', async () => {
  const system = build(new FakeEnvironmentObserver());
  await submit(system, spawnPlanner(system), { signals: [SIGNAL] });
  const check = system.store.listGoalWatches().find((w) => w.id === 'no-timeouts')!;
  assert.equal(check.dryRunVerdict, 'unknown');
  assert.match(check.dryRunDetail!, /could not read testUk/);
  system.store.close();
});

test('presence firing and the signal firing is the reading with nothing to hand back', async () => {
  const observer = new FakeEnvironmentObserver({
    'no-timeouts:presence': JSON.stringify([watchRow('no-timeouts', { runs: 96 })]),
    'no-timeouts:signal': JSON.stringify([watchRow('no-timeouts', { role: 'worker' }), watchRow('no-timeouts')]),
  });
  const system = build(observer);
  const res = await submit(system, spawnPlanner(system), { signals: [SIGNAL] });

  const check = system.store.listGoalWatches().find((w) => w.id === 'no-timeouts')!;
  assert.equal(check.dryRunPresence, 'fires');
  assert.equal(check.dryRunVerdict, 'fires');
  assert.equal(check.dryRunRows, 2);
  assert.equal(check.dryRunDetail, null, 'the query is live and the reported defect is real — nothing to fix');
  assert.equal(check.dryRunEnvironment, 'testUk');
  assert.equal(res.payload['watchDryRun'], undefined);
  system.store.close();
});

test('a firing presence over a silent signal is handed back — the query is wrong or the ticket is', async () => {
  const observer = new FakeEnvironmentObserver({
    'no-timeouts:presence': JSON.stringify([watchRow('no-timeouts', { runs: 96 })]),
    'no-timeouts:signal': '[]',
  });
  const system = build(observer);
  const res = await submit(system, spawnPlanner(system), { signals: [SIGNAL] });

  const check = system.store.listGoalWatches().find((w) => w.id === 'no-timeouts')!;
  assert.equal(check.dryRunVerdict, 'zero');
  assert.equal(check.dryRunRows, 0);
  assert.match(check.dryRunDetail!, /Either the query is wrong or the ticket is/);
  assert.equal((res.payload['watchDryRun'] as string[]).length, 1);
  system.store.close();
});

test('a goal that declares no watch reads null and asks nothing', async () => {
  const observer = new FakeEnvironmentObserver();
  const system = build(observer);
  const res = await submit(system, spawnPlanner(system), undefined);
  assert.equal(res.isError, false);
  assert.deepEqual(system.store.listGoalWatches(), []);
  assert.deepEqual(observer.asked, [], 'nothing is asked about a goal with nothing to watch');
  system.store.close();
});

test('no environment declares telemetry, so nothing is asked and nothing is refused', async () => {
  const observer = new FakeEnvironmentObserver();
  const system = build(observer, [{ name: 'testUk', at: 'echo unused' }]);
  const res = await submit(system, spawnPlanner(system), { signals: [SIGNAL] });
  assert.equal(system.store.listGoalWatches().length, 1);
  assert.equal(system.store.listGoalWatches()[0]!.dryRunVerdict, null);
  assert.deepEqual(observer.asked, []);
  assert.equal(res.payload['watchDryRun'], undefined);
  system.store.close();
});

test('an amendment merges on the id and clears the reading it replaced', async () => {
  const observer = new FakeEnvironmentObserver({
    'no-timeouts:presence': JSON.stringify([watchRow('no-timeouts', { runs: 96 })]),
    'no-timeouts:signal': JSON.stringify([watchRow('no-timeouts')]),
  });
  const system = build(observer);
  const agent = spawnPlanner(system);
  await submit(system, agent, { signals: [SIGNAL] });
  assert.equal(system.store.listGoalWatches()[0]!.dryRunRows, 1);

  await submit(system, agent, { signals: [{ ...SIGNAL, id: 'no-timeouts', query: 'traces | where 1 == 2' }] });
  const rows = system.store.listGoalWatches();
  assert.equal(rows.length, 1, 'merged on the id rather than filed beside it');
  assert.equal(rows[0]!.query, 'traces | where 1 == 2');
  assert.deepEqual(
    observer.asked.filter((a) => a.kind === 'signal').map((a) => a.query),
    [SIGNAL.query, 'traces | where 1 == 2'],
    'the amended query was put to the environment, not assumed to answer as its predecessor did',
  );
  system.store.close();
});

test('a check an amendment stopped declaring stops being asked about', async () => {
  const system = build(new FakeEnvironmentObserver());
  const agent = spawnPlanner(system);
  await submit(system, agent, { signals: [SIGNAL, { ...SIGNAL, id: 'no-retries' }] });
  assert.equal(system.store.listGoalWatches().length, 2);
  await submit(system, agent, { signals: [SIGNAL] });
  assert.deepEqual(
    system.store.listGoalWatches().map((w) => w.id),
    ['no-timeouts'],
  );
  system.store.close();
});

const MEASURE = {
  id: 'orders-p95',
  title: 'The orders proc is no slower than it was',
  query: 'requests | summarize value = percentile(duration, 95)',
  expect: { noWorseThan: 'baseline' as const },
  unit: 'ms',
};

test('a measure captures its baseline on the dry run it already rides', async () => {
  const observer = new FakeEnvironmentObserver({
    'orders-p95:measure': JSON.stringify([watchRow('orders-p95', { value: 8400 })]),
  });
  const system = build(observer);
  const res = await submit(system, spawnPlanner(system), { measures: [MEASURE] });
  assert.equal(res.isError, false);

  const check = system.store.listGoalWatches().find((w) => w.id === 'orders-p95')!;
  assert.equal(check.kind, 'measure');
  assert.equal(check.baselineValue, 8400, 'the number the work has to beat, kept rather than discarded');
  assert.ok(check.baselineAt !== null);
  assert.equal(check.dryRunVerdict, 'fires');
  assert.equal(res.payload['watchDryRun'], undefined, 'a measure that answered has nothing to hand back');
  assert.deepEqual(
    observer.asked.map((a) => a.kind),
    ['measure'],
  );
  system.store.close();
});

test('a measure that answers two rows takes no baseline and is handed back', async () => {
  const observer = new FakeEnvironmentObserver({
    'orders-p95:measure': JSON.stringify([
      watchRow('orders-p95', { value: 8400 }),
      watchRow('orders-p95', { value: 12 }),
    ]),
  });
  const system = build(observer);
  const res = await submit(system, spawnPlanner(system), { measures: [MEASURE] });
  const check = system.store.listGoalWatches().find((w) => w.id === 'orders-p95')!;
  assert.equal(check.dryRunVerdict, 'unknown');
  assert.equal(check.baselineValue, null, 'nothing answered, so there is no before');
  assert.match((res.payload['watchDryRun'] as string[])[0]!, /exactly one row/);
  system.store.close();
});

test('an amended measure re-takes its baseline rather than keeping the old one', async () => {
  const observer = new FakeEnvironmentObserver({
    'orders-p95:measure': JSON.stringify([watchRow('orders-p95', { value: 8400 })]),
  });
  const system = build(observer);
  const agent = spawnPlanner(system);
  await submit(system, agent, { measures: [MEASURE] });
  assert.equal(system.store.listGoalWatches()[0]!.baselineValue, 8400);

  await submit(system, agent, { measures: [{ ...MEASURE, query: 'requests | summarize value = avg(duration)' }] });
  const after = system.store.listGoalWatches()[0]!;
  assert.equal(after.query, 'requests | summarize value = avg(duration)');
  assert.deepEqual(
    observer.asked.filter((a) => a.kind === 'measure').map((a) => a.query),
    [MEASURE.query, 'requests | summarize value = avg(duration)'],
    'the amended query was put to the environment, not assumed to answer as its predecessor did',
  );
  assert.ok(after.baselineAt !== null, 'and the reading it answered with is the new baseline');
  system.store.close();
});

test('a measure whose dry run never answered carries no baseline at all', async () => {
  const system = build(new FakeEnvironmentObserver());
  await submit(system, spawnPlanner(system), { measures: [MEASURE] });
  const check = system.store.listGoalWatches()[0]!;
  assert.equal(check.baselineValue, null);
  assert.equal(check.baselineAt, null);
  assert.equal(check.dryRunVerdict, 'unknown');
  system.store.close();
});

test('a signal without a presence query is refused', () => {
  const parsed = WatchSchema.safeParse({ signals: [{ ...SIGNAL, presence: undefined }] });
  assert.equal(parsed.success, false);
});

test('a measure declaring neither a threshold nor a baseline is refused at ingestion', () => {
  assert.equal(WatchSchema.safeParse({ measures: [{ ...MEASURE, expect: {} }] }).success, false);
  assert.equal(WatchSchema.safeParse({ measures: [{ ...MEASURE, expect: { under: 500 } }] }).success, true);
  assert.equal(WatchSchema.safeParse({ measures: [MEASURE] }).success, true);
  assert.equal(WatchSchema.safeParse({ measures: [{ ...MEASURE, presence: 'x' }] }).success, false);
});

test('a watch block declares only signals and measures, and duplicate ids are refused', () => {
  assert.equal(WatchSchema.safeParse({ signals: [], rumours: [] }).success, false);
  assert.equal(WatchSchema.safeParse({ signals: [SIGNAL, SIGNAL] }).success, false);
  assert.equal(WatchSchema.safeParse({ signals: [SIGNAL], measures: [{ ...MEASURE, id: SIGNAL.id }] }).success, false);
  assert.equal(WatchSchema.safeParse({ signals: [SIGNAL] }).success, true);
  const parsed = WatchSchema.parse({ signals: [{ ...SIGNAL, tolerate: undefined }] });
  assert.equal(parsed.signals[0]!.tolerate, 0);
});

test('an id that is not kebab-case is refused, because it is interpolated into the projection', () => {
  assert.equal(WatchSchema.safeParse({ signals: [{ ...SIGNAL, id: 'no"; drop table --' }] }).success, false);
});

test('validateEnvironments refuses a watch that cannot mean what it says', () => {
  const refuse = (watch: unknown, why: RegExp) =>
    assert.throws(() => validateEnvironments([{ name: 'testUk', at: 'x', watch } as EnvironmentConfig]), why);
  refuse({ observe: '  ' }, /unanswerable forever/);
  refuse({ observe: 'x', holds: ['deploy'] }, /not an obligation the harness files/);
  refuse({ observe: 'x', forMs: 0 }, /positive number of milliseconds/);
  refuse({ observe: 'x', queryUrl: '  ' }, /non-empty URL template/);
  refuse({ observe: 'x', queryUrl: 'https://portal.example/logs' }, /carries none of/);
  assert.doesNotThrow(() =>
    validateEnvironments([
      { name: 'testUk', at: 'x', watch: { observe: 'x', queryUrl: 'https://portal.example#q={queryGzip}' } },
    ]),
  );
  assert.throws(
    () => validateEnvironments([{ name: 'testUk', at: 'x', describe: 'y' } as unknown as EnvironmentConfig]),
    /belongs inside "watch"/,
  );
  assert.doesNotThrow(() => validateEnvironments([TEST_UK]));
});

test('the planner’s watch guidance is appended, and is empty where nothing declares telemetry', () => {
  assert.equal(watchNote([{ name: 'testUk' }]), '');
  const note = watchNote([TEST_UK]);
  assert.match(note, /testUk/);
  assert.match(note, /presence/);
  assert.match(note, /Structured logs land in/);
});

test('nothing under src/dispatcher/ imports src/environments/', () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') && /from '[^']*environments\//.test(readFileSync(path, 'utf8')))
        offenders.push(path);
    }
  };
  walk('src/dispatcher');
  assert.deepEqual(offenders, []);
});
