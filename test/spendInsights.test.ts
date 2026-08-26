import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpendInsights } from '../src/spendInsights.js';
import type { Agent, CostDelta, Issue, IssueRun, LocalRun, Task, WorkNode, WorldEvent } from '../src/types.js';
import { resolveWindow, type InsightsWindow } from '../src/insightsWindow.js';

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

function run(number: number, title: string): IssueRun {
  return {
    originRef: `issue:${number}`,
    issueNumber: number,
    title,
    body: '',
    labels: [],
    linkedPrNumber: null,
    workItemState: null,
    startedAt: T,
    completedAt: null,
    outcome: null,
    dismissedAt: null,
    dismissNote: null,
    updatedAt: T,
  };
}

function localRun(id: string, originRef: string, over: Partial<LocalRun> = {}): LocalRun {
  return {
    id,
    originRef,
    ref: 'issue/9/one',
    dir: '/preview',
    pid: 2,
    status: 'stopped',
    url: null,
    note: null,
    startedAt: T,
    endedAt: T,
    costUsd: 1,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: 4,
    ...over,
  };
}

function build(
  over: {
    agents?: Agent[];
    tasks?: Task[];
    nodes?: WorkNode[];
    issues?: Issue[];
    runs?: IssueRun[];
    localRuns?: LocalRun[];
    costDeltas?: CostDelta[];
    mergeEvents?: WorldEvent[];
  },
  key: InsightsWindow = '30d',
) {
  return buildSpendInsights({
    agents: over.agents ?? [],
    localRuns: over.localRuns ?? [],
    tasks: over.tasks ?? [],
    nodes: over.nodes ?? [],
    issues: over.issues ?? [],
    runs: over.runs ?? [],
    costDeltas: over.costDeltas ?? [],
    mergeEvents: over.mergeEvents ?? [],
    window: resolveWindow(key, NOW),
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
      agent('a9', { costUsd: 9 }),
      agent('a10', { costUsd: 10 }),
    ],
    tasks: [
      task('a1', 'issue:12:plan'),
      task('a2', 'issue:12:appraisal'),
      task('a3', 'issue:12'),
      task('a4', 'issue:12:part:auth'),
      task('a5', 'issue:12:assess'),
      task('a6', 'pr:41:ci'),
      task('a7', 'job:sweep'),
      task('a8', null),
      task('a9', 'pr:41:comments'),
      task('a10', 'pr:41:ci-gate'),
    ],
    nodes: [node('pr:41', 'issue:12')],
  });

  const byPhase = new Map(insights.phases.map((p) => [p.phase, p.costUsd]));
  assert.equal(byPhase.get('deliberation'), 7, 'the planner and the appraisal are deliberation');
  assert.equal(byPhase.get('build'), 3, 'the pickup root and a part are both build');
  assert.equal(byPhase.get('evidence'), 5, 'the assessment is evidence');
  assert.equal(byPhase.get('ci'), 16, 'a failing check and a blocked gate are one pipeline’s bill');
  assert.equal(byPhase.get('landing'), 9, 'and answering review is what is left of landing');
  assert.equal(byPhase.get('job'), 7, 'an operator job is its own phase');
  assert.equal(byPhase.get('other'), 8, 'an agent dispatched against nothing is unclassified');
  assert.equal(insights.totals.costUsd, 55, 'the phases partition the fleet, so they sum to it');
  assert.deepEqual(
    insights.phases.map((p) => p.phase),
    ['deliberation', 'build', 'ci', 'landing', 'evidence', 'job', 'other'],
    'phases ship in funnel order regardless of what cost what',
  );
});

/**
 * `landing` is the *remainder* of `pr:*` and not a list of suffixes, so a shape
 * nobody thought to name still lands somewhere an operator can see. Only CI is
 * named, because only CI is being lifted out — and a new PR concern must not need
 * a code change here to be counted at all.
 */
test('every pull-request concern but CI falls to landing, named or not', () => {
  const shapes = ['pr:41', 'pr:41:merge', 'pr:41:mergeable', 'pr:41:comment:c_7', 'pr:41:reply', 'pr:41:whatever-next'];
  const insights = build({
    agents: shapes.map((_, i) => agent(`a${i}`, { costUsd: 1 })),
    tasks: shapes.map((ref, i) => task(`a${i}`, ref)),
  });

  const byPhase = new Map(insights.phases.map((p) => [p.phase, p.costUsd]));
  assert.equal(byPhase.get('landing'), shapes.length);
  assert.equal(byPhase.get('ci'), undefined, 'and none of them is mistaken for a check');
});

/**
 * `ci` and `landing` are separate from `build` even though all three are work on
 * the same code, and this is the reading that separation exists for: a goal whose
 * CI dwarfs its build is a flaky pipeline, not an expensive goal — and the pull
 * request's money still belongs to the goal, which the lineage is what establishes.
 */
test("a pull request's spend joins its goal without joining its build", () => {
  const insights = build({
    agents: [agent('a1', { costUsd: 2 }), agent('a2', { costUsd: 8 }), agent('a3', { costUsd: 1 })],
    tasks: [task('a1', 'issue:12:part:auth'), task('a2', 'pr:41:ci'), task('a3', 'pr:41:comments')],
    nodes: [node('pr:41', 'issue:12:part:auth')],
    issues: [issue(12, 'Rate limit the ingest API')],
  });

  const goal = insights.goals[0];
  assert.ok(goal);
  assert.equal(goal.issueNumber, 12);
  assert.equal(goal.costUsd, 11, "the goal carries the pull request's spend");
  assert.equal(goal.title, 'Rate limit the ingest API');
  assert.equal(goal.byPhase.build, 2);
  assert.equal(goal.byPhase.ci, 8, 'four times the build went on getting the checks green');
  assert.equal(goal.byPhase.landing, 1, 'and the review it also needed is not folded in with them');
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

/**
 * The second source of spend, and the reason it is a phase rather than a footnote:
 * the panel states its total beside the gauge an operator opened it from, so money
 * that is in one and not the other is two answers to one question.
 */
test('local runs are a phase of the same money, and the partition still closes', () => {
  const insights = build({
    agents: [agent('a1', { costUsd: 2 })],
    tasks: [task('a1', 'issue:9:part:one')],
    localRuns: [localRun('r1', 'issue:9', { costUsd: 0.5 }), localRun('r2', 'issue:9', { costUsd: 0.25 })],
  });

  assert.equal(insights.totals.costUsd, 2.75);
  assert.equal(insights.totals.measuredRuns, 3, 'a local run is a run: the panel speaks for it too');
  const local = insights.phases.find((p) => p.phase === 'local');
  assert.equal(local?.costUsd, 0.75);
  assert.equal(local?.runs, 2);
  // Reading order is funnel order, and a preview comes after the evidence and before
  // the work nobody asked a goal for.
  assert.deepEqual(
    insights.phases.map((p) => p.phase),
    ['build', 'local'],
  );

  const goal = insights.goals[0];
  assert.equal(goal?.costUsd, 2.75, 'the same figure the goal’s own card carries');
  assert.equal(goal?.localRuns, 2);
  assert.equal(goal?.byPhase.local, 0.75);
  const summed = Object.values(goal?.byPhase ?? {}).reduce((a, b) => a + b, 0);
  assert.equal(Math.round(summed * 1e6) / 1e6, goal?.costUsd);
  assert.equal(
    insights.phases.reduce((a, p) => a + p.costUsd, 0),
    insights.totals.costUsd,
    'every phase, back to the total',
  );
});

test('a local run ranks among the costliest runs, named by its branch', () => {
  const insights = build({
    agents: [agent('a1', { costUsd: 0.4 })],
    tasks: [task('a1', 'issue:9:part:one')],
    localRuns: [localRun('r1', 'issue:9', { costUsd: 3, ref: 'issue/9/one' })],
  });

  const top = insights.runs[0];
  assert.equal(top?.id, 'r1');
  assert.equal(top?.kind, 'local');
  // Nothing dispatched it, so there is no task title to name it by — and two runs of
  // one goal are told apart by nothing except the branch each was pointed at.
  assert.equal(top?.title, 'Local run · issue/9/one');
  assert.equal(top?.issueNumber, 9);
  assert.equal(insights.rankedFrom, 2);
});

test('an unmeasured local run is counted once and priced nowhere', () => {
  const insights = build({
    localRuns: [localRun('r1', 'issue:9', { costUsd: null, inputTokens: null, outputTokens: null, numTurns: null })],
  });
  assert.equal(insights.totals.unmeasuredRuns, 1);
  assert.equal(insights.totals.costUsd, 0);
  assert.equal(insights.phases.length, 0);
  assert.equal(insights.runs.length, 0);
});

/**
 * The cached split is a *part* of the input, and the fraction it forms is over
 * the runs that reported one — never over the fleet's whole input. A run from
 * before the split was recorded measured a gross figure and nothing about its
 * cache share; folded into the denominator it would read as a cache miss, which
 * is the one wrong answer this figure can give and the reason the denominator is
 * shipped beside it rather than assumed.
 */
test('the cached split sums only over runs that reported one, and carries its own denominator', () => {
  const insights = build({
    agents: [
      agent('a1', { costUsd: 2, inputTokens: 10_000, cacheReadTokens: 8000, cacheCreationTokens: 500 }),
      agent('a2', { costUsd: 1, inputTokens: 4000, cacheReadTokens: 0, cacheCreationTokens: 0 }),
      // Measured for money, silent about caching: an agents row from before the
      // columns existed.
      agent('a3', { costUsd: 3, inputTokens: 90_000 }),
    ],
    tasks: [task('a1', 'issue:12'), task('a2', 'issue:12'), task('a3', 'issue:12')],
  });

  const { totals } = insights;
  assert.equal(totals.inputTokens, 104_000, 'the gross input is every measured run, as it always was');
  assert.equal(totals.cacheReadTokens, 8000);
  assert.equal(totals.cacheCreationTokens, 500);
  assert.equal(totals.cacheMeasuredInputTokens, 14_000, 'and the denominator is only the two runs that reported');
  assert.equal(totals.measuredRuns, 3, 'the silent run is still measured — it reported money');
  assert.equal(totals.unmeasuredRuns, 0);
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
    costDeltas: [
      { costUsd: 1.5, at: new Date(NOW - 1000).toISOString() },
      { costUsd: 0.25, at: new Date(NOW - 1000).toISOString() },
      { costUsd: 4, at: new Date(NOW - 3 * day).toISOString() },
      { costUsd: 99, at: new Date(NOW - 40 * day).toISOString() },
      { costUsd: 7, at: 'not a date' },
    ],
  });

  const { buckets } = insights.timeline;
  // Counted off the payload rather than pinned to a number: the resolution is the
  // window's now, so a test naming 14 would be asserting a constant that moved.
  assert.equal(buckets.length, insights.window.buckets);
  const last = buckets.length - 1;
  assert.equal(buckets[last]?.costUsd, 1.75, 'two deltas in the last day sum into one bucket');
  // Three days back, and the last bucket is the one still filling — so it lands
  // two before it, not three. The off-by-one is the whole reason this is asserted.
  assert.equal(buckets[last - 2]?.costUsd, 4, 'a delta three days old lands in the bucket that covers it');
  assert.equal(
    buckets.reduce((a, b) => a + b.costUsd, 0),
    5.75,
    'an event older than the window, and an unparseable one, are dropped rather than clamped',
  );
});

/**
 * A goal outlives the tracker's open set, and its name has to outlive it too.
 *
 * The money stays on the table forever; the world baseline is the *open* issues,
 * so every goal that closed or was dismissed is missing from it. Naming those rows
 * off the world alone drew each of them as its number and "no longer in the world"
 * — while the run record, which never forgets a goal the harness worked, had the
 * title all along.
 */
test('a goal the world has forgotten is named from its run record', () => {
  const insights = build({
    agents: [agent('a1', { costUsd: 3 }), agent('a2', { costUsd: 2 })],
    tasks: [task('a1', 'issue:12'), task('a2', 'issue:99')],
    issues: [issue(12, 'Still open')],
    runs: [run(12, 'What it was called then'), run(99, 'Closed months ago')],
  });
  const named = new Map(insights.goals.map((g) => [g.issueNumber, g.title]));
  // The world wins where it has an answer — a retitled ticket reads as it does now.
  assert.equal(named.get(12), 'Still open');
  assert.equal(named.get(99), 'Closed months ago');
});

/** No record anywhere is still a row, and still honest about the name. */
test('a goal older than the run record keeps its row and no title', () => {
  const insights = build({
    agents: [agent('a1', { costUsd: 1 })],
    tasks: [task('a1', 'issue:404')],
  });
  assert.equal(insights.goals.length, 1);
  assert.equal(insights.goals[0]?.title, null);
});

/**
 * The window is the page's one control, and this is what makes it mean anything:
 * a run outside it is in no figure at all — not the total, not its phase's row,
 * not its goal's, not the ranking.
 *
 * It is asserted across all four because the cut is made **once**, at the top of
 * the fold, and everything below reads the list it produces. A version that
 * filtered per split would pass three of these assertions and fail the fourth —
 * and what that looks like on the glass is a phase table whose costs do not add
 * to the total above it.
 */
test('a run outside the window is in no figure, not a smaller one', () => {
  const day = 24 * 60 * 60 * 1000;
  const inside = agent('a1', { costUsd: 3, startedAt: T, endedAt: new Date(NOW - 60_000).toISOString() });
  const outside = agent('a2', { costUsd: 99, startedAt: T, endedAt: new Date(NOW - 40 * day).toISOString() });

  const insights = build({
    agents: [inside, outside],
    tasks: [task('a1', 'issue:7:part:one'), task('a2', 'issue:7:part:two')],
  });

  assert.equal(insights.totals.costUsd, 3);
  assert.equal(insights.totals.measuredRuns, 1);
  assert.equal(insights.phases.reduce((n, p) => n + p.costUsd, 0), 3, 'the phases must still sum to the total'); // prettier-ignore
  assert.equal(insights.goals[0]?.costUsd, 3, 'a goal is the money it cost inside the window');
  assert.equal(insights.runs.length, 1);
  assert.equal(insights.rankedFrom, 1);
});

/**
 * A run that opened before the window and finished inside it spent its money
 * inside it. Counting it at its start would leave the nine-hour agent out of the
 * six-hour window it in fact dominated — which is the reading an operator opened
 * a six-hour window to get.
 */
test('a long run counts in the window it finished in', () => {
  const hour = 60 * 60 * 1000;
  const straddling = agent('a1', {
    costUsd: 12,
    startedAt: new Date(NOW - 9 * hour).toISOString(),
    endedAt: new Date(NOW - 20 * 60_000).toISOString(),
  });
  const insights = build({ agents: [straddling], tasks: [task('a1', 'issue:7:part:one')] }, '6h');
  assert.equal(insights.totals.costUsd, 12);
});

/**
 * The two figures the ratio headline needs beside the total, and they ride on
 * this payload rather than the reliability one: "$26 of $118 never landed" is one
 * sentence, and fetching its two halves from two routes is how they end up
 * describing two windows.
 */
test('landed counts merges, and what never landed counts faults only', () => {
  const merged = (n: number): WorldEvent => ({
    id: `we_${n}`,
    kind: 'pr_merged',
    ref: `pr:${n}`,
    summary: `PR #${n} merged`,
    createdAt: T,
  });
  const insights = build({
    agents: [
      agent('a1', { status: 'done', costUsd: 4 }),
      agent('a2', { status: 'failed', costUsd: 3 }),
      agent('a3', { status: 'crashed', costUsd: 2 }),
      // A killed run is a steer, not a fault. Counting an operator's own change of
      // mind as waste is what makes every steered fleet look broken.
      agent('a4', { status: 'killed', costUsd: 5 }),
    ],
    tasks: ['a1', 'a2', 'a3', 'a4'].map((id) => task(id, 'issue:7:part:one')),
    mergeEvents: [merged(1), merged(2)],
  });

  assert.equal(insights.landed, 2);
  assert.equal(insights.lostCostUsd, 5, 'failed and crashed only — a killed run cost what it cost and is not waste');
  assert.equal(insights.totals.costUsd, 14, 'every run is still in the total, whatever it was doing');
});

/**
 * A fleet that is out right now is never an empty window.
 *
 * `EconomicsTab` short-circuits on `totals.measuredRuns === 0` and prints "No
 * agent ran in this window, so there is nothing to break down" — while the top
 * bar's chip, a plain sum since an instant, shows the money on the same screen.
 * A local run meets this normally rather than exceptionally: it is held open for
 * as long as somebody is looking at it.
 */
test('a run still out when the window opened is counted in it, agent and local run alike', () => {
  const day = 24 * 60 * 60 * 1000;
  const nodes = [node('issue:41', null)];
  const live = agent('a-live', {
    status: 'running',
    costUsd: 5,
    startedAt: new Date(NOW - 8 * 60 * 60 * 1000).toISOString(),
    endedAt: null,
  });
  const preview = localRun('lr-live', 'issue:41', {
    status: 'running',
    costUsd: 2,
    startedAt: new Date(NOW - 3 * day).toISOString(),
    endedAt: null,
  });

  const six = build({ agents: [live], localRuns: [preview], tasks: [task('a-live', 'issue:41:part:api')], nodes }, '6h'); // prettier-ignore
  // Both spenders, both live: the agent and the preview each count as a measured
  // run, so the tab has a breakdown to draw rather than its empty state.
  assert.equal(six.totals.measuredRuns, 2, 'the empty state is not drawn over a fleet that is out');
  assert.equal(six.totals.costUsd, 7);
  assert.equal(six.phases.find((p) => p.phase === 'build')?.costUsd, 5);
  assert.equal(six.phases.find((p) => p.phase === 'local')?.costUsd, 2);
  assert.equal(six.goals.find((g) => g.issueNumber === 41)?.costUsd, 7);
});

/**
 * The window cuts both spenders, and by the same rule.
 *
 * A local run is a session that held the dev environment for as long as somebody
 * was looking at it, so it belongs to the window it *finished* in exactly as an
 * agent does. Cutting only the agents would leave a preview from last month in
 * this morning's total — and it would show up as the `local` phase row failing to
 * add up against a bar drawn from the same figure.
 */
test('a local run obeys the window the agents do', () => {
  const day = 24 * 60 * 60 * 1000;
  const nodes = [node('issue:9', null)];
  const inside = localRun('lr1', 'issue:9', {
    costUsd: 2,
    startedAt: new Date(NOW - 2 * day).toISOString(),
    endedAt: new Date(NOW - 2 * day).toISOString(),
  });
  const outside = localRun('lr2', 'issue:9', {
    costUsd: 40,
    startedAt: new Date(NOW - 40 * day).toISOString(),
    endedAt: new Date(NOW - 40 * day).toISOString(),
  });

  const month = build({ localRuns: [inside, outside], nodes });
  assert.equal(month.totals.costUsd, 2);
  assert.equal(month.phases.find((p) => p.phase === 'local')?.costUsd, 2);
  assert.equal(month.goals.find((g) => g.issueNumber === 9)?.byPhase.local, 2);

  const all = build({ localRuns: [inside, outside], nodes }, 'all');
  assert.equal(all.totals.costUsd, 42);
  assert.equal(all.phases.find((p) => p.phase === 'local')?.costUsd, 42);
});
