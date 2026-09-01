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

/**
 * The allowance as a series, and the apportionment over it (issue #431).
 *
 * The reading was already captured; what it was not was *kept* —
 * `account_rate_limits` holds one row and overwrites it on every turn, so a
 * percentage over time and any attribution of it had nothing to be read off.
 *
 * Two halves are asserted here and they fail differently. The store half is about
 * a reading surviving: an append that inherited the chip's freshest-wins guard
 * would silently drop exactly the readings a busy fleet produces most of, and the
 * graph would thin out where the account was moving fastest. The fold half is
 * about a number meaning what it says: the account reports one percentage for the
 * whole fleet, so every per-goal figure here is apportioned, and the ways an
 * apportionment can quietly become a lie — netting a reset against a rise,
 * charging an idle stretch to whoever ran last — are what the cases below name.
 */

const T0 = Date.parse('2026-08-27T12:00:00.000Z');
const iso = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

function reading(minutes: number, fiveHour: number | null, sevenDay: number | null = null): AccountRateLimits {
  return {
    fiveHour: fiveHour === null ? null : { usedPercentage: fiveHour, resetsAt: null },
    sevenDay: sevenDay === null ? null : { usedPercentage: sevenDay, resetsAt: null },
    capturedAt: iso(minutes),
  };
}

// ---------------------------------------------------------------------------
// The store: a reading is kept as well as landed
// ---------------------------------------------------------------------------

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
  // The chip is unchanged by any of it: one row, freshest wins.
  assert.equal(store.readRateLimits()?.fiveHour?.usedPercentage, 30);
  store.close();
});

test('a reading that arrives late is kept, though it never becomes the chip', () => {
  const store = new Store(':memory:');
  store.recordRateLimits(reading(0, 10));
  store.recordRateLimits(reading(10, 30));
  // Agents report interleaved, so a reading queued behind a slow turn lands after
  // a newer one. The chip must not go backwards — and the *series* must not lose
  // the row, which is the whole difference between the two writes. An append that
  // inherited the chip's guard would drop the overlapping turns of a busy fleet,
  // thinning the graph precisely where the account was moving fastest.
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
  // A file rather than `:memory:`, because surviving the process is the whole
  // claim: readings arrive only when an agent takes a turn, so a harness that
  // dropped them on boot would show a paused or idle fleet nothing at all —
  // indefinitely, and with no way to tell that from an account at rest.
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

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

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
    // #1 spends through the first interval alone; the second is shared three to one.
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
  // Ten points from the interval it had to itself, plus three quarters of the next.
  assert.equal(apportionment.goals.find((g) => g.issueNumber === 1)?.points, 17.5);
  assert.equal(apportionment.goals.find((g) => g.issueNumber === 2)?.points, 2.5);
  assert.equal(apportionment.unattributedPoints, 0);
  // The three totals are one partition, however the shares fell.
  assert.equal(apportionment.attributedPoints + apportionment.unattributedPoints, apportionment.observedPoints);
});

test('a rise with no fleet spend under it is charged to nobody', () => {
  // The fleet was idle and the account still moved — the operator's own Claude
  // Code on the same credential. Dividing this among whichever goals happen to be
  // in the window is the one lie the module exists to avoid telling.
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
  // The five-hour window refills four or five times a day. Netting the fall
  // against the rises reports a fleet that spent almost nothing, which is the
  // most plausible-looking wrong number this fold can produce.
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
  // A local run spends on the same account and its dated deltas carry no run id,
  // so it can never name a goal. Leaving it out of the denominator would charge
  // the fleet's goals for an operator's own afternoon.
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
  // Reporting zero here would say the account did not move, when what happened is
  // that nothing watched it.
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
    // The merge reaches goal 1 through the graph; goal 2 landed nothing.
    nodes: [{ ref: 'pr:9', parentRef: 'issue:1' }],
    mergeEvents: [merge('pr:9')],
  });

  const first = insights.apportionment.goals.find((g) => g.issueNumber === 1);
  const second = insights.apportionment.goals.find((g) => g.issueNumber === 2);
  assert.equal(first?.landed, 1);
  assert.equal(first?.pointsPerLanded, 10);
  assert.equal(second?.landed, 0);
  // Null rather than Infinity: a goal that ate a tenth of the account and landed
  // nothing is the most important row the table draws, and it has to render as
  // the sentence it is rather than as a symbol.
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
  // A PTY agent reports no usage, so it is charged nothing — but it was running,
  // which is the only thing a lane claims.
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

// ---------------------------------------------------------------------------
// The burn-down
// ---------------------------------------------------------------------------

test('the weekly projection is fitted from the last reset, not across it', () => {
  const now = T0 + 300 * 60_000;
  const at = (minutesBeforeNow: number, sevenDay: number): AccountRateLimits => ({
    fiveHour: null,
    sevenDay: { usedPercentage: sevenDay, resetsAt: new Date(now + 10 * 3_600_000).toISOString() },
    capturedAt: new Date(now - minutesBeforeNow * 60_000).toISOString(),
  });
  const insights = build({
    now,
    // A full week ending in a refill, then a steep climb on the new allowance. A
    // fit across the fall averages the two and reports days of headroom that do
    // not exist.
    weekReadings: [at(600, 80), at(500, 95), at(400, 5), at(300, 20), at(200, 35), at(100, 50)],
  });

  const p = insights.projection;
  assert.ok(p !== null);
  assert.equal(p.usedPercentage, 50);
  assert.equal(p.fittedFrom, 4, 'only the readings from the reset onwards');
  // 45 points over five hours is 9 an hour, so the remaining 50 take about 5h30 —
  // which is inside the ten hours to the reset.
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
  // A rate of nearly zero arriving in four hundred hours is a date that is worse
  // than no date: it renders, and it is read.
  assert.equal(p?.ratePerHour, null);
  assert.equal(p?.exhaustsAt, null);
  assert.equal(p?.beforeReset, null);
});

test('an account that reports no weekly window gets no burn-down', () => {
  // API-key auth, or a CLI too old to carry one. Degrading to a projection off
  // the five-hour window would answer a question about the week with a figure
  // about the afternoon.
  assert.equal(build({ weekReadings: [reading(0, 40), reading(10, 50)] }).projection, null);
});
