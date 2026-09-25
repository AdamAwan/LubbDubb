import type { SpendInsights, SpendPhase, SpendTrend, SpendTrendComparison } from '../types.js';
import { localPhaseCostUsd } from './insightsFormat.js';
import { toCsv } from './Downloads.js';

type Rows = (string | number | null)[][];

export function spendCsv(insights: SpendInsights, trend: SpendTrend | null = null): string {
  const { phases, timeline, taskTypes } = insights;
  const order = phases.map((p) => p.phase);
  const localCost = localPhaseCostUsd(insights);

  return toCsv([
    ...totalsRows(insights),
    [],

    ['Phases'],
    ['Phase', 'Label', 'Definition', 'Cost (USD)', 'Runs', 'Input tokens', 'Output tokens'],
    ...phases.map((p) => [p.phase, p.label, p.blurb, p.costUsd, p.runs, p.inputTokens, p.outputTokens]),
    [],

    ['Daily'],
    ['Bucket start (ISO)', 'Cost (USD)'],
    ...timeline.buckets.map((b) => [b.startsAt, b.costUsd]),
    [],

    ['Task types'],
    ['Rule', 'Label', 'Rationale', 'Cost (USD)', 'Runs', 'Per run (USD)'],
    ...taskTypes.map((t) => [t.rule, t.label, t.description, t.costUsd, t.runs, t.perRunUsd]),
    ...(localCost > 0 ? [['', 'Local runs — no dispatch rule', localCost]] : []),
    [],

    ...checksRows(insights),
    [],

    ...goalsRows(insights, order),
    [],

    ...runsRows(insights),

    ...(trend === null
      ? [[], ['Trend'], ['The trend tab was not opened, so its weeks are not in this file.']]
      : trendCsv(trend, order)),
  ]);
}

function totalsRows(insights: SpendInsights): Rows {
  const { totals } = insights;
  return [
    ['Totals'],
    ['Measure', 'Value'],
    ['Window', insights.window.label],
    ['Window opened (ISO)', insights.window.since ?? 'no lower bound — all time'],
    ['Cost in window (USD)', totals.costUsd],
    ['Pull requests landed in window', insights.landed],
    ['Cost of runs that failed or crashed (USD)', insights.lostCostUsd],
    ['Input tokens', totals.inputTokens],
    ['Output tokens', totals.outputTokens],
    ['Cache read tokens', totals.cacheReadTokens],
    ['Cache write tokens', totals.cacheCreationTokens],
    ['Input tokens with a cache breakdown', totals.cacheMeasuredInputTokens],
    ['Turns', totals.turns],
    ['Measured runs', totals.measuredRuns],
    ['Unmeasured runs', totals.unmeasuredRuns],
    ['Reached no goal (USD)', insights.unattributedCostUsd],
    ['Generated (ISO)', insights.generatedAt],
  ];
}

function checksRows({ checks }: SpendInsights): Rows {
  return [
    ['Failing checks'],
    ['Check', 'Cost (USD)', 'Runs', 'Sole-cause runs', 'Per run (USD)', 'Last (ISO)'],
    ...checks.checks.map((c) => [c.name, c.costUsd, c.runs, c.soleRuns, c.perRunUsd, c.lastAt]),
    ['Named no check', checks.unnamedCostUsd],
    ['Attributed to a check', checks.attributedCostUsd],
    [
      `The ${checks.checks.length} costliest of ${checks.seen} checks seen. A run red on two checks splits its cost ` +
        'evenly between them, so these rows sum to the attributed total and never overstate it.',
    ],
  ];
}

function goalsRows(insights: SpendInsights, order: readonly SpendPhase[]): Rows {
  return [
    ['Goals'],
    ['Issue', 'Title', 'Cost (USD)', 'Runs', 'Input tokens', 'Output tokens', 'Last activity (ISO)', ...order],
    ...insights.goals.map((g) => [
      g.issueNumber,
      g.title,
      g.costUsd,
      g.agents,
      g.inputTokens,
      g.outputTokens,
      g.lastAt,
      ...order.map((p) => g.byPhase[p]),
    ]),
    ['', 'Reached no goal', insights.unattributedCostUsd],
  ];
}

function runsRows({ runs, rankedFrom }: SpendInsights): Rows {
  return [
    ['Runs'],
    [
      'Run',
      'Kind',
      'Origin',
      'Title',
      'Phase',
      'Issue',
      'Cost (USD)',
      'Input tokens',
      'Output tokens',
      'Turns',
      'Started (ISO)',
      'Ended (ISO)',
    ],
    ...runs.map((r) => [
      r.id,
      r.kind,
      r.originRef,
      r.title,
      r.phase,
      r.issueNumber,
      r.costUsd,
      r.inputTokens,
      r.outputTokens,
      r.numTurns,
      r.startedAt,
      r.endedAt,
    ]),
    [`The ${runs.length} costliest of ${rankedFrom} measured runs.`],
  ];
}

function trendCsv(trend: SpendTrend, order: readonly SpendPhase[]): Rows {
  const { comparison } = trend;
  return [
    [],
    ['Trend — weeks'],
    [
      'Week start (ISO)',
      'Still filling',
      'Goals closed',
      'Goals with no spend',
      'Median cost (USD)',
      'Median input tokens',
      'Reopened',
      'Runs settled',
      'Runs finished',
      'Lost run cost (USD)',
      'CI reds',
      'Every goal cost (USD)',
      ...order.map((p) => `${p} per goal (USD)`),
    ],
    ...trend.buckets.map((w) => [
      w.startsAt,
      w.partial ? 'yes' : 'no',
      w.goalsClosed,
      w.goalsUnmeasured,
      w.medianCostUsd,
      w.medianInputTokens,
      w.reopened,
      w.settled,
      w.completed,
      w.lostCostUsd,
      w.reds,
      w.costs.join(' '),
      ...order.map((p) => w.byPhase[p]),
    ]),
    [
      'Cost, tokens, the stage split and reopens belong to the goals that closed that week. Runs settled and CI reds ' +
        'are what was observed inside the week itself. The last week is still filling.',
    ],
    [],

    ['Trend — halves'],
    ...(comparison === null
      ? [['Too few complete weeks to compare halves — two either side are needed.']]
      : halvesRows(comparison)),
  ];
}

function halvesRows(comparison: SpendTrendComparison): Rows {
  return [
    [
      'Half',
      'From (ISO)',
      'To (ISO)',
      'Weeks',
      'Goals closed',
      'Median cost (USD)',
      'Median input tokens',
      'Runs finished (rate)',
      'Lost run cost per goal (USD)',
      'CI reds per goal',
      'Reopened (rate)',
    ],
    ...([comparison.earlier, comparison.recent] as const).map((p, i) => [
      i === 0 ? 'earlier' : 'recent',
      p.startsAt,
      p.endsAt,
      p.weeks,
      p.goalsClosed,
      p.medianCostUsd,
      p.medianInputTokens,
      p.completionRate,
      p.lostCostPerGoalUsd,
      p.redsPerGoal,
      p.reopenedRate,
    ]),
    [],
    ['Trend — stage shift'],
    ['Stage', 'Share then', 'Share now', 'USD per goal then', 'USD per goal now', 'Change (ratio)'],
    ...comparison.phases.map((p) => [p.phase, p.earlierShare, p.recentShare, p.earlierUsd, p.recentUsd, p.changeRatio]),
    [
      'Read the dollar columns with the share columns: a stage whose share rose while its dollars fell did not ' +
        'get more expensive.',
    ],
  ];
}
