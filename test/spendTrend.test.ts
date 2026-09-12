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

const NOW = Date.parse('2026-08-16T12:00:00.000Z');
const WEEK = 7 * 24 * 60 * 60 * 1000;

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
    byPhase: { ...zeroPhases(), build: costUsd, ...byPhase },
    lastAt: inWeek(0),
  };
}

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
    window: resolveWindow('7d', NOW, null),
    now: NOW,
  });
}

test('a goal lands in the week it closed, whenever its money was spent', () => {
  const trend = build({
    goals: [goal(1, 6), goal(2, 10)],
    closures: [closed(1, inWeek(1)), closed(2, inWeek(5))],
  });

  assert.equal(trend.buckets.length, 8);
  assert.equal(trend.buckets[1]?.goalsClosed, 1);
  assert.equal(trend.buckets[1]?.medianCostUsd, 6);
  assert.equal(trend.buckets[5]?.goalsClosed, 1);
  assert.equal(trend.buckets[5]?.medianCostUsd, 10);
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
  assert.equal(week?.medianCostUsd, 9);
});

test('the current week is partial, and is left out of the comparison', () => {
  const trend = build({
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
  assert.equal(comparison.earlier.weeks, 3);
  assert.equal(comparison.recent.weeks, 3);
  assert.equal(comparison.recent.goalsClosed, 2);
  assert.equal(comparison.recent.medianCostUsd, 10);
});

test('the comparison is withheld rather than drawn off one week a side', () => {
  const thin = build({
    goals: [goal(1, 10)],
    closures: [closed(1, inWeek(6))],
  });
  assert.equal(thin.comparison, null);

  const oneEach = build({
    goals: [goal(1, 10), goal(2, 20)],
    closures: [closed(1, inWeek(1)), closed(2, inWeek(6))],
  });
  assert.equal(oneEach.comparison, null);

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
  assert.equal(week?.redsPerGoal, 1.5);

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
  assert.equal(deliberation.changeRatio, -0.25);
  assert.equal(deliberation.earlierShare, 0.2);
  assert.equal(deliberation.recentShare, 0.3);

  const ci = comparison.phases.find((p) => p.phase === 'ci');
  assert.equal(ci?.earlierUsd, 6);
  assert.equal(ci?.recentUsd, 2);
});

test('a period median is the middle goal, never a median of weekly medians', () => {
  const trend = build({
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
  assert.equal(trend.buckets[0]?.medianCostUsd, null);
});

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
  assert.equal(trend.comparison, null);

  await app.close();
  system.store.close();
});

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

  const task = store.tasks.createTask({
    kind: 'code',
    title: 'Goal 7',
    prompt: 'p',
    branch: null,
    originRef: 'issue:7',
  });
  const worked = store.agents.createAgent({ taskId: task.id, cwd: '/wt/7', pid: null });
  store.agents.recordAgentUsage(worked.id, {
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
  store.tickets.recordSweep(ago(8), [mirrored(7, ago(3)), mirrored(8, ago(3)), mirrored(9, ago(20))]);

  assert.equal(store.world.listWorldEventsOfKindsSince(ago(8), ['issue_closed']).length, 0);

  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'GET', url: '/api/spend/trend' });
  assert.equal(res.statusCode, 200);
  const { trend } = res.json() as SpendTrendPayload;

  assert.equal(
    trend.buckets.reduce((n, w) => n + w.goalsClosed, 0),
    1,
  );
  assert.equal(
    trend.buckets.reduce((n, w) => n + w.goalsUnmeasured, 0),
    1,
  );
  const week = trend.buckets.find((w) => w.goalsClosed > 0);
  assert.equal(week?.medianCostUsd, 8);
  assert.deepEqual(week?.costs, [8]);
  assert.equal(trend.buckets[0]?.goalsClosed, 0);

  await app.close();
  store.close();
});
