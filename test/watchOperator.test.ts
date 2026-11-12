import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system/system.js';
import { buildApp } from '../src/server/app.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { Store } from '../src/store/store.js';
import { SCHEMA } from '../src/store/schema.js';
import { WATCH_COLUMNS } from '../src/store/watches.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeEnvironmentObserver } from '../src/environments/fakeObserver.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { openWatchAsks, WatchAsks } from '../src/environments/watchAsks.js';
import { watchClearedGoals, watchWindowReadings } from '../src/environments/watchFinding.js';
import { watchOutcome } from '../src/environments/watchOutcome.js';
import { parseOperatorAnswer } from '../src/environments/watchResult.js';
import { validateEnvironments, type EnvironmentConfig } from '../src/environments/policy.js';
import { buildDesktopTools } from '../src/mcp/desktopTools.js';
import { DESKTOP_TOOL_NAMES, MCP_TOOL_NAMES } from '../src/mcp/names.js';
import { DESK_SETTLED } from '../src/benchSettlement.js';
import { desktopDeps } from './support/desktop.js';
import type { GoalWatch, GoalWatchInput, WatchAsk, WatchReading, WatchWindow } from '../src/types.js';

// → docs/spec/29-post-deploy-watch.md#a-source-only-the-operator-can-run

const GOAL = 'issue:12';
const HOUR_MS = 60 * 60 * 1000;

const MEASURE: GoalWatchInput = {
  id: 'orders-landed',
  seq: 1,
  kind: 'measure',
  title: 'Orders still land',
  query: 'select count(*) as value from orders where created_at > {since} and created_at <= {until}',
  presence: null,
  tolerate: 0,
  expectUnder: null,
  expectOver: 10,
  expectBaseline: false,
  unit: null,
  why: null,
  source: 'sql',
};

const SIGNAL: GoalWatchInput = {
  id: 'no-deadlocks',
  seq: 2,
  kind: 'signal',
  title: 'No deadlocks',
  query: 'select * from deadlocks where at > {since} and at <= {until}',
  presence: 'select * from runs where at > {since} and at <= {until}',
  tolerate: 0,
  expectUnder: null,
  expectOver: null,
  expectBaseline: false,
  unit: null,
  why: null,
  source: 'sql',
};

function sqlEnvironment(name: string, watch: Record<string, unknown> = {}): EnvironmentConfig {
  return {
    name,
    at: 'echo unused',
    watch: {
      sources: { sql: { language: 'sql', runBy: 'operator', queryUrl: 'https://sql.example/?q={query}' } },
      forMs: 1000,
      ...watch,
    },
  };
}

function build(environments: EnvironmentConfig[], observer = new FakeEnvironmentObserver({})): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-watch-operator-'));
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
      environmentProbeIntervalMs: 5 * 60 * 1000,
      environments,
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      environmentObserver: observer,
      environmentProber: new FakeEnvironmentProber(),
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
    },
  );
}

function asks(
  system: System,
): { task: ReturnType<System['store']['humanTasks']['listHumanTasksOfKind']>[number]; ask: WatchAsk }[] {
  return system.store.humanTasks.listHumanTasksOfKind('watch_reading').map((task) => ({
    task,
    ask: system.store.watches.getWatchAsk(task.id)!,
  }));
}

function arrived(system: System, environment: string, checks: GoalWatchInput[]): void {
  system.store.watches.ingestGoalWatch(GOAL, checks);
  system.store.environments.recordGoalArrival({
    goalRef: GOAL,
    environment,
    arrivedAt: new Date(Date.now() - 60_000).toISOString(),
  });
}

test('an operator source spawns nothing: its baseline is asked once per check per environment, at the dry run', async () => {
  const observer = new FakeEnvironmentObserver({});
  const system = build([sqlEnvironment('liveUk'), sqlEnvironment('liveEu')], observer);
  system.store.watches.ingestGoalWatch(GOAL, [MEASURE, SIGNAL]);

  const refusals = await system.watch.run(GOAL);
  await system.watch.run(GOAL);

  assert.deepEqual(observer.asked, [], 'nothing is ever put to a source only a person can run');
  assert.deepEqual(refusals, [], 'a person-run check is not a refusal of the author');
  const filed = asks(system);
  assert.equal(filed.length, 4, 'two checks, two environments, one baseline ask each — and a second dry run adds none');
  assert.ok(filed.every(({ task, ask }) => task.status === 'open' && ask.ask === 'baseline'));
  const signal = filed.find(({ ask }) => ask.checkId === 'no-deadlocks' && ask.environment === 'liveUk')!;
  assert.ok(signal.task.detail?.includes('```sql'), 'the fence is named for the source language');
  assert.ok(!signal.task.detail?.includes('{since}'), 'the period is filled in, so it runs as it stands');
  assert.ok(signal.task.detail?.includes('select * from runs where at >'), 'a signal carries its presence query too');
  assert.ok(signal.task.detail?.includes('https://sql.example/?q='), "the source's own queryUrl is the link");
  const check = system.store.watches.listGoalWatches().find((c) => c.id === 'orders-landed')!;
  assert.equal(check.dryRunVerdict, 'unknown');
  assert.match(check.dryRunDetail ?? '', /only through a person/);
  system.store.close();
});

test('the accept asks for the baselines of a set the assessor wrote; nothing is asked while it is proposed', async () => {
  const system = build([sqlEnvironment('liveUk')]);
  system.store.watches.oweWatchPlan(GOAL);
  system.store.watches.authorWatchPlan(GOAL, [{ ...MEASURE, changedFromHint: null }], { note: 'n', emptyReason: null });
  await system.watch.run(GOAL);
  assert.equal(asks(system).length, 0, 'a proposed set asks nothing of anybody');

  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'POST', url: '/api/issues/12/watch/accept' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    asks(system).map(({ ask }) => [ask.checkId, ask.environment, ask.ask]),
    [['orders-landed', 'liveUk', 'baseline']],
  );
  await app.close();
  system.store.close();
});

test('a pasted baseline sets the measure’s baseline; a paste off the contract is refused and records nothing', async () => {
  const system = build([sqlEnvironment('liveUk')]);
  system.store.watches.ingestGoalWatch(GOAL, [{ ...MEASURE, expectOver: null, expectBaseline: true }]);
  await system.watch.run(GOAL);
  const [{ task }] = asks(system) as [ReturnType<typeof asks>[number]];
  const { app } = await buildApp(system);

  const refused = await app.inject({
    method: 'POST',
    url: `/api/watch-asks/${task.id}/answer`,
    payload: { answer: '[{"value": 1}, {"value": 2}]' },
  });
  assert.equal(refused.statusCode, 400);
  assert.match((refused.json() as { error: string }).error, /exactly one row/);
  assert.equal(system.store.humanTasks.getHumanTask(task.id)?.status, 'open');

  const res = await app.inject({
    method: 'POST',
    url: `/api/watch-asks/${task.id}/answer`,
    payload: { answer: '1190' },
  });
  assert.equal(res.statusCode, 200);
  const check = system.store.watches.listGoalWatches()[0]!;
  assert.equal(check.baselineValue, 1190);
  assert.equal(check.dryRunEnvironment, 'liveUk');
  assert.equal(system.store.humanTasks.getHumanTask(task.id)?.status, 'done');
  await app.close();
  system.store.close();
});

test('a window that closes asks for its closing reading, and the outcome waits for it', async () => {
  const system = build([sqlEnvironment('liveUk')]);
  arrived(system, 'liveUk', [MEASURE]);

  await system.harness.runCycle();

  const window = system.store.watches.listWatchWindows()[0]!;
  assert.notEqual(window.settledAt, null, 'the harness checks settle at forMs as ever');
  const closing = asks(system).filter(({ ask }) => ask.ask === 'closing');
  assert.equal(closing.length, 1, 'one closing ask per check per environment');
  assert.equal(closing[0]!.ask.since, window.openedAt, 'from the arrival…');
  assert.equal(closing[0]!.ask.until, window.settledAt, '…to the end of the window');
  await system.harness.runCycle();
  assert.equal(asks(system).length, 1, 'a second pulse files no second ask');

  const before = buildStateSnapshot(system);
  assert.equal(before.goalWatchOutcomes.find((o) => o.goalRef === GOAL)?.outcome, 'watching');
  assert.equal(before.goalWatchWindows[0]?.checks[0]?.waitingOnYou, true);
  assert.equal(before.watchAsks[0]?.query.includes('{since}'), false);
  assert.equal(before.watchAsks[0]?.language, 'sql');

  const { app } = await buildApp(system);
  const res = await app.inject({
    method: 'POST',
    url: `/api/watch-asks/${closing[0]!.task.id}/answer`,
    payload: { answer: '[{"value": 40}]' },
  });
  assert.equal(res.statusCode, 200);
  const [reading] = system.store.watches.listWatchReadings();
  assert.equal(reading?.readBy, 'operator');
  assert.equal(reading?.verdict, 'clean');
  assert.equal(reading?.value, 40);
  const after = buildStateSnapshot(system);
  assert.equal(after.goalWatchOutcomes.find((o) => o.goalRef === GOAL)?.outcome, 'worked');
  assert.deepEqual(after.watchAsks, []);
  await app.close();
  system.store.close();
});

test('an unanswered closing ask settles the check unknown after operatorGraceMs, and the row retracts itself', async () => {
  const environments = [sqlEnvironment('liveUk', { operatorGraceMs: 2 * HOUR_MS })];
  const system = build(environments);
  arrived(system, 'liveUk', [MEASURE]);
  await system.harness.runCycle();
  const [{ task }] = asks(system) as [ReturnType<typeof asks>[number]];

  new WatchAsks({ store: system.store, environments, now: () => Date.now() + HOUR_MS }).pass();
  assert.equal(system.store.humanTasks.getHumanTask(task.id)?.status, 'open', 'still in grace');

  new WatchAsks({ store: system.store, environments, now: () => Date.now() + 3 * HOUR_MS }).pass();
  const settled = system.store.humanTasks.getHumanTask(task.id)!;
  assert.notEqual(settled.status, 'open');
  assert.ok(settled.resolution?.startsWith(DESK_SETTLED), 'the harness retracts its own row');
  const [reading] = system.store.watches.listWatchReadings();
  assert.equal(reading?.verdict, 'unknown', 'nobody ran it is never clean');
  assert.match(reading?.detail ?? '', /nobody ran it/);
  assert.equal(buildStateSnapshot(system).goalWatchOutcomes.find((o) => o.goalRef === GOAL)?.outcome, 'unknown');
  system.store.close();
});

test('an answered closing ask is never re-opened by the harness — only the operator extending its window asks again', async () => {
  const environments = [sqlEnvironment('liveUk')];
  const system = build(environments);
  arrived(system, 'liveUk', [MEASURE]);
  await system.harness.runCycle();
  const [{ task }] = asks(system) as [ReturnType<typeof asks>[number]];
  const answered = system.watchAsks.answer(task.id, { answer: '40', presence: null });
  assert.equal(answered.ok, true);

  await system.harness.runCycle();
  assert.equal(system.store.humanTasks.getHumanTask(task.id)?.status, 'done', 'the next pass leaves it answered');

  const { app } = await buildApp(system);
  const extended = await app.inject({ method: 'POST', url: `/api/issues/12/watch/liveUk/extend` });
  assert.equal(extended.statusCode, 200);
  new WatchAsks({ store: system.store, environments }).pass();
  assert.equal(system.store.humanTasks.getHumanTask(task.id)?.status, 'done', 'nothing is asked while it watches');

  await new Promise((resolve) => setTimeout(resolve, 5));
  system.store.watches.settleWatchWindow(GOAL, 'liveUk');
  new WatchAsks({ store: system.store, environments }).pass();
  const reasked = system.store.humanTasks.getHumanTask(task.id)!;
  assert.equal(reasked.status, 'open', 'the extend asked to watch longer, so the closing reading is asked again');
  const window = system.store.watches.listWatchWindows()[0]!;
  assert.equal(system.store.watches.getWatchAsk(task.id)?.until, window.settledAt, 'over the new period');
  const waiting = () =>
    watchWindowReadings({
      windows: system.store.watches.listWatchWindows(),
      checks: system.store.watches.listGoalWatches(),
      readings: system.store.watches.listWatchReadings(),
      waiting: openWatchAsks(system.store),
    })[0]!;
  assert.equal(waiting().settled, false, 'the old period’s answer does not settle the longer window');

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(system.watchAsks.answer(task.id, { answer: '3', presence: null }).ok, true);
  const readings = system.store.watches.listWatchReadings();
  assert.deepEqual(
    readings.map((r) => r.value),
    [40, 3],
    'the old answer stays in the history',
  );
  const standing = waiting();
  assert.equal(standing.settled, true);
  assert.equal(standing.checks[0]?.reading?.value, 3, 'and the new period’s answer is the one that stands');
  assert.equal(standing.verdict, 'regressed');

  new WatchAsks({ store: system.store, environments }).pass();
  assert.equal(system.store.humanTasks.getHumanTask(task.id)?.status, 'done', 'and is not re-opened after it');
  await app.close();
  system.store.close();
});

test('a dry run leaves an answered baseline alone: editing one check keeps the other’s answer', async () => {
  const system = build([sqlEnvironment('liveUk')]);
  system.store.watches.ingestGoalWatch(GOAL, [MEASURE, SIGNAL]);
  await system.watch.run(GOAL);
  const signalAsk = asks(system).find(({ ask }) => ask.checkId === SIGNAL.id)!;
  const answered = system.watchAsks.answer(signalAsk.task.id, {
    answer: '[{"at": 1}, {"at": 2}]',
    presence: '[{"at": 1}]',
  });
  assert.equal(answered.ok, true);
  const before = system.store.watches.listGoalWatches().find((c) => c.id === SIGNAL.id)!;
  assert.equal(before.dryRunRows, 2);

  const { seq: _seq, ...edited } = { ...MEASURE, query: `${MEASURE.query} and region = 'uk'` };
  system.store.watches.saveOperatorWatch(GOAL, edited);
  await system.watch.run(GOAL);

  const after = system.store.watches.listGoalWatches().find((c) => c.id === SIGNAL.id)!;
  assert.equal(after.dryRunVerdict, 'fires', 'the answer the person gave still stands');
  assert.equal(after.dryRunPresence, 'fires');
  assert.equal(after.dryRunRows, 2);
  assert.equal(after.dryRunAt, before.dryRunAt);
  assert.equal(system.store.humanTasks.getHumanTask(signalAsk.task.id)?.status, 'done', 'and is not asked again');
  const measure = system.store.watches.listGoalWatches().find((c) => c.id === MEASURE.id)!;
  assert.equal(measure.dryRunVerdict, 'unknown', 'the edited check is the one put back to the placeholder');
  const measureAsk = asks(system).find(({ ask }) => ask.checkId === MEASURE.id)!;
  assert.equal(measureAsk.task.status, 'open', 'and asked afresh');
  system.store.close();
});

test('an answered baseline is asked afresh once an edit changes the query it answered', async () => {
  const system = build([sqlEnvironment('liveUk')]);
  system.store.watches.ingestGoalWatch(GOAL, [MEASURE]);
  await system.watch.run(GOAL);
  const [{ task }] = asks(system) as [ReturnType<typeof asks>[number]];
  system.watchAsks.answer(task.id, { answer: '1190', presence: null });
  await system.watch.run(GOAL);
  assert.equal(system.store.humanTasks.getHumanTask(task.id)?.status, 'done', 'the same question is not asked twice');

  const { seq: _seq, ...edited } = { ...MEASURE, query: `${MEASURE.query} and region = 'uk'` };
  system.store.watches.saveOperatorWatch(GOAL, edited);
  await system.watch.run(GOAL);
  assert.equal(system.store.humanTasks.getHumanTask(task.id)?.status, 'open', 'the answer was to a query that is gone');
  system.store.close();
});

test('an unanswered closing ask its window outran retracts, and re-opens with the new period when it settles again', async () => {
  const environments = [sqlEnvironment('liveUk')];
  const system = build(environments);
  arrived(system, 'liveUk', [MEASURE]);
  await system.harness.runCycle();
  const [{ task }] = asks(system) as [ReturnType<typeof asks>[number]];

  system.store.watches.extendWatchWindow(GOAL, 'liveUk', new Date(Date.now() + HOUR_MS).toISOString());
  new WatchAsks({ store: system.store, environments }).pass();
  const retracted = system.store.humanTasks.getHumanTask(task.id)!;
  assert.equal(retracted.status, 'declined');
  assert.ok(retracted.resolution?.startsWith(DESK_SETTLED));

  await new Promise((resolve) => setTimeout(resolve, 5));
  system.store.watches.settleWatchWindow(GOAL, 'liveUk');
  new WatchAsks({ store: system.store, environments }).pass();
  assert.equal(system.store.humanTasks.getHumanTask(task.id)?.status, 'open', 'the same row, re-opened');
  const window = system.store.watches.listWatchWindows()[0]!;
  assert.equal(system.store.watches.getWatchAsk(task.id)?.until, window.settledAt, 'asking over the new period');
  system.store.close();
});

test('a holds opt-in is not cleared by a window still waiting on a person’s closing reading', async () => {
  const environment = sqlEnvironment('liveUk', { holds: ['close_out'] });
  const system = build([environment]);
  arrived(system, 'liveUk', [MEASURE]);
  await system.harness.runCycle();
  const cleared = () =>
    watchClearedGoals('close_out', [environment], system.store.watches.listWatchWindows(), [], () =>
      openWatchAsks(system.store),
    );
  assert.notEqual(system.store.watches.listWatchWindows()[0]?.settledAt, null);
  assert.equal(cleared()?.has(GOAL), false, 'settled, but the window has not answered');

  const [{ task }] = asks(system) as [ReturnType<typeof asks>[number]];
  system.watchAsks.answer(task.id, { answer: '40', presence: null });
  assert.equal(cleared()?.has(GOAL), true);
  system.store.close();
});

test('an ask whose check is dropped retracts itself', async () => {
  const system = build([sqlEnvironment('liveUk')]);
  system.store.watches.ingestGoalWatch(GOAL, [MEASURE]);
  await system.watch.run(GOAL);
  const [{ task }] = asks(system) as [ReturnType<typeof asks>[number]];
  system.store.watches.deleteGoalWatch(GOAL, MEASURE.id);
  await system.harness.runCycle();
  const settled = system.store.humanTasks.getHumanTask(task.id)!;
  assert.equal(settled.status, 'declined');
  assert.ok(settled.resolution?.startsWith(DESK_SETTLED));
  system.store.close();
});

test('the desktop watch_reading tool lists the open asks and records through the same path, read_by operator', async () => {
  assert.ok((DESKTOP_TOOL_NAMES as readonly string[]).includes('watch_reading'));
  assert.ok(!(MCP_TOOL_NAMES as readonly string[]).includes('watch_reading'), 'never on the fleet’s channel');
  const system = build([sqlEnvironment('liveUk')]);
  arrived(system, 'liveUk', [SIGNAL]);
  await system.harness.runCycle();
  const tool = buildDesktopTools(
    { ...desktopDeps(system), now: () => new Date().toISOString() },
    {
      label: 'adam',
      held: null,
    },
  ).find((t) => t.name === 'watch_reading')!;

  const listed = await tool.handler({});
  const { asks: open } = JSON.parse(listed.content[0]!.text) as {
    asks: { taskId: string; query: string; presence: string }[];
  };
  assert.equal(open.length, 1);
  assert.ok(!open[0]!.query.includes('{since}') && !open[0]!.presence.includes('{until}'));

  const missing = await tool.handler({ ask: open[0]!.taskId, answer: '[]' });
  assert.equal(missing.isError, true, 'a signal is asked both questions');

  const recorded = await tool.handler({ ask: open[0]!.taskId, answer: '[]', presence: '[{"run": 1}]' });
  assert.notEqual(recorded.isError, true, recorded.content[0]?.text);
  const [reading] = system.store.watches.listWatchReadings();
  assert.equal(reading?.readBy, 'operator');
  assert.equal(reading?.verdict, 'clean');
  assert.equal(system.store.humanTasks.getHumanTask(open[0]!.taskId)?.status, 'done');
  system.store.close();
});

test('a window waits for its operator readings before its outcome, and for nothing else', () => {
  const window: WatchWindow = {
    goalRef: GOAL,
    environment: 'liveUk',
    openedAt: '2026-11-01T00:00:00.000Z',
    settlesAt: '2026-11-03T00:00:00.000Z',
    settledAt: '2026-11-03T00:00:00.000Z',
    extendedAt: null,
    exposedAt: null,
  };
  const harness = goalWatch({ id: 'logs-clean', source: 'logs' });
  const operator = goalWatch({ id: 'sql-clean', source: 'sql' });
  const clean: WatchReading = {
    goalRef: GOAL,
    environment: 'liveUk',
    checkId: 'logs-clean',
    readAt: '2026-11-02T00:00:00.000Z',
    verdict: 'clean',
    rows: 0,
    value: null,
    detail: null,
    readBy: 'harness',
  };
  const waiting: WatchAsk = {
    taskId: 'hum_1',
    goalRef: GOAL,
    checkId: 'sql-clean',
    environment: 'liveUk',
    ask: 'closing',
    since: window.openedAt,
    until: window.settledAt!,
  };
  const fold = (asked: WatchAsk[], readings: WatchReading[]) =>
    watchOutcome({
      goalRef: GOAL,
      checks: [harness, operator],
      windows: watchWindowReadings({ windows: [window], checks: [harness, operator], readings, waiting: asked }),
      standing: null,
    });
  assert.equal(fold([waiting], [clean])?.outcome, 'watching', 'never worked on the harness checks alone');
  assert.deepEqual(fold([waiting], [clean])?.watching, ['liveUk']);
  assert.equal(fold([{ ...waiting, ask: 'baseline' }], [clean])?.outcome, 'unknown', 'only a closing ask holds');
  const answered = { ...clean, checkId: 'sql-clean', readBy: 'operator' as const };
  assert.equal(fold([], [clean, answered])?.outcome, 'worked');
});

test('a measure may be answered with its one number; a signal never with a count', () => {
  assert.equal(parseOperatorAnswer(' 37 ', 'measure').value, 37);
  assert.equal(parseOperatorAnswer('37', 'signal').verdict, 'unknown');
  assert.equal(parseOperatorAnswer('[{"a": 1}]', 'signal').rows?.length, 1, 'no id echo is asked of a person');
});

test('watch_readings.read_by reaches a database from before it, and null reads harness', () => {
  assert.equal(WATCH_COLUMNS.watch_readings?.read_by, 'TEXT');
  const path = join(mkdtempSync(join(tmpdir(), 'lubbdubb-read-by-')), 'old.db');
  const db = new Database(path);
  db.exec(SCHEMA);
  db.exec('ALTER TABLE watch_readings DROP COLUMN read_by');
  db.prepare(
    `INSERT INTO watch_readings (goal_ref, environment, check_id, read_at, verdict, rows_read, value, detail)
     VALUES ('issue:12', 'liveUk', 'c', '2026-01-01', 'clean', 0, NULL, NULL)`,
  ).run();
  db.close();
  const store = new Store(path);
  assert.equal(store.watches.listWatchReadings()[0]?.readBy, 'harness');
  store.watches.recordWatchReading({
    goalRef: 'issue:12',
    environment: 'liveUk',
    checkId: 'c',
    verdict: 'clean',
    rows: 0,
    value: null,
    detail: null,
    readBy: 'operator',
  });
  assert.equal(store.watches.listWatchReadings().at(-1)?.readBy, 'operator');
  store.close();
});

test('validateEnvironments refuses an operatorGraceMs that is not a positive duration', () => {
  assert.throws(() => validateEnvironments([sqlEnvironment('liveUk', { operatorGraceMs: 0 })]), /operatorGraceMs/);
  validateEnvironments([sqlEnvironment('liveUk', { operatorGraceMs: 3 * HOUR_MS })]);
});

function goalWatch(over: Partial<GoalWatch>): GoalWatch {
  return {
    id: 'c',
    seq: 1,
    kind: 'signal',
    title: 'c',
    query: 'q {since} {until}',
    presence: null,
    tolerate: 0,
    expectUnder: null,
    expectOver: null,
    expectBaseline: false,
    unit: null,
    why: null,
    source: null,
    originRef: GOAL,
    dryRunEnvironment: null,
    dryRunAt: null,
    dryRunVerdict: null,
    dryRunPresence: null,
    dryRunRows: null,
    dryRunDetail: null,
    baselineValue: null,
    baselineAt: null,
    live: true,
    authored: 'plan',
    changedFromHint: null,
    ...over,
  };
}

test('two checks sharing a title are two asks, never one bench row the second check cannot record against', async () => {
  const system = build([sqlEnvironment('liveUk')]);
  system.store.watches.ingestGoalWatch(GOAL, [MEASURE, { ...MEASURE, id: 'orders-landed-eu', seq: 2 }]);
  await system.watch.run(GOAL);
  const filed = asks(system);
  assert.equal(filed.length, 2);
  assert.deepEqual(filed.map((a) => a.ask.checkId).sort(), ['orders-landed', 'orders-landed-eu']);
  system.store.close();
});
