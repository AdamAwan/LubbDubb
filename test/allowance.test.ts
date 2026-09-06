import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { buildAllowanceInsights } from '../src/allowanceInsights.js';
import type { AllowanceInsights } from '../src/allowanceInsights.js';
import type { AccountRateLimits, Agent, TaskSummary, UsageEvent, WorldEvent } from '../src/types.js';
import type { SpendGoal } from '../src/spendInsights.js';
import type { InsightsWindowView } from '../src/insightsWindow.js';

const T0 = Date.parse('2026-08-27T12:00:00.000Z');
const iso = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

function reading(minutes: number, fiveHour: number | null, sevenDay: number | null = null): AccountRateLimits {
  return {
    fiveHour: fiveHour === null ? null : { usedPercentage: fiveHour, resetsAt: null },
    sevenDay: sevenDay === null ? null : { usedPercentage: sevenDay, resetsAt: null },
    capturedAt: iso(minutes),
  };
}

test('every reading is kept, not just the freshest', () => {
  const store = new Store(':memory:');
  store.recordRateLimits(reading(0, 10));
  store.recordRateLimits(reading(5, 20));
  store.recordRateLimits(reading(10, 30));
  const kept = store.listRateLimitReadingsSince(iso(-1));
  assert.deepEqual(
    kept.map((r) => r.fiveHour?.usedPercentage),
    [10, 20, 30],
  );
  assert.equal(store.readRateLimits()?.fiveHour?.usedPercentage, 30);
  store.close();
});

test('a reading that arrives late is kept, though it never becomes the chip', () => {
  const store = new Store(':memory:');
  store.recordRateLimits(reading(0, 10));
  store.recordRateLimits(reading(10, 30));
  store.recordRateLimits(reading(5, 20));
  assert.deepEqual(
    store.listRateLimitReadingsSince(iso(-1)).map((r) => r.fiveHour?.usedPercentage),
    [10, 20, 30],
    'oldest first, with the late reading in its own place rather than at the end',
  );
  assert.equal(store.readRateLimits()?.fiveHour?.usedPercentage, 30, 'the chip still holds the freshest');
  store.close();
});

test('two agents reporting one instant record one reading', () => {
  const store = new Store(':memory:');
  store.recordRateLimits(reading(0, 42));
  store.recordRateLimits(reading(0, 42));
  assert.equal(store.listRateLimitReadingsSince(iso(-1)).length, 1);
  store.close();
});

test('the readings survive a restart, as the chip does', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'lubbdubb-allowance-')), 'db.sqlite');
  const store = new Store(dbPath);
  store.recordRateLimits(reading(0, 10));
  store.recordRateLimits(reading(5, 20));
  store.close();

  const reopened = new Store(dbPath);
  assert.deepEqual(
    reopened.listRateLimitReadingsSince(iso(-1)).map((r) => r.fiveHour?.usedPercentage),
    [10, 20],
  );
  assert.equal(reopened.readRateLimits()?.fiveHour?.usedPercentage, 20);
  reopened.close();
});

const WINDOW: InsightsWindowView = {
  key: 'session',
  label: 'the five-hour window',
  bucketLabel: '15m',
  since: iso(0),
  startsAt: iso(0),
  bucketMs: 900_000,
  buckets: 20,
  session: null,
};

function agent(id: string, taskId: string, from: number, to: number | null, costUsd: number | null): Agent {
  return {
    id,
    taskId,
    status: 'done',
    cwd: '/tmp',
    pid: null,
    waitingReason: null,
    sessionId: null,
    startedAt: iso(from),
    endedAt: to === null ? null : iso(to),
    costUsd,
    inputTokens: costUsd === null ? null : 100,
    outputTokens: costUsd === null ? null : 20,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: costUsd === null ? null : 3,
  } as Agent;
}

function task(id: string, originRef: string): TaskSummary {
  return { id, originRef, title: `work on ${originRef}` } as TaskSummary;
}

function goal(issueNumber: number, costUsd: number): SpendGoal {
  return {
    originRef: `issue:${issueNumber}`,
    issueNumber,
    costUsd,
    inputTokens: 0,
    outputTokens: 0,
    agents: 1,
    localRuns: 0,
    title: `goal ${issueNumber}`,
    byPhase: {} as SpendGoal['byPhase'],
    lastAt: null,
  };
}

function usage(agentId: string, minutes: number, costUsd: number): UsageEvent {
  return { agentId, costUsd, at: iso(minutes) };
}

function build(over: Partial<Parameters<typeof buildAllowanceInsights>[0]> = {}): AllowanceInsights {
  return buildAllowanceInsights({
    readings: [],
    weekReadings: [],
    usageEvents: [],
    costDeltas: [],
    agents: [],
    tasks: [],
    nodes: [],
    goals: [],
    attribution: new Map(),
    mergeEvents: [],
    window: WINDOW,
    now: T0 + 300 * 60_000,
    ...over,
  });
}

test('the rise is split between the goals that were spending while it happened', () => {
  const insights = build({
    readings: [reading(0, 40), reading(10, 50), reading(20, 60)],
    usageEvents: [usage('a', 5, 4), usage('a', 15, 3), usage('b', 15, 1)],
    costDeltas: [
      { costUsd: 4, at: iso(5) },
      { costUsd: 3, at: iso(15) },
      { costUsd: 1, at: iso(15) },
    ],
    agents: [agent('a', 't1', 0, 20, 7), agent('b', 't2', 12, 20, 1)],
    tasks: [task('t1', 'issue:1'), task('t2', 'issue:2')],
    goals: [goal(1, 7), goal(2, 1)],
    attribution: new Map([
      ['a', 1],
      ['b', 2],
    ]),
  });

  const { apportionment } = insights;
  assert.equal(apportionment.observedPoints, 20, 'two ten-point steps');
  assert.equal(apportionment.goals.find((g) => g.issueNumber === 1)?.points, 17.5);
  assert.equal(apportionment.goals.find((g) => g.issueNumber === 2)?.points, 2.5);
  assert.equal(apportionment.unattributedPoints, 0);
  assert.equal(apportionment.attributedPoints + apportionment.unattributedPoints, apportionment.observedPoints);
});

test('a rise with no fleet spend under it is charged to nobody', () => {
  const insights = build({
    readings: [reading(0, 40), reading(10, 50), reading(80, 54)],
    usageEvents: [usage('a', 5, 4)],
    costDeltas: [{ costUsd: 4, at: iso(5) }],
    agents: [agent('a', 't1', 0, 10, 4)],
    tasks: [task('t1', 'issue:1')],
    goals: [goal(1, 4)],
    attribution: new Map([['a', 1]]),
  });

  assert.equal(insights.apportionment.observedPoints, 14, 'the rise across the idle stretch still happened');
  assert.equal(insights.apportionment.goals.find((g) => g.issueNumber === 1)?.points, 10);
  assert.equal(insights.apportionment.unattributedPoints, 4);
});

test('a window reset is a boundary, never a negative', () => {
  const insights = build({
    readings: [reading(0, 80), reading(10, 95), reading(20, 5), reading(30, 15)],
    usageEvents: [usage('a', 5, 1), usage('a', 25, 1)],
    costDeltas: [
      { costUsd: 1, at: iso(5) },
      { costUsd: 1, at: iso(25) },
    ],
    agents: [agent('a', 't1', 0, 30, 2)],
    tasks: [task('t1', 'issue:1')],
    goals: [goal(1, 2)],
    attribution: new Map([['a', 1]]),
  });

  assert.equal(insights.apportionment.observedPoints, 25, '15 before the reset and 10 after, not 15 - 90 + 10');
  assert.equal(insights.apportionment.goals.find((g) => g.issueNumber === 1)?.points, 25);
});

test('local-run money dilutes a goal’s share rather than inflating it', () => {
  const insights = build({
    readings: [reading(0, 40), reading(10, 60)],
    usageEvents: [usage('a', 5, 5)],
    costDeltas: [
      { costUsd: 5, at: iso(5) },
      { costUsd: 5, at: iso(6) },
    ],
    agents: [agent('a', 't1', 0, 10, 5)],
    tasks: [task('t1', 'issue:1')],
    goals: [goal(1, 5)],
    attribution: new Map([['a', 1]]),
  });

  assert.equal(insights.apportionment.goals.find((g) => g.issueNumber === 1)?.points, 10, 'half the rise, not all');
  assert.equal(insights.apportionment.unattributedPoints, 10);
});

test('one reading is a level rather than a change', () => {
  assert.equal(build({ readings: [reading(0, 40)] }).apportionment.observedPoints, null);
  assert.equal(build().apportionment.observedPoints, null);
});

test('a goal that landed nothing gets no ratio, and says so', () => {
  const merge = (ref: string): WorldEvent =>
    ({ id: ref, kind: 'pr_merged', ref, summary: 'merged', createdAt: iso(15) }) as WorldEvent;
  const insights = build({
    readings: [reading(0, 40), reading(10, 60)],
    usageEvents: [usage('a', 5, 5), usage('b', 5, 5)],
    costDeltas: [
      { costUsd: 5, at: iso(5) },
      { costUsd: 5, at: iso(5) },
    ],
    agents: [agent('a', 't1', 0, 10, 5), agent('b', 't2', 0, 10, 5)],
    tasks: [task('t1', 'issue:1'), task('t2', 'issue:2')],
    goals: [goal(1, 5), goal(2, 5)],
    attribution: new Map([
      ['a', 1],
      ['b', 2],
    ]),
    nodes: [{ ref: 'pr:9', parentRef: 'issue:1' }],
    mergeEvents: [merge('pr:9')],
  });

  const first = insights.apportionment.goals.find((g) => g.issueNumber === 1);
  const second = insights.apportionment.goals.find((g) => g.issueNumber === 2);
  assert.equal(first?.landed, 1);
  assert.equal(first?.pointsPerLanded, 10);
  assert.equal(second?.landed, 0);
  assert.equal(second?.pointsPerLanded, null);
});

test('a gap is marked for the drawing but still counted in the total', () => {
  const insights = build({ readings: [reading(0, 40), reading(5, 45), reading(80, 60)] });
  assert.deepEqual(
    insights.readings.map((r) => r.afterGap),
    [false, false, true],
  );
  assert.equal(insights.apportionment.observedPoints, 20, 'the rise across the gap is real');
});

test('a reset is marked so the line breaks rather than drawing a cliff', () => {
  const insights = build({ readings: [reading(0, 90), reading(5, 95), reading(10, 4)] });
  assert.deepEqual(
    insights.readings.map((r) => r.afterReset),
    [false, false, true],
  );
});

test('an unmeasured run still gets a lane', () => {
  const insights = build({
    readings: [reading(0, 40), reading(10, 50)],
    agents: [agent('pty', 't1', 0, 10, null)],
    tasks: [task('t1', 'issue:1')],
    attribution: new Map([['pty', 1]]),
  });
  assert.equal(insights.lanes.length, 1);
  assert.equal(insights.lanes[0]?.measured, false);
  assert.equal(insights.apportionment.unattributedPoints, 10, 'it spent nothing this harness can see');
});

test('the weekly projection is fitted from the last reset, not across it', () => {
  const now = T0 + 300 * 60_000;
  const at = (minutesBeforeNow: number, sevenDay: number): AccountRateLimits => ({
    fiveHour: null,
    sevenDay: { usedPercentage: sevenDay, resetsAt: new Date(now + 10 * 3_600_000).toISOString() },
    capturedAt: new Date(now - minutesBeforeNow * 60_000).toISOString(),
  });
  const insights = build({
    now,
    weekReadings: [at(600, 80), at(500, 95), at(400, 5), at(300, 20), at(200, 35), at(100, 50)],
  });

  const p = insights.projection;
  assert.ok(p !== null);
  assert.equal(p.usedPercentage, 50);
  assert.equal(p.fittedFrom, 4, 'only the readings from the reset onwards');
  assert.ok(p.ratePerHour !== null && Math.abs(p.ratePerHour - 9) < 0.5);
  assert.equal(p.beforeReset, true);
});

test('a flat week projects no exhaustion at all', () => {
  const now = T0 + 300 * 60_000;
  const flat = (minutesBeforeNow: number): AccountRateLimits => ({
    fiveHour: null,
    sevenDay: { usedPercentage: 30, resetsAt: new Date(now + 10 * 3_600_000).toISOString() },
    capturedAt: new Date(now - minutesBeforeNow * 60_000).toISOString(),
  });
  const p = build({ now, weekReadings: [flat(300), flat(200), flat(100)] }).projection;
  assert.equal(p?.ratePerHour, null);
  assert.equal(p?.exhaustsAt, null);
  assert.equal(p?.beforeReset, null);
});

test('an account that reports no weekly window gets no burn-down', () => {
  assert.equal(build({ weekReadings: [reading(0, 40), reading(10, 50)] }).projection, null);
});
