import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpendInsights } from '../src/spendInsights.js';
import type { Agent, Issue, Task, UsageEvent, WorkNode } from '../src/types.js';

/**
 * The breakdown behind the cost indicators. What it has to get right is not the
 * arithmetic — that is a sum — but the two things a second reading of the same
 * money can get wrong: which *phase* an origin belongs to, and whether the goal
 * totals still agree with the card that already shows them.
 */

const T = '2026-08-04T09:00:00.000Z';
const NOW = Date.parse('2026-08-04T12:00:00.000Z');

function agent(id: string, over: Partial<Agent> = {}): Agent {
  return {
    id,
    taskId: `task_${id}`,
    status: 'done',
    cwd: `/wt/${id}`,
    pid: 1,
    waitingReason: null,
    sessionId: null,
    startedAt: T,
    endedAt: T,
    costUsd: 1,
    inputTokens: 1000,
    outputTokens: 100,
    numTurns: 3,
    note: null,
    notedAt: null,
    resumedAt: null,
    ...over,
  };
}

function task(id: string, originRef: string | null, title = `Task ${id}`): Task {
  return {
    id: `task_${id}`,
    kind: 'code',
    title,
    prompt: 'do it',
    branch: null,
    originRef,
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'done',
    agentId: id,
    createdAt: T,
    updatedAt: T,
  };
}

function node(ref: string, parentRef: string | null): WorkNode {
  return {
    ref,
    kind: 'pr',
    parentRef,
    baseRef: null,
    title: ref,
    status: 'open',
    terminal: false,
    provenance: null,
    firstSeenAt: T,
    lastSeenAt: T,
  };
}

function issue(number: number, title: string): Issue {
  return {
    id: `i${number}`,
    number,
    title,
    body: '',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
  };
}

function build(over: {
  agents?: Agent[];
  tasks?: Task[];
  nodes?: WorkNode[];
  issues?: Issue[];
  usageEvents?: UsageEvent[];
}) {
  return buildSpendInsights({
    agents: over.agents ?? [],
    tasks: over.tasks ?? [],
    nodes: over.nodes ?? [],
    issues: over.issues ?? [],
    usageEvents: over.usageEvents ?? [],
    fiveHourCostUsd: 0,
    sevenDayCostUsd: 0,
    now: NOW,
  });
}

/**
 * The whole point of the phase split: a goal's own total folds its planner and
 * its parts into one figure, so "the deliberation cost more than the build" is a
 * question only this can answer. Every origin shape the harness dispatches on is
 * here, including the two that name no issue.
 */
test('every origin shape lands in the phase it belongs to', () => {
  const insights = build({
    agents: [
      agent('a1', { costUsd: 4 }),
      agent('a2', { costUsd: 3 }),
      agent('a3', { costUsd: 2 }),
      agent('a4', { costUsd: 1 }),
      agent('a5', { costUsd: 5 }),
      agent('a6', { costUsd: 6 }),
      agent('a7', { costUsd: 7 }),
      agent('a8', { costUsd: 8 }),
    ],
    tasks: [
      task('a1', 'issue:12:plan'),
      task('a2', 'issue:12:assay'),
      task('a3', 'issue:12'),
      task('a4', 'issue:12:part:auth'),
      task('a5', 'issue:12:assess'),
      task('a6', 'pr:41:ci'),
      task('a7', 'job:sweep'),
      task('a8', null),
    ],
    nodes: [node('pr:41', 'issue:12')],
  });

  const byPhase = new Map(insights.phases.map((p) => [p.phase, p.costUsd]));
  assert.equal(byPhase.get('deliberation'), 7, 'the planner and the assay are deliberation');
  assert.equal(byPhase.get('build'), 3, 'the pickup root and a part are both build');
  assert.equal(byPhase.get('evidence'), 5, 'the assessment is evidence');
  assert.equal(byPhase.get('landing'), 6, "a pull request's own agents are landing");
  assert.equal(byPhase.get('job'), 7, 'an operator job is its own phase');
  assert.equal(byPhase.get('other'), 8, 'an agent dispatched against nothing is unclassified');
  assert.equal(insights.totals.costUsd, 36, 'the phases partition the fleet, so they sum to it');
  assert.deepEqual(
    insights.phases.map((p) => p.phase),
    ['deliberation', 'build', 'landing', 'evidence', 'job', 'other'],
    'phases ship in funnel order regardless of what cost what',
  );
});

/**
 * `landing` is separate from `build` even though both are work on the same code,
 * and this is the reading that separation exists for: a goal whose landing dwarfs
 * its build is a flaky pipeline, not an expensive goal — and the pull request's
 * money still belongs to the goal, which the lineage is what establishes.
 */
test("a pull request's spend joins its goal without joining its build", () => {
  const insights = build({
    agents: [agent('a1', { costUsd: 2 }), agent('a2', { costUsd: 8 })],
    tasks: [task('a1', 'issue:12:part:auth'), task('a2', 'pr:41:ci')],
    nodes: [node('pr:41', 'issue:12:part:auth')],
    issues: [issue(12, 'Rate limit the ingest API')],
  });

  const goal = insights.goals[0];
  assert.ok(goal);
  assert.equal(goal.issueNumber, 12);
  assert.equal(goal.costUsd, 10, "the goal carries the pull request's spend");
  assert.equal(goal.title, 'Rate limit the ingest API');
  assert.equal(goal.byPhase.build, 2);
  assert.equal(goal.byPhase.landing, 8, 'four times the build went on getting it through');
  assert.equal(insights.unattributedCostUsd, 0);
});

/**
 * The panel and the goal card state the same figure inches apart in the cockpit,
 * so the totals here are `rollUpIssueSpend`'s own rather than a second walk of the
 * graph. Asserted as the invariant it is: whatever the split says, each goal's
 * phases must add back up to the total the card draws.
 */
test('a goal’s phases add back up to the total its card shows', () => {
  const insights = build({
    agents: [agent('a1', { costUsd: 1.1 }), agent('a2', { costUsd: 2.2 }), agent('a3', { costUsd: 3.3 })],
    tasks: [task('a1', 'issue:9:plan'), task('a2', 'issue:9:part:one'), task('a3', 'pr:5:comments')],
    nodes: [node('pr:5', 'issue:9')],
  });

  for (const goal of insights.goals) {
    const summed = Object.values(goal.byPhase).reduce((a, b) => a + b, 0);
    assert.equal(Math.round(summed * 1e6) / 1e6, goal.costUsd, `#${goal.issueNumber} splits into its own total`);
  }
  assert.equal(insights.goals[0]?.costUsd, 6.6, 'and float noise never reaches the wire');
});

/**
 * A run that reported nothing is unmeasured, not free — the same silence the
 * roll-up keeps. It must appear in no figure and still be counted once, because a
 * panel that is silent about how much of the fleet it speaks for is a panel that
 * reads as complete.
 */
test('a run that reported nothing is counted as unmeasured and priced nowhere', () => {
  const insights = build({
    agents: [
      agent('a1', { costUsd: 2 }),
      agent('a2', { costUsd: null, inputTokens: null, outputTokens: null, numTurns: null }),
    ],
    tasks: [task('a1', 'issue:12:part:auth'), task('a2', 'issue:12:part:pty')],
  });

  assert.equal(insights.totals.costUsd, 2);
  assert.equal(insights.totals.measuredRuns, 1);
  assert.equal(insights.totals.unmeasuredRuns, 1);
  assert.equal(insights.goals[0]?.agents, 1, 'the goal counts the runs its figures are over, not every run');
  assert.equal(insights.runs.length, 1, 'and an unmeasured run cannot rank in a table of costs');
});

/** Goals rank by cost, and a goal the world has forgotten still gets its row. */
test('goals rank by cost, titled where the world still knows them', () => {
  const insights = build({
    agents: [agent('a1', { costUsd: 1 }), agent('a2', { costUsd: 9 })],
    tasks: [task('a1', 'issue:1'), task('a2', 'issue:2')],
    issues: [issue(1, 'The cheap one')],
  });

  assert.deepEqual(
    insights.goals.map((g) => [g.issueNumber, g.title]),
    [
      [2, null],
      [1, 'The cheap one'],
    ],
    'costliest first, and a goal off the world baseline draws as its number alone',
  );
});

/**
 * The trend is the only dated reading here. Rolling buckets ending now, so the
 * last one is the last 24 hours — and an event outside the window is dropped
 * rather than clamped into the first bucket, where it would draw a spike nothing
 * spent there.
 */
test('the timeline buckets dated deltas and drops what falls outside the window', () => {
  const day = 24 * 60 * 60 * 1000;
  const insights = build({
    usageEvents: [
      { agentId: 'a1', costUsd: 1.5, at: new Date(NOW - 1000).toISOString() },
      { agentId: 'a1', costUsd: 0.25, at: new Date(NOW - 1000).toISOString() },
      { agentId: 'a2', costUsd: 4, at: new Date(NOW - 3 * day).toISOString() },
      { agentId: 'a3', costUsd: 99, at: new Date(NOW - 40 * day).toISOString() },
      { agentId: 'a4', costUsd: 7, at: 'not a date' },
    ],
  });

  const { buckets } = insights.timeline;
  assert.equal(buckets.length, 14);
  assert.equal(buckets[13]?.costUsd, 1.75, 'two deltas in the last day sum into one bucket');
  assert.equal(buckets[11]?.costUsd, 4, 'three days back lands three buckets back from the last');
  assert.equal(
    buckets.reduce((a, b) => a + b.costUsd, 0),
    5.75,
    'an event older than the window, and an unparseable one, are dropped rather than clamped',
  );
});
