import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildApp } from '../src/server/app.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeEnvironmentObserver } from '../src/environments/fakeObserver.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { watchClearedGoals, watchWindowReadings } from '../src/environments/watchFinding.js';
import { watchOutcome, watchOutcomeNote } from '../src/environments/watchOutcome.js';
import { buildGoalWatchOutcomes } from '../src/server/stateEnvironmentViews.js';
import { hintEmptyReason } from '../src/plans/watchHint.js';
import type { WatchStanding } from '../src/validation/watchAuthoring.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type {
  GoalLanding,
  GoalWatch,
  Plan,
  WatchCheckVerdict,
  WatchOutcome,
  WatchPlanRecord,
  WatchReading,
  WatchWindow,
} from '../src/types.js';

(globalThis as { React?: typeof React }).React = React;

const GOAL = 'issue:12';

function check(id: string, over: Partial<GoalWatch> = {}): GoalWatch {
  return {
    id,
    seq: 1,
    kind: 'signal',
    title: `Check ${id}`,
    query: 'traces | where timestamp between (datetime({since}) .. datetime({until}))',
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

function window(environment: string, settled: boolean): WatchWindow {
  return {
    goalRef: GOAL,
    environment,
    openedAt: '2026-11-01T00:00:00.000Z',
    settlesAt: '2026-11-03T00:00:00.000Z',
    settledAt: settled ? '2026-11-03T00:00:00.000Z' : null,
    extendedAt: null,
    exposedAt: null,
  };
}

function reading(
  environment: string,
  checkId: string,
  verdict: WatchCheckVerdict,
  over: Partial<WatchReading> = {},
): WatchReading {
  return {
    goalRef: GOAL,
    environment,
    checkId,
    readAt: '2026-11-02T00:00:00.000Z',
    verdict,
    rows: verdict === 'unknown' ? null : 0,
    value: null,
    detail: verdict === 'unknown' ? `the watch could not read ${environment}` : null,
    readBy: 'harness',
    ...over,
  };
}

function fold(input: {
  checks?: GoalWatch[];
  windows?: WatchWindow[];
  readings?: WatchReading[];
  standing?: WatchStanding;
}): WatchOutcome | null {
  const checks = (input.checks ?? []).filter((c) => c.originRef === GOAL);
  return watchOutcome({
    goalRef: GOAL,
    checks,
    windows: resolve(checks, input.windows ?? [], input.readings ?? []),
    standing: input.standing ?? null,
  });
}

function resolve(checks: GoalWatch[], windows: WatchWindow[], readings: WatchReading[]) {
  return watchWindowReadings({ windows, checks, readings, waiting: [] });
}

test('any check settled regressed on any environment reads made something worse, and still names the clean ones', () => {
  const outcome = fold({
    checks: [check('a'), check('b', { kind: 'measure', baselineValue: 1840, unit: 'ms', expectBaseline: true })],
    windows: [window('testUk', true), window('liveUk', true)],
    readings: [
      reading('testUk', 'a', 'clean'),
      reading('liveUk', 'a', 'clean'),
      reading('testUk', 'b', 'clean', { value: 1190 }),
      reading('liveUk', 'b', 'regressed', { value: 2400, detail: 'liveUk read 2400 ms' }),
    ],
  });
  assert.equal(outcome?.outcome, 'worse');
  const [a, b] = outcome.checks;
  assert.equal(a?.verdict, 'clean', 'one regressed check does not hide the fix that worked');
  assert.equal(b?.verdict, 'regressed');
  assert.equal(b?.environment, 'liveUk');
  assert.deepEqual([b?.before, b?.after], [1840, 2400]);
  assert.equal(b?.reason, 'liveUk read 2400 ms');
});

test('every check settled clean on at least one environment reads it worked, with the numbers', () => {
  const outcome = fold({
    checks: [
      check('fails', { dryRunRows: 37 }),
      check('p95', { kind: 'measure', baselineValue: 1840, unit: 'ms', expectBaseline: true }),
    ],
    windows: [window('testUk', true), window('liveUk', true)],
    readings: [
      reading('testUk', 'fails', 'unknown'),
      reading('liveUk', 'fails', 'clean', { rows: 0 }),
      reading('liveUk', 'p95', 'clean', { value: 1190 }),
    ],
  });
  assert.equal(outcome?.outcome, 'worked');
  assert.deepEqual(
    outcome.checks.map((c) => [c.before, c.after, c.environment, c.windowSpan]),
    [
      [37, 0, 'liveUk', '48h'],
      [1840, 1190, 'liveUk', '48h'],
    ],
  );
});

test('unknown everywhere is never it worked, and says why in words', () => {
  const outcome = fold({
    checks: [check('a'), check('b')],
    windows: [window('liveUk', true)],
    readings: [reading('liveUk', 'a', 'clean')],
  });
  assert.equal(outcome?.outcome, 'unknown');
  assert.match(outcome.checks[1]?.reason ?? '', /liveUk: the window settled without ever reading it/);

  const silent = fold({
    checks: [check('a')],
    windows: [window('liveUk', true)],
    readings: [reading('liveUk', 'a', 'unknown')],
  });
  assert.equal(silent?.outcome, 'unknown');
  assert.match(silent.checks[0]?.reason ?? '', /could not read liveUk/);
});

test('only settled windows count: an open window is watching, and a regressed reading on it is not yet an outcome', () => {
  const outcome = fold({
    checks: [check('a')],
    windows: [window('liveUk', false)],
    readings: [reading('liveUk', 'a', 'regressed')],
  });
  assert.equal(outcome?.outcome, 'watching');
  assert.deepEqual(outcome.watching, ['liveUk']);

  const mixed = fold({
    checks: [check('a')],
    windows: [window('testUk', true), window('liveUk', false)],
    readings: [reading('testUk', 'a', 'clean'), reading('liveUk', 'a', 'regressed')],
  });
  assert.equal(mixed?.outcome, 'worked');
  assert.deepEqual(mixed.watching, ['liveUk']);
});

test('the newest reading on a window is the one that stands', () => {
  const outcome = fold({
    checks: [check('a')],
    windows: [window('liveUk', true)],
    readings: [reading('liveUk', 'a', 'regressed'), reading('liveUk', 'a', 'clean')],
  });
  assert.equal(outcome?.outcome, 'worked');
});

test('a watch decided empty reads nothing measured with its reason; no checks and no reason is no outcome', () => {
  const none = fold({ standing: { kind: 'none', reason: 'A copy change: nothing a running system says would move.' } });
  assert.deepEqual(none, {
    goalRef: GOAL,
    outcome: 'none',
    headline: 'Nothing was measured',
    checks: [],
    reason: 'A copy change: nothing a running system says would move.',
    watching: [],
    discussable: false,
    extendable: [],
  });
  assert.equal(fold({}), null, 'null is not clean, and not nothing measured either');
  assert.equal(fold({ checks: [check('a')] }), null, 'nothing has arrived, so there is no window to answer from');
  assert.equal(hintEmptyReason({ none: 'copy only' }), 'copy only');
  assert.equal(hintEmptyReason({ intents: [] }), null);
  assert.equal(hintEmptyReason(null), null);
});

test('nothing was measured is said only once the goal has landed work, never before anything shipped', () => {
  const plan = { originRef: GOAL, watchHint: { none: 'A copy change.' } } as unknown as Plan;
  const landing: GoalLanding = {
    prNumber: 40,
    goalRef: GOAL,
    sha: 'abc',
    recordedAt: '2026-11-01T00:00:00.000Z',
    onIntegration: true,
    mergedAt: null,
  };
  const outcomes = (landings: GoalLanding[]): WatchOutcome[] =>
    buildGoalWatchOutcomes(
      [OPEN],
      { goalWatches: () => [], watchWindows: () => [], plans: [plan], watchPlanRecords: () => [] },
      { listGoalLandings: () => landings },
    );
  assert.deepEqual(outcomes([]), [], 'a plan that said none, before anything merged, has no outcome yet');
  assert.deepEqual(outcomes([{ ...landing, goalRef: 'issue:99' }]), [], 'another goal’s landing is not this one’s');
  assert.deepEqual(
    outcomes([landing]).map((o) => [o.outcome, o.reason]),
    [['none', 'A copy change.']],
  );
});

test('the assessor’s stated none is the reason; an owed watch on landed work reads not yet written', () => {
  const landing: GoalLanding = {
    prNumber: 40,
    goalRef: GOAL,
    sha: 'abc',
    recordedAt: '2026-11-01T00:00:00.000Z',
    onIntegration: true,
    mergedAt: null,
  };
  const record: WatchPlanRecord = {
    goalRef: GOAL,
    authoredAt: '2026-11-02T00:00:00.000Z',
    note: 'A refactor.',
    emptyReason: 'Nothing running behaves differently.',
    acceptedAt: null,
    sentBackWords: null,
  };
  const owed: WatchPlanRecord = { ...record, authoredAt: null, note: null, emptyReason: null };
  const outcomes = (hint: Plan['watchHint'], records: WatchPlanRecord[], landings: GoalLanding[]) =>
    buildGoalWatchOutcomes(
      [OPEN],
      {
        goalWatches: () => [],
        watchWindows: () => [],
        plans: [{ originRef: GOAL, watchHint: hint } as unknown as Plan],
        watchPlanRecords: () => records,
      },
      { listGoalLandings: () => landings },
    ).map((o) => [o.outcome, o.headline, o.reason, o.discussable]);
  const intents = { intents: [] } as unknown as Plan['watchHint'];
  assert.deepEqual(outcomes({ none: 'A copy change.' }, [record], [landing]), [
    ['none', 'Nothing was measured', 'Nothing running behaves differently.', false],
  ]);
  assert.deepEqual(outcomes(intents, [owed], [landing]), [['unwritten', 'Not yet written', null, false]]);
  assert.deepEqual(outcomes(intents, [owed], []), [], 'an owed watch before anything merged has no outcome yet');
  assert.deepEqual(outcomes(intents, [], [landing]), [], 'a watch never asked for is not owed, and reads nothing');
  assert.deepEqual(
    outcomes(intents, [{ ...owed, sentBackWords: 'Too broad.' }], [landing]),
    [['unwritten', 'Not yet written', null, false]],
    'a watch sent back is owed again',
  );
  assert.deepEqual(
    outcomes(intents, [{ ...record, emptyReason: null }], [landing]),
    [],
    'a proposed set has no live checks yet and is not owed',
  );
});

test('a before read on another environment says so; the same environment reads as it did', () => {
  const checks = [check('fails', { dryRunRows: 37, dryRunEnvironment: 'staging' })];
  const windows = [window('liveUk', true)];
  const readings = [reading('liveUk', 'fails', 'regressed', { rows: 2 })];
  const outcome = fold({ checks, windows, readings })!;
  assert.equal(outcome.checks[0]?.beforeEnvironment, 'staging');
  const note = (cs: GoalWatch[]): string =>
    watchOutcomeNote({
      outcome: fold({ checks: cs, windows, readings })!,
      checks: cs,
      windows: resolve(cs, windows, readings),
      environments: [],
      pullRequests: [],
    });
  assert.match(note(checks), /37 on staging before the merge → 2 on liveUk over 48h/);
  const same = [check('fails', { dryRunRows: 37, dryRunEnvironment: 'liveUk' })];
  assert.match(note(same), /\*\*Before → after:\*\* 37 → 2 on liveUk over 48h/);
});

test('a window under an hour is spanned in minutes, never over 0h', () => {
  const short: WatchWindow = {
    ...window('liveUk', true),
    openedAt: '2026-11-03T00:00:00.000Z',
    settledAt: '2026-11-03T00:20:00.000Z',
  };
  const outcome = fold({ checks: [check('a')], windows: [short], readings: [reading('liveUk', 'a', 'clean')] });
  assert.equal(outcome?.checks[0]?.windowSpan, '20m');
});

test('another goal’s checks and readings never reach the fold', () => {
  const outcome = fold({
    checks: [check('a'), check('x', { originRef: 'issue:99' })],
    windows: [window('liveUk', true)],
    readings: [reading('liveUk', 'a', 'clean'), { ...reading('liveUk', 'x', 'regressed'), goalRef: 'issue:99' }],
  });
  assert.equal(outcome?.outcome, 'worked');
  assert.equal(outcome.checks.length, 1);
});

test('the note carries the outcome, each expectation, before and after, the query in its language and the merged PRs', () => {
  const checks = [
    check('p95', { kind: 'measure', title: 'BuildStatement p95', expectUnder: 1500, unit: 'ms', baselineValue: 1840 }),
  ];
  const windows = [window('liveUk', true)];
  const readings = [reading('liveUk', 'p95', 'regressed', { value: 2100, detail: 'too slow' })];
  const outcome = fold({ checks, windows, readings })!;
  const note = watchOutcomeNote({
    outcome,
    checks,
    windows: resolve(checks, windows, readings),
    environments: [
      {
        name: 'liveUk',
        at: 'echo',
        watch: {
          sources: {
            db: { observe: 'x', language: 'sql', runBy: 'harness', queryUrl: 'https://db.example/?q={query}' },
          },
        },
      },
    ],
    pullRequests: [
      { number: 40, title: 'Index the statement table' },
      { number: 41, title: null },
    ],
  });
  assert.match(note, /It made something worse/);
  assert.match(note, /\*\*Expected:\*\* under 1500 ms/);
  assert.match(note, /1840 ms → 2100 ms on liveUk over 48h/);
  assert.match(note, /```sql\n/);
  assert.match(note, /datetime\(2026-11-01T00:00:00.000Z\)/, 'the query carries the window it was read over');
  assert.match(note, /datetime\(2026-11-03T00:00:00.000Z\)/, 'to the moment the window settled');
  assert.match(note, /\[Run it on liveUk ↗\]\(https:\/\/db\.example\/\?q=/);
  assert.match(note, /#40 Index the statement table, #41\./);
});

test('the outcome decides once what is discussed and what is extended', () => {
  const worked = fold({
    checks: [check('a')],
    windows: [window('liveUk', true)],
    readings: [reading('liveUk', 'a', 'clean')],
  });
  assert.equal(worked?.discussable, false);
  assert.deepEqual(worked.extendable, []);
  const unknown = fold({ checks: [check('a')], windows: [window('liveUk', true), window('testUk', false)] });
  assert.equal(unknown?.discussable, true);
  assert.deepEqual(unknown.extendable, ['liveUk'], 'only a settled window is extended');
  assert.equal(unknown.headline, 'Couldn’t tell');
});

const OPEN: EnvironmentConfig = { name: 'testUk', at: 'echo unused', watch: { observe: './telemetry.sh' } };

function build(opts: { discussions: boolean; environments?: EnvironmentConfig[] }): { system: System; folder: string } {
  const root = mkdtempSync(join(tmpdir(), 'lubbdubb-watch-outcome-'));
  const repoRoot = join(root, 'widgets');
  mkdirSync(repoRoot);
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      repoRoot,
      deskRoot: join(root, 'desk'),
      worktreeRoot: join(root, 'wt'),
      heartbeatIntervalMs: 999_999,
      environments: opts.environments ?? [OPEN],
      ...(opts.discussions ? { discussionsDir: join(root, 'notes') } : {}),
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      environmentObserver: new FakeEnvironmentObserver({}),
      environmentProber: new FakeEnvironmentProber(),
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
    },
  );
  return { system, folder: join(root, 'notes', 'widgets') };
}

function settledRegressed(system: System): void {
  system.store.world.setWorldBaseline({
    takenAt: new Date().toISOString(),
    pullRequests: [],
    issues: [
      { id: 'I_12', number: 12, title: 'Statements fail', body: '', labels: [], state: 'open', linkedPrNumber: null },
    ],
  });
  system.store.watches.ingestGoalWatch(GOAL, [{ ...check('fails'), title: 'Statement failures stop' }]);
  system.store.watches.openWatchWindow({
    goalRef: GOAL,
    environment: 'testUk',
    openedAt: new Date(Date.now() - 60_000).toISOString(),
    settlesAt: new Date(Date.now() - 1000).toISOString(),
  });
  system.store.watches.recordWatchReading({
    goalRef: GOAL,
    environment: 'testUk',
    checkId: 'fails',
    verdict: 'regressed',
    rows: 4,
    value: null,
    detail: 'testUk answered 4 rows where the check declared none at all.',
  });
  system.store.watches.settleWatchWindow(GOAL, 'testUk');
}

test('the outcome ships on /api/state per goal', () => {
  const { system } = build({ discussions: false });
  settledRegressed(system);
  const state = buildStateSnapshot(system);
  assert.equal(state.goalWatchOutcomes.find((o) => o.goalRef === GOAL)?.outcome, 'worse');
  system.store.close();
});

test('Discuss in Claude writes one note authored LubbDubb (watch), and no WorldEvent', async () => {
  const { system, folder } = build({ discussions: true });
  settledRegressed(system);
  const before = system.store.world.listWorldEvents().length;
  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'POST', url: '/api/discussions/12/watch-outcome' });
  assert.equal(res.statusCode, 200, res.body);
  const doc = system.discussions.read(12);
  assert.equal(doc?.entries.length, 1);
  const [entry] = doc!.entries;
  assert.equal(entry?.kind, 'note');
  assert.equal(entry?.author, 'LubbDubb (watch)');
  assert.match(entry?.body ?? '', /It made something worse/);
  assert.match(entry?.body ?? '', /```kql\n/);
  assert.ok(doc?.path.startsWith(folder));
  assert.match(readFileSync(doc!.path, 'utf8'), /Statement failures stop/);
  assert.equal(system.store.world.listWorldEvents().length, before, 'a reading is never a WorldEvent');
  await app.close();
  system.store.close();
});

test('Discuss in Claude pressed twice on the same reading writes one note', async () => {
  const { system } = build({ discussions: true });
  settledRegressed(system);
  const { app } = await buildApp(system);
  const first = await app.inject({ method: 'POST', url: '/api/discussions/12/watch-outcome' });
  const second = await app.inject({ method: 'POST', url: '/api/discussions/12/watch-outcome' });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(system.discussions.read(12)?.entries.length, 1, 'the second press is the note already written');
  await app.close();
  system.store.close();
});

test('Discuss in Claude refuses a number the world does not list and no discussion file holds', async () => {
  const { system } = build({ discussions: true });
  settledRegressed(system);
  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'POST', url: '/api/discussions/77/watch-outcome' });
  assert.equal(res.statusCode, 404);
  assert.match(res.body, /holds nothing about #77/);
  assert.equal(system.discussions.read(77), null, 'no untitled story is filed for it');
  await app.close();
  system.store.close();
});

test('Discuss in Claude is refused with discussions off, and for an outcome with nothing to discuss', async () => {
  const off = build({ discussions: false });
  settledRegressed(off.system);
  const offApp = (await buildApp(off.system)).app;
  const refused = await offApp.inject({ method: 'POST', url: '/api/discussions/12/watch-outcome' });
  assert.equal(refused.statusCode, 409);
  assert.match(refused.body, /discussionsDir/);
  await offApp.close();
  off.system.store.close();

  const on = build({ discussions: true });
  on.system.store.world.setWorldBaseline({
    takenAt: new Date().toISOString(),
    pullRequests: [],
    issues: [
      { id: 'I_12', number: 12, title: 'Statements fail', body: '', labels: [], state: 'open', linkedPrNumber: null },
    ],
  });
  const app = (await buildApp(on.system)).app;
  const nothing = await app.inject({ method: 'POST', url: '/api/discussions/12/watch-outcome' });
  assert.equal(nothing.statusCode, 409);
  assert.equal(on.system.discussions.read(12), null, 'a refusal writes no file');
  await app.close();
  on.system.store.close();
});

for (const holds of [undefined, ['close_out' as const]]) {
  test(`the outcome changes no hold, with holds ${holds === undefined ? 'absent' : 'present'}`, async () => {
    const environment: EnvironmentConfig = { ...OPEN, watch: { ...OPEN.watch!, ...(holds ? { holds } : {}) } };
    const { system } = build({ discussions: true, environments: [environment] });
    settledRegressed(system);
    system.store.verdicts.recordDelivery({ originRef: GOAL, summary: 'PR #40 landed it', by: 'assessor' });
    const cleared = (): ReadonlySet<string> | null =>
      watchClearedGoals('close_out', [environment], system.store.watches.listWatchWindows(), [], () => []);
    const windowsBefore = system.store.watches.listWatchWindows();
    const clearedBefore = cleared();
    const delivery = system.store.verdicts.getDelivery(GOAL);

    buildStateSnapshot(system);
    const { app } = await buildApp(system);
    const res = await app.inject({ method: 'POST', url: '/api/discussions/12/watch-outcome' });
    assert.equal(res.statusCode, 200, res.body);

    assert.deepEqual(system.store.watches.listWatchWindows(), windowsBefore);
    assert.deepEqual(cleared(), clearedBefore);
    assert.deepEqual(system.store.verdicts.getDelivery(GOAL), delivery, 'the delivery verdict is untouched');
    await app.close();
    system.store.close();
  });
}

test('the outcome card draws no Discuss button without discussionsDir, rather than a disabled one', async () => {
  const { WatchOutcomeCard } = await import('../web/src/console/goalWatchOutcome.js');
  const outcome: WatchOutcome = {
    goalRef: GOAL,
    outcome: 'unknown',
    headline: 'Couldn’t tell',
    discussable: true,
    extendable: ['liveUk'],
    checks: [
      {
        checkId: 'a',
        title: 'Job X stops timing out',
        kind: 'signal',
        verdict: 'unknown',
        environment: null,
        before: 37,
        beforeEnvironment: null,
        after: null,
        unit: null,
        windowSpan: null,
        reason: 'liveUk: the window settled without ever reading it',
      },
    ],
    reason: null,
    watching: [],
  };
  const draw = (discussions: boolean): string =>
    renderToStaticMarkup(
      createElement(WatchOutcomeCard, {
        outcome,
        issueNumber: 12,
        discussions,
        desktopFolder: '/repo',
        actions: {} as never,
      }),
    );
  const on = draw(true);
  assert.match(on, /Couldn’t tell/);
  assert.match(on, /window settled without ever reading it/);
  assert.match(on, /extend liveUk/);
  assert.match(on, /Discuss in Claude/);
  assert.match(
    on,
    /<a [^>]*href="claude:\/\/code\/new\?[^"]*lubbdubb%3Adiscuss\+12/,
    'a real link, so the deep link opens inside the click itself',
  );
  assert.doesNotMatch(draw(false), /Discuss in Claude/);
  assert.doesNotMatch(
    renderToStaticMarkup(
      createElement(WatchOutcomeCard, {
        outcome: {
          ...outcome,
          outcome: 'worked',
          headline: 'It worked',
          discussable: false,
          extendable: [],
          checks: [{ ...outcome.checks[0]!, verdict: 'clean' }],
        },
        issueNumber: 12,
        discussions: true,
        desktopFolder: '/repo',
        actions: {} as never,
      }),
    ),
    /Discuss in Claude/,
    'a watch that worked has nothing to discuss',
  );
});
