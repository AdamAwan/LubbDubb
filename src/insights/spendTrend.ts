import type { Agent, AgentStatus, Issue, WorldEvent } from '../types.js';
import type { TicketClosure } from '../store/tickets.js';
import { roundUsd } from './issueSpend.js';
import { PHASE_ORDER, phaseLabel, zeroPhases, type SpendGoal, type SpendPhase } from './spendInsights.js';
import { ciStatusOf } from '../world/worldDiff.js';
import { runInstant, trendSpan, windowView, type InsightsWindowView, type ResolvedWindow } from './insightsWindow.js';

// → docs/spec/18-observability.md

const MIN_HALF_PERIODS = 2;

const LOST: readonly AgentStatus[] = ['failed', 'crashed'];
const SETTLED: readonly AgentStatus[] = ['done', 'failed', 'crashed', 'killed', 'interrupted'];

export interface SpendTrendBucket {
  startsAt: string;
  partial: boolean;

  goalsClosed: number;
  goalsUnmeasured: number;
  medianCostUsd: number | null;
  medianInputTokens: number | null;
  costs: number[];
  byPhase: Record<SpendPhase, number>;
  reopened: number;

  settled: number;
  completed: number;
  completionRate: number | null;
  lostCostUsd: number;
  reds: number;
  redsPerGoal: number | null;
}

export interface SpendTrendPeriod {
  startsAt: string;
  endsAt: string;
  weeks: number;
  goalsClosed: number;
  medianCostUsd: number | null;
  medianInputTokens: number | null;
  byPhase: Record<SpendPhase, number>;
  completionRate: number | null;
  lostCostPerGoalUsd: number | null;
  redsPerGoal: number | null;
  reopenedRate: number | null;
}

export interface SpendTrendPhaseShift {
  phase: SpendPhase;
  label: string;
  earlierUsd: number;
  recentUsd: number;
  earlierShare: number;
  recentShare: number;
  changeRatio: number | null;
}

export interface SpendTrendComparison {
  earlier: SpendTrendPeriod;
  recent: SpendTrendPeriod;
  phases: SpendTrendPhaseShift[];
}

export interface SpendTrend {
  generatedAt: string;
  window: InsightsWindowView;
  periods: number;
  bucketMs: number;
  startsAt: string;
  buckets: SpendTrendBucket[];
  comparison: SpendTrendComparison | null;
}

interface SpendTrendInput {
  goals: readonly SpendGoal[];
  closures: readonly TicketClosure[];
  issues: readonly Issue[];
  agents: readonly Agent[];
  ciEvents: readonly WorldEvent[];
  window: ResolvedWindow;
  now: number;
}

function median(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

function emptyWeek(startsAt: string, partial: boolean): SpendTrendBucket {
  return {
    startsAt,
    partial,
    goalsClosed: 0,
    goalsUnmeasured: 0,
    medianCostUsd: null,
    medianInputTokens: null,
    costs: [],
    byPhase: zeroPhases(),
    reopened: 0,
    settled: 0,
    completed: 0,
    completionRate: null,
    lostCostUsd: 0,
    reds: 0,
    redsPerGoal: null,
  };
}

export function buildSpendTrend(input: SpendTrendInput): SpendTrend {
  const { goals, closures, issues, agents, ciEvents, window, now } = input;
  const span = trendSpan(
    window,
    [...closures.map((c) => Date.parse(c.closedAt)), ...agents.map(runInstant)].reduce<number | null>(
      (oldest, at) => (Number.isNaN(at) ? oldest : oldest === null || at < oldest ? at : oldest),
      null,
    ),
  );
  const start = span.startMs;
  const buckets = Array.from({ length: span.buckets }, (_, i) =>
    emptyWeek(new Date(start + i * span.bucketMs).toISOString(), i === span.buckets - 1),
  );
  const bucketAt = (at: number): number | null => {
    if (Number.isNaN(at) || at < start) return null;
    return Math.min(span.buckets - 1, Math.floor((at - start) / span.bucketMs));
  };

  const spendOfGoal = new Map(goals.map((g) => [g.issueNumber, g]));
  const openNow = new Set(issues.filter((i) => i.state === 'open').map((i) => i.number));

  const closedAt = new Map<number, number>();
  for (const closure of closures) {
    const at = Date.parse(closure.closedAt);
    if (Number.isNaN(at)) continue;
    const seen = closedAt.get(closure.number);
    if (seen === undefined || at > seen) closedAt.set(closure.number, at);
  }

  const cohorts = new Map<number, SpendGoal[]>();
  for (const [issueNumber, at] of closedAt) {
    const index = bucketAt(at);
    if (index === null) continue;
    const week = buckets[index];
    if (week === undefined) continue;
    const spend = spendOfGoal.get(issueNumber);
    if (spend === undefined) {
      week.goalsUnmeasured += 1;
      continue;
    }
    week.goalsClosed += 1;
    if (openNow.has(issueNumber)) week.reopened += 1;
    const cohort = cohorts.get(index) ?? [];
    cohort.push(spend);
    cohorts.set(index, cohort);
  }
  for (const [index, cohort] of cohorts) {
    const week = buckets[index];
    if (week === undefined) continue;
    week.costs = cohort.map((g) => g.costUsd).sort((a, b) => a - b);
    week.medianCostUsd = median(week.costs);
    week.medianInputTokens = median(cohort.map((g) => g.inputTokens));
    for (const phase of PHASE_ORDER) {
      const total = cohort.reduce((n, g) => n + g.byPhase[phase], 0);
      week.byPhase[phase] = roundUsd(total / cohort.length);
    }
  }

  for (const agent of agents) {
    if (agent.endedAt === null || !SETTLED.includes(agent.status)) continue;
    const index = bucketAt(Date.parse(agent.endedAt));
    if (index === null) continue;
    const week = buckets[index];
    if (week === undefined) continue;
    week.settled += 1;
    if (agent.status === 'done') week.completed += 1;
    if (LOST.includes(agent.status)) week.lostCostUsd = roundUsd(week.lostCostUsd + (agent.costUsd ?? 0));
  }
  for (const event of ciEvents) {
    if (ciStatusOf(event) !== 'failing') continue;
    const index = bucketAt(Date.parse(event.createdAt));
    if (index === null) continue;
    const week = buckets[index];
    if (week !== undefined) week.reds += 1;
  }
  for (const week of buckets) {
    week.completionRate = week.settled > 0 ? week.completed / week.settled : null;
    week.redsPerGoal = week.goalsClosed > 0 ? week.reds / week.goalsClosed : null;
  }

  return {
    generatedAt: new Date(now).toISOString(),
    window: windowView(window, span),
    periods: span.buckets,
    bucketMs: span.bucketMs,
    startsAt: new Date(start).toISOString(),
    buckets,
    comparison: compare(buckets, cohorts, span.bucketMs),
  };
}

function compare(
  buckets: readonly SpendTrendBucket[],
  cohorts: ReadonlyMap<number, SpendGoal[]>,
  bucketMs: number,
): SpendTrendComparison | null {
  const complete = buckets.map((week, index) => ({ week, index })).filter((b) => !b.week.partial);
  const half = Math.floor(complete.length / 2);
  if (half < MIN_HALF_PERIODS) return null;
  const earlierSpan = complete.slice(0, half);
  const recentSpan = complete.slice(complete.length - half);
  if (populated(earlierSpan, cohorts) < MIN_HALF_PERIODS) return null;
  if (populated(recentSpan, cohorts) < MIN_HALF_PERIODS) return null;
  const earlier = fold(earlierSpan, cohorts, bucketMs);
  const recent = fold(recentSpan, cohorts, bucketMs);
  return { earlier, recent, phases: shifts(earlier, recent) };
}

function populated(
  span: readonly { week: SpendTrendBucket; index: number }[],
  cohorts: ReadonlyMap<number, SpendGoal[]>,
): number {
  return span.filter(({ index }) => (cohorts.get(index)?.length ?? 0) > 0).length;
}

function fold(
  span: readonly { week: SpendTrendBucket; index: number }[],
  cohorts: ReadonlyMap<number, SpendGoal[]>,
  bucketMs: number,
): SpendTrendPeriod {
  const first = span[0]?.week;
  const last = span[span.length - 1]?.week;
  const pooled = span.flatMap(({ index }) => cohorts.get(index) ?? []);
  const settled = span.reduce((n, { week }) => n + week.settled, 0);
  const completed = span.reduce((n, { week }) => n + week.completed, 0);
  const reds = span.reduce((n, { week }) => n + week.reds, 0);
  const reopened = span.reduce((n, { week }) => n + week.reopened, 0);
  const lostCostUsd = span.reduce((n, { week }) => roundUsd(n + week.lostCostUsd), 0);

  const byPhase = zeroPhases();
  for (const phase of PHASE_ORDER) {
    if (pooled.length === 0) break;
    byPhase[phase] = roundUsd(pooled.reduce((n, g) => n + g.byPhase[phase], 0) / pooled.length);
  }

  return {
    startsAt: first?.startsAt ?? '',
    endsAt: new Date(Date.parse(last?.startsAt ?? first?.startsAt ?? '') + bucketMs).toISOString(),
    weeks: span.length,
    goalsClosed: pooled.length,
    medianCostUsd: median(pooled.map((g) => g.costUsd)),
    medianInputTokens: median(pooled.map((g) => g.inputTokens)),
    byPhase,
    completionRate: settled > 0 ? completed / settled : null,
    lostCostPerGoalUsd: pooled.length > 0 ? roundUsd(lostCostUsd / pooled.length) : null,
    redsPerGoal: pooled.length > 0 ? reds / pooled.length : null,
    reopenedRate: pooled.length > 0 ? reopened / pooled.length : null,
  };
}

function shifts(earlier: SpendTrendPeriod, recent: SpendTrendPeriod): SpendTrendPhaseShift[] {
  const earlierTotal = PHASE_ORDER.reduce((n, p) => n + earlier.byPhase[p], 0);
  const recentTotal = PHASE_ORDER.reduce((n, p) => n + recent.byPhase[p], 0);
  return PHASE_ORDER.filter((p) => earlier.byPhase[p] > 0 || recent.byPhase[p] > 0).map((phase) => ({
    phase,
    label: phaseLabel(phase),
    earlierUsd: earlier.byPhase[phase],
    recentUsd: recent.byPhase[phase],
    earlierShare: earlierTotal > 0 ? earlier.byPhase[phase] / earlierTotal : 0,
    recentShare: recentTotal > 0 ? recent.byPhase[phase] / recentTotal : 0,
    changeRatio:
      earlier.byPhase[phase] > 0 ? (recent.byPhase[phase] - earlier.byPhase[phase]) / earlier.byPhase[phase] : null,
  }));
}
