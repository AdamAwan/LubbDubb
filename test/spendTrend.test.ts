import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSpendTrend } from '../src/spendTrend.js';
import { zeroPhases, type SpendGoal, type SpendPhase } from '../src/spendInsights.js';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { gitRepo } from './support/gitRepo.js';
import type { Agent, Issue, TrackerItem, WorldEvent } from '../src/types.js';
import type { TicketClosure } from '../src/store/tickets.js';
import type { SpendTrendPayload } from '../src/wire.js';
import { resolveWindow } from '../src/insightsWindow.js';

/**
 * The trend behind the breakdown. What it has to get right is not the arithmetic
 * but the four claims the panel makes on top of it:
 *
 * - a goal lands in the week it **closed**, and carries spend from whenever that
 *   spend happened;
 * - the current week is marked partial, and is kept out of the comparison — an
 *   under-counted recent half is what makes a fleet look like it improved on the
 *   day it was read;
 * - the phase split is **per goal**, so a busy week does not read as an expensive
 *   one;
 * - a goal that closed and is open again is counted as reopened, which is the one
 *   reading that can contradict the other two.
 *
 * The cohort is the **ticket mirror's** closed rows and not `issue_closed` world
 * events, which never fire on a real provider — both snapshot the open set, so a
 * closed item leaves the world without a transition being seen. The route case at
 * the bottom asserts that end to end, on a store with no world events at all.
 */

const NOW = Date.parse('2026-08-16T12:00:00.000Z');
const WEEK = 7 * 24 * 60 * 60 * 1000;

/** An instant inside week `index` of the eight, offset a day in so no test sits on a boundary. */
function inWeek(index: number): string {
  return new Date(NOW - 8 * WEEK + index * WEEK + 24 * 60 * 60 * 1000).toISOString();
}

function goal(issueNumber: number, costUsd: number, byPhase: Partial<Record<SpendPhase, number>> = {}): SpendGoal {
  return {
    originRef: `issue:${issueNumber}`,
    issueNumber,
    costUsd,
    localRuns: 0,
    inputTokens: costUsd * 1000,
    outputTokens: costUsd * 10,
    agents: 2,
    title: `Goal ${issueNumber}`,
    // Defaults to the whole cost as build, so a test that does not care about the
    // split still has one that sums to the goal.
    byPhase: { ...zeroPhases(), build: costUsd, ...byPhase },
    lastAt: inWeek(0),
  };
}

/** A closure as the ticket mirror hands it over: a goal, and when it last changed. */
function closed(issueNumber: number, at: string): TicketClosure {
  return { number: issueNumber, closedAt: at };
}

function red(prNumber: number, at: string): WorldEvent {
  return {
    id: `we_ci_${prNumber}_${at}`,
    kind: 'pr_ci',
    ref: `pr:${prNumber}`,
    summary: `PR #${prNumber} CI failing`,
    createdAt: at,
  };
}

function issue(number: number, state: 'open' | 'closed'): Issue {
  return { id: `i${number}`, number, title: `Goal ${number}`, body: '', labels: [], state, linkedPrNumber: null };
}

function agent(id: string, over: Partial<Agent> = {}): Agent {
  return {
    id,
    taskId: `task_${id}`,
    status: 'done',
    cwd: `/wt/${id}`,
    pid: 1,
    waitingReason: null,
    sessionId: null,
    startedAt: inWeek(0),
    endedAt: inWeek(0),
    costUsd: 1,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: 3,
    note: null,
    notedAt: null,
    resumedAt: null,
    resumeAttempts: 0,
    ...over,
  };
}

function build(over: {
  goals?: SpendGoal[];
  closures?: TicketClosure[];
  issues?: Issue[];
  agents?: Agent[];
  ciEvents?: WorldEvent[];
}) {
  return buildSpendTrend({
    goals: over.goals ?? [],
    closures: over.closures ?? [],
    issues: over.issues ?? [],
    agents: over.agents ?? [],
    ciEvents: over.ciEvents ?? [],
    // A weekly period, so the axis is the eight weeks these fixtures were
    // written against — the span is a parameter now and a test that named none
    // would assert whatever the default happened to be.
    window: resolveWindow('7d', NOW, null),
    now: NOW,
  });
}

test('a goal lands in the week it closed, whenever its money was spent', () => {
  // Both goals ran at the same time; only their closures differ. The whole unit
  // choice rests on this: cost follows the goal, not the calendar it was billed in.
  const trend = build({
    goals: [goal(1, 6), goal(2, 10)],
    closures: [closed(1, inWeek(1)), closed(2, inWeek(5))],
  });

  assert.equal(trend.buckets.length, 8);
  assert.equal(trend.buckets[1]?.goalsClosed, 1);
  assert.equal(trend.buckets[1]?.medianCostUsd, 6);
  assert.equal(trend.buckets[5]?.goalsClosed, 1);
  assert.equal(trend.buckets[5]?.medianCostUsd, 10);
  // Every other week is a row with zeroes, not a gap — the axis is eight weeks
  // whether or not anything closed in them.
  assert.equal(trend.buckets[0]?.goalsClosed, 0);
  assert.equal(trend.buckets[0]?.medianCostUsd, null);
});

test('the phase split is per goal, so a busy week is not an expensive one', () => {
  const trend = build({
    goals: [
      goal(1, 10, { deliberation: 2, build: 8 }),
      goal(2, 10, { deliberation: 4, build: 6 }),
      goal(3, 10, { deliberation: 6, build: 4 }),
    ],
    closures: [closed(1, inWeek(2)), closed(2, inWeek(2)), closed(3, inWeek(2))],
  });

  const week = trend.buckets[2];
  assert.equal(week?.goalsClosed, 3);
  // The mean per goal — 12 deliberation over three goals — and not the cohort's
  // $12 total, which would make three cheap goals look like one expensive one.
  assert.equal(week?.byPhase.deliberation, 4);
  assert.equal(week?.byPhase.build, 6);
  assert.equal(week?.medianCostUsd, 10);
});

test('the spread ships with the median, ascending', () => {
  const trend = build({
    goals: [goal(1, 9), goal(2, 2), goal(3, 40), goal(4, 5)],
    closures: [closed(1, inWeek(3)), closed(2, inWeek(3)), closed(3, inWeek(3)), closed(4, inWeek(3))],
  });

  const week = trend.buckets[3];
  assert.deepEqual(week?.costs, [2, 5, 9, 40]);
  // The middle, so the $40 outlier does not carry the week — which is the whole
  // reason this is a median and the points are drawn beside it.
  assert.equal(week?.medianCostUsd, 9);
});

test('the current week is partial, and is left out of the comparison', () => {
  const trend = build({
    // A cheap goal in the week still filling. If it were folded into the recent
    // half it would drag the median down and report an improvement that is really
    // a week that has not finished.
    goals: [goal(1, 10), goal(2, 10), goal(3, 10), goal(4, 10), goal(5, 1)],
    closures: [
      closed(1, inWeek(0)),
      closed(2, inWeek(1)),
      closed(3, inWeek(5)),
      closed(4, inWeek(6)),
      closed(5, inWeek(7)),
    ],
  });

  assert.equal(trend.buckets[7]?.partial, true);
  assert.equal(trend.buckets[6]?.partial, false);
  assert.equal(trend.buckets[7]?.goalsClosed, 1);

  const { comparison } = trend;
  assert.ok(comparison);
  // Seven complete weeks, so three either side and the middle one dropped.
  assert.equal(comparison.earlier.weeks, 3);
  assert.equal(comparison.recent.weeks, 3);
  assert.equal(comparison.recent.goalsClosed, 2);
  assert.equal(comparison.recent.medianCostUsd, 10);
});

test('the comparison is withheld rather than drawn off one week a side', () => {
  // One goal on the whole axis. The window's *shape* clears the floor — it always
  // does, since the axis is a fixed eight buckets whatever the data — so the count
  // that decides is of weeks that closed something, and this has one.
  const thin = build({
    goals: [goal(1, 10)],
    closures: [closed(1, inWeek(6))],
  });
  assert.equal(thin.comparison, null);

  // One populated week on each side is still one week a side.
  const oneEach = build({
    goals: [goal(1, 10), goal(2, 20)],
    closures: [closed(1, inWeek(1)), closed(2, inWeek(6))],
  });
  assert.equal(oneEach.comparison, null);

  // Two either side is the floor, and it is cleared.
  const enough = build({
    goals: [goal(1, 10), goal(2, 10), goal(3, 20), goal(4, 20)],
    closures: [closed(1, inWeek(0)), closed(2, inWeek(1)), closed(3, inWeek(4)), closed(4, inWeek(5))],
  });
  assert.ok(enough.comparison);
  assert.equal(enough.comparison.earlier.goalsClosed, 2);
  assert.equal(enough.comparison.recent.goalsClosed, 2);
});

test('the last closure wins, so a goal that came back and landed again counts once', () => {
  const trend = build({
    goals: [goal(1, 8)],
    closures: [closed(1, inWeek(1)), closed(1, inWeek(4))],
  });

  assert.equal(trend.buckets[1]?.goalsClosed, 0);
  assert.equal(trend.buckets[4]?.goalsClosed, 1);
});

test('a goal that closed and is open again is counted as reopened', () => {
  const trend = build({
    goals: [goal(1, 8), goal(2, 8)],
    closures: [closed(1, inWeek(2)), closed(2, inWeek(2))],
    // The world diff has no closed-to-open transition to emit, so this is read
    // from the world as it stands: closed inside the window, open now.
    issues: [issue(1, 'open'), issue(2, 'closed')],
  });

  assert.equal(trend.buckets[2]?.goalsClosed, 2);
  assert.equal(trend.buckets[2]?.reopened, 1);
});

test('a goal that closed with no measured spend is counted apart, not as free', () => {
  const trend = build({
    goals: [goal(1, 8)],
    closures: [closed(1, inWeek(2)), closed(99, inWeek(2))],
  });

  const week = trend.buckets[2];
  assert.equal(week?.goalsClosed, 1);
  assert.equal(week?.goalsUnmeasured, 1);
  // In no figure: a median over "one goal at $8 and one at nothing" would report
  // a fleet half as expensive as it is.
  assert.equal(week?.medianCostUsd, 8);
  assert.deepEqual(week?.costs, [8]);
});

test('runs settle into the week they ended, and reds are counted per goal delivered', () => {
  const trend = build({
    goals: [goal(1, 8), goal(2, 8)],
    closures: [closed(1, inWeek(3)), closed(2, inWeek(3))],
    agents: [
      agent('a1', { endedAt: inWeek(3) }),
      agent('a2', { endedAt: inWeek(3), status: 'failed', costUsd: 2 }),
      agent('a3', { endedAt: inWeek(3), status: 'crashed', costUsd: 0.5 }),
      // Still out: not an outcome, and in no rate.
      agent('a4', { endedAt: null, status: 'running' }),
      agent('a5', { endedAt: inWeek(6) }),
    ],
    ciEvents: [red(41, inWeek(3)), red(41, inWeek(3)), red(42, inWeek(3)), red(43, inWeek(6))],
  });

  const week = trend.buckets[3];
  assert.equal(week?.settled, 3);
  assert.equal(week?.completed, 1);
  assert.equal(week?.completionRate, 1 / 3);
  assert.equal(week?.lostCostUsd, 2.5);
  assert.equal(week?.reds, 3);
  // Three reds against two goals delivered that week.
  assert.equal(week?.redsPerGoal, 1.5);

  // A week with reds and no closures has no rate to report — nothing to divide by
  // is a different answer from zero.
  assert.equal(trend.buckets[6]?.reds, 1);
  assert.equal(trend.buckets[6]?.redsPerGoal, null);
});

test('a passing check is not a red', () => {
  const trend = build({
    goals: [goal(1, 8)],
    closures: [closed(1, inWeek(3))],
    ciEvents: [
      red(41, inWeek(3)),
      { id: 'we_g', kind: 'pr_ci', ref: 'pr:41', summary: 'PR #41 CI passing', createdAt: inWeek(3) },
    ],
  });

  assert.equal(trend.buckets[3]?.reds, 1);
});

test('the phase shift carries dollars and shares, and they can disagree', () => {
  // The reading the whole tab exists for: deliberation's share rises while its
  // dollars fall, because everything around it fell further. A share column alone
  // would report that as a regression.
  const trend = build({
    goals: [
      goal(1, 20, { deliberation: 4, build: 10, ci: 6 }),
      goal(2, 20, { deliberation: 4, build: 10, ci: 6 }),
      goal(3, 10, { deliberation: 3, build: 5, ci: 2 }),
      goal(4, 10, { deliberation: 3, build: 5, ci: 2 }),
    ],
    closures: [closed(1, inWeek(0)), closed(2, inWeek(1)), closed(3, inWeek(5)), closed(4, inWeek(6))],
  });

  const { comparison } = trend;
  assert.ok(comparison);
  const deliberation = comparison.phases.find((p) => p.phase === 'deliberation');
  assert.ok(deliberation);
  assert.equal(deliberation.earlierUsd, 4);
  assert.equal(deliberation.recentUsd, 3);
  // Dollars down a quarter…
  assert.equal(deliberation.changeRatio, -0.25);
  // …and share *up*, from a fifth of a $20 goal to three tenths of a $10 one.
  assert.equal(deliberation.earlierShare, 0.2);
  assert.equal(deliberation.recentShare, 0.3);

  const ci = comparison.phases.find((p) => p.phase === 'ci');
  assert.equal(ci?.earlierUsd, 6);
  assert.equal(ci?.recentUsd, 2);
});

test('a period median is the middle goal, never a median of weekly medians', () => {
  const trend = build({
    // Two weeks in the recent half: one closed a single $100 goal, the other
    // closed five cheap ones. Pooling the weeks' own medians — $100 and $2 —
    // would report $100; the middle of the six actual goals is $3.
    // Goals 7 and 8 are only there to give the earlier half the two populated
    // weeks the comparison is withheld below; the reading under test is `recent`.
    goals: [goal(1, 100), goal(2, 1), goal(3, 1), goal(4, 2), goal(5, 3), goal(6, 3), goal(7, 9), goal(8, 9)],
    closures: [
      closed(1, inWeek(5)),
      closed(2, inWeek(6)),
      closed(3, inWeek(6)),
      closed(4, inWeek(6)),
      closed(5, inWeek(6)),
      closed(6, inWeek(6)),
      closed(7, inWeek(0)),
      closed(8, inWeek(1)),
    ],
  });

  const { comparison } = trend;
  assert.ok(comparison);
  assert.equal(comparison.recent.goalsClosed, 6);
  // The upper of the two middles, which is what `median` is documented to take.
  assert.equal(comparison.recent.medianCostUsd, 3);
});

test('a closure older than the window is dropped rather than clamped into week one', () => {
  const trend = build({
    goals: [goal(1, 50)],
    closures: [closed(1, new Date(NOW - 12 * WEEK).toISOString())],
  });

  assert.equal(
    trend.buckets.reduce((n, w) => n + w.goalsClosed, 0),
    0,
  );
  // A spike drawn on week one that nothing closed there is worse than a gap.
  assert.equal(trend.buckets[0]?.medianCostUsd, null);
});

/**
 * The route, at the seam. The fold above is a pure function and is tested as
 * one; what this asserts is the wiring — that `/api/spend/trend` exists, answers
 * the payload the cockpit's type names, and draws a full axis on a store that has
 * never closed anything. An empty fleet is the state every new deployment is in,
 * and eight weeks of nulls is the correct answer rather than a 500.
 */
test('the route answers a full axis on a store with nothing in it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const config = loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    repoRoot: gitRepo(),
    heartbeatIntervalMs: 999_999,
    auth: { enabled: false } as never,
  });
  const system = buildSystem(config, { backend: new FakePtyBackend(), errorMirror: () => {} });
  const { app } = await buildApp(system);

  const res = await app.inject({ method: 'GET', url: '/api/spend/trend' });
  assert.equal(res.statusCode, 200);
  const { trend } = res.json() as SpendTrendPayload;

  assert.equal(trend.buckets.length, trend.periods);
  assert.equal(trend.buckets.at(-1)?.partial, true);
  assert.ok(trend.buckets.every((w) => w.goalsClosed === 0 && w.medianCostUsd === null));
  // The axis is full-length, so the halves exist — and they are empty, which is
  // exactly the reading the comparison is withheld for.
  assert.equal(trend.comparison, null);

  await app.close();
  system.store.close();
});

/**
 * The case the old wiring could not pass. The cohort used to be built from
 * `issue_closed` world events, which never fire on a real provider — `diffWorlds`
 * needs an in-place `open → closed` transition and both real issue providers
 * snapshot the open set only, so a closed item leaves `next.issues` and the branch
 * is never reached. Every deployment therefore drew the empty state forever while
 * its tracker mirror held the closures all along.
 *
 * So: closures written to the mirror, **no world events of any kind**, and the
 * trend read through the route it is actually served by.
 */
test('the cohort comes from the ticket mirror, with no issue_closed events anywhere', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const config = loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    repoRoot: gitRepo(),
    heartbeatIntervalMs: 999_999,
    auth: { enabled: false } as never,
  });
  const system = buildSystem(config, { backend: new FakePtyBackend(), errorMirror: () => {} });
  const { store } = system;
  const ago = (weeks: number): string => new Date(Date.now() - weeks * WEEK).toISOString();

  // #7 has spend against it; #8 has none, and must still be counted apart rather
  // than read as a goal that closed for free.
  const task = store.createTask({ kind: 'code', title: 'Goal 7', prompt: 'p', branch: null, originRef: 'issue:7' });
  const worked = store.createAgent({ taskId: task.id, cwd: '/wt/7', pid: null });
  store.recordAgentUsage(worked.id, {
    costUsd: 8,
    inputTokens: 8000,
    outputTokens: 80,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: 3,
  });

  const mirrored = (number: number, changedAt: string): TrackerItem => ({
    number,
    title: `Goal ${number}`,
    labels: [],
    state: 'closed',
    workItemState: 'Closed',
    url: null,
    createdAt: ago(9),
    changedAt,
  });
  store.recordSweep(ago(8), [mirrored(7, ago(3)), mirrored(8, ago(3)), mirrored(9, ago(20))]);

  // The premise, asserted rather than assumed: nothing has ever recorded one.
  assert.equal(store.listWorldEventsOfKindsSince(ago(8), ['issue_closed']).length, 0);

  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'GET', url: '/api/spend/trend' });
  assert.equal(res.statusCode, 200);
  const { trend } = res.json() as SpendTrendPayload;

  assert.equal(
    trend.buckets.reduce((n, w) => n + w.goalsClosed, 0),
    1,
  );
  // The two-tier count survives the new source: #8 closed with nothing recorded,
  // which is what the empty state's "though N closed with none recorded" reads.
  assert.equal(
    trend.buckets.reduce((n, w) => n + w.goalsUnmeasured, 0),
    1,
  );
  // #9 was last changed four months ago and is dropped, not clamped into week one.
  const week = trend.buckets.find((w) => w.goalsClosed > 0);
  assert.equal(week?.medianCostUsd, 8);
  assert.deepEqual(week?.costs, [8]);
  assert.equal(trend.buckets[0]?.goalsClosed, 0);

  await app.close();
  store.close();
});
