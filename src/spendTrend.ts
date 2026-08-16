import type { Agent, AgentStatus, Issue, WorldEvent } from './types.js';
import { roundUsd } from './issueSpend.js';
import { PHASE_ORDER, phaseLabel, zeroPhases, type SpendGoal, type SpendPhase } from './spendInsights.js';
import { ciStatusOf } from './world/worldDiff.js';

/**
 * The spend trend: is the fleet getting cheaper, where did the money move, and
 * did the work still land.
 *
 * The breakdown answers *where the money went* and is almost entirely undated.
 * Its one dated reading is a fortnight of daily cost, which cannot answer the
 * question an operator actually has while trying to spend less: **is what I did
 * working**. Cost falls when a fleet is idle exactly as readily as when it is
 * efficient, so a total over time is not an answer.
 *
 * Three readings are, and they are deliberately drawn on **one week axis** so a
 * change shows up in all three at once:
 *
 * - **Are goals getting cheaper** — the median cost of the goals that *closed* in
 *   each week, with every goal's own cost shipped beside it so the spread is
 *   drawable and one runaway goal cannot pass for a trend.
 * - **Which stages moved** — the same cohort's spend split by phase, as dollars
 *   per goal. Shipped as absolutes rather than shares for the reason the panel
 *   leans on hardest: planning more in order to review less is a *reallocation*,
 *   and a share column alone cannot tell it from planning more for nothing.
 * - **Did it still land** — completion rate, lost cost, CI reds and goals that
 *   came back, on the same weeks. A fleet that got cheaper by giving up earlier
 *   is cheaper on every other reading here and nowhere else.
 *
 * ## The unit is a closed goal, never a run
 *
 * Every per-run rate the harness could report is gameable for free: split the
 * same work across twice as many smaller agents and input-per-run halves while
 * nothing whatever improves. A goal that closed is the one unit that cannot be
 * subdivided by a dispatch change, which is what makes it the denominator here
 * even though it is the more awkward one — goals differ in size, so the spread
 * ships with the median rather than being summarised away.
 *
 * ## Two kinds of week, and the difference is stated
 *
 * A **cohort** reading is a property of the goals that closed that week and
 * follows them wherever their spend happened: cost, tokens, the phase split,
 * whether they were reopened. A **period** reading is what was observed inside
 * the week itself: runs that settled, CI reds. The two are not interchangeable —
 * a goal closed on Monday was worked on for a fortnight — and each field below
 * says which it is rather than leaving a reader to assume.
 *
 * CI reds are a period reading on purpose. Attributing a red to the goal it was
 * eventually part of would need every red inside the *lead time* of every goal in
 * the window, which is unbounded backwards; counting reds against the goals
 * *delivered in the same week* is a rate of pipeline noise per unit of delivered
 * work, needs no lineage walk, and cannot quietly under-report the early weeks it
 * has no history for.
 *
 * ## Derived, never stored
 *
 * `buildSpendInsights`'s reason: goal spend is already durable on the `agents`
 * rows, closures are already durable in `world_events`, and nothing here needs a
 * column that does not exist. It reads correctly on every database from before it
 * was written — which is the whole argument for cohorting goals rather than
 * bucketing tokens, since `usage_events` dates dollars and has never dated
 * tokens.
 */

/** How far back the trend reaches, and at what resolution. */
const TREND_WEEKS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Two weeks either side, below which a comparison is a coin toss — see {@link compare}. */
const MIN_HALF_WEEKS = 2;

/** The endings that are the harness failing, as opposed to a run being stopped. */
const LOST: readonly AgentStatus[] = ['failed', 'crashed'];
/** Every ending. The live statuses are not outcomes and settle no week. */
const SETTLED: readonly AgentStatus[] = ['done', 'failed', 'crashed', 'killed', 'interrupted'];

/** One week on the shared axis. Every chart in the tab is drawn from these. */
export interface SpendTrendWeek {
  startsAt: string;
  /**
   * True for the week `now` falls inside. Goals are still closing into it, so
   * every cohort figure on it is an under-count of what it will end up being —
   * the panel draws it hollow rather than letting a half-finished week read as a
   * fall.
   */
  partial: boolean;

  // -- Cohort: the goals that closed in this week ---------------------------

  /** Goals that closed in this week *and* have measured spend. */
  goalsClosed: number;
  /**
   * Goals that closed in this week and reported no spend at all — no agent ever
   * ran on them, or every agent that did was a PTY. In no figure below, counted
   * here for the reason the breakdown counts its unmeasured runs: otherwise
   * nothing says how much of the week the medians speak for.
   */
  goalsUnmeasured: number;
  /** The middle goal's cost. Null when no measured goal closed this week. */
  medianCostUsd: number | null;
  medianInputTokens: number | null;
  /**
   * Every closed goal's cost, ascending — the spread the median is the middle of.
   *
   * Shipped rather than summarised to a quartile pair because the panel draws it
   * as a strip of points: a week whose median fell because it happened to close
   * three small goals looks exactly like real progress once the spread is gone,
   * and that is the misreading this whole tab would otherwise invite.
   */
  costs: number[];
  /** Mean dollars per goal per phase. Sums to the cohort's mean goal cost. */
  byPhase: Record<SpendPhase, number>;
  /**
   * Goals that closed in this week and are open again now.
   *
   * Read from the world's current state rather than from a reopen event, because
   * the world diff has no `closed → open` transition to emit — a goal that comes
   * back is only visible as one that closed and is nonetheless open. Cheap, and
   * it is the honesty check the other two questions cannot make: closing goals
   * cheaply and having them return is indistinguishable from getting better on
   * every other reading in this module.
   */
  reopened: number;

  // -- Period: what was observed inside the week itself ---------------------

  /** Runs that ended inside this week. */
  settled: number;
  completed: number;
  /** `completed / settled`, or null when nothing ended this week. */
  completionRate: number | null;
  /** What the runs that failed or crashed this week cost. */
  lostCostUsd: number;
  /** Transitions into failing observed on any pull request this week. */
  reds: number;
  /** `reds / goalsClosed` — pipeline noise against delivered work. Null when nothing closed. */
  redsPerGoal: number | null;
}

/**
 * Half the window, folded — what the tiles and the phase table compare.
 *
 * Derived here rather than in the cockpit because it is the same fold as a week
 * over a longer span, and two implementations of "the median goal" a panel apart
 * is the disagreement this codebase already refuses to have about a goal's cost.
 * The panel writes the copy; this decides the figures.
 */
export interface SpendTrendPeriod {
  startsAt: string;
  endsAt: string;
  weeks: number;
  goalsClosed: number;
  medianCostUsd: number | null;
  medianInputTokens: number | null;
  /** Mean dollars per goal per phase. Zero for a phase the cohort never touched. */
  byPhase: Record<SpendPhase, number>;
  completionRate: number | null;
  /** What failed and crashed runs cost, per goal closed. Null when none closed. */
  lostCostPerGoalUsd: number | null;
  redsPerGoal: number | null;
  /** Reopened goals as a share of the cohort. Null when none closed. */
  reopenedRate: number | null;
}

/** A phase's dollars in each half, so the panel's load-bearing table is a fold, not a join. */
export interface SpendTrendPhaseShift {
  phase: SpendPhase;
  label: string;
  /** Mean dollars per goal, earlier half then recent half. */
  earlierUsd: number;
  recentUsd: number;
  /** Share of the mean goal's cost, 0–1. The column that misleads without the two above. */
  earlierShare: number;
  recentShare: number;
  /** `(recent - earlier) / earlier`, or null when the phase cost nothing earlier. */
  changeRatio: number | null;
}

/** The two halves and the shift between them, or nothing when the window is too thin. */
export interface SpendTrendComparison {
  earlier: SpendTrendPeriod;
  recent: SpendTrendPeriod;
  phases: SpendTrendPhaseShift[];
}

export interface SpendTrend {
  generatedAt: string;
  /** The span, stated rather than assumed by the panel. */
  weeks: number;
  bucketMs: number;
  startsAt: string;
  buckets: SpendTrendWeek[];
  /**
   * The complete weeks split down the middle. Null when the window holds fewer
   * than {@link MIN_HALF_WEEKS} complete weeks either side — a comparison drawn
   * off one week of goals is noise with a percentage sign on it, and refusing to
   * ship it is the only way the panel can be made to refuse to draw it.
   */
  comparison: SpendTrendComparison | null;
}

interface SpendTrendInput {
  /**
   * Every goal with measured spend — `buildSpendInsights`'s own rows, taken whole.
   * A second roll-up here would be a second opinion about which goal a pull
   * request's money belongs to, which is the thing `rollUpIssueSpend` exists to
   * prevent.
   */
  goals: readonly SpendGoal[];
  /** `issue_closed` rows inside the window. */
  closures: readonly WorldEvent[];
  /** The world's issues as they stand — for the reopen check, and nothing else. */
  issues: readonly Issue[];
  /** Every agent the harness has run; the period half selects by `endedAt` itself. */
  agents: readonly Agent[];
  /** `pr_ci` rows inside the window. Order is not read — only the count of reds is. */
  ciEvents: readonly WorldEvent[];
  now: number;
}

/** The middle sample, or the upper of the two middles. Null on an empty set. */
function median(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

/** `issue:12` → 12. Null for a ref naming anything else, which a closure never does. */
function issueNumberOf(ref: string | null): number | null {
  const found = ref === null ? undefined : /^issue:(\d+)$/.exec(ref)?.[1];
  return found === undefined ? null : Number(found);
}

/** An empty week — every field present, so a week nothing happened in is a row and not a gap. */
function emptyWeek(startsAt: string, partial: boolean): SpendTrendWeek {
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
  const { goals, closures, issues, agents, ciEvents, now } = input;
  const start = now - TREND_WEEKS * WEEK_MS;
  const buckets = Array.from({ length: TREND_WEEKS }, (_, i) =>
    emptyWeek(new Date(start + i * WEEK_MS).toISOString(), i === TREND_WEEKS - 1),
  );
  /** Which bucket an instant falls in, or null when it predates the window. */
  const bucketAt = (at: number): number | null => {
    if (Number.isNaN(at) || at < start) return null;
    return Math.min(TREND_WEEKS - 1, Math.floor((at - start) / WEEK_MS));
  };

  const spendOfGoal = new Map(goals.map((g) => [g.issueNumber, g]));
  // Open *now*, so a goal that closed inside the window and is nonetheless here
  // came back. See `SpendTrendWeek.reopened` for why this is read from state
  // rather than from an event.
  const openNow = new Set(issues.filter((i) => i.state === 'open').map((i) => i.number));

  // The last closure per goal, because a goal that closed, reopened and closed
  // again belongs to the week it last landed in — not to the first attempt.
  const closedAt = new Map<number, number>();
  for (const event of closures) {
    const issueNumber = issueNumberOf(event.ref);
    if (issueNumber === null) continue;
    const at = Date.parse(event.createdAt);
    if (Number.isNaN(at)) continue;
    const seen = closedAt.get(issueNumber);
    if (seen === undefined || at > seen) closedAt.set(issueNumber, at);
  }

  // -- Cohort: goals, by the week they closed --------------------------------
  // The cohort itself is kept, not just its summary: the period fold below needs
  // the goals, and re-deriving them from the week rows would be a join over a
  // figure (cost) that two goals are free to share.
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
    // Per goal, not the cohort's total: a busy week would otherwise draw as an
    // expensive one, which is the confusion the unit choice exists to avoid.
    for (const phase of PHASE_ORDER) {
      const total = cohort.reduce((n, g) => n + g.byPhase[phase], 0);
      week.byPhase[phase] = roundUsd(total / cohort.length);
    }
  }

  // -- Period: runs that settled, and reds observed ---------------------------
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
    weeks: TREND_WEEKS,
    bucketMs: WEEK_MS,
    startsAt: new Date(start).toISOString(),
    buckets,
    comparison: compare(buckets, cohorts),
  };
}

/**
 * The complete weeks, split in half.
 *
 * The partial week is dropped rather than folded into the recent half: it is an
 * under-count by construction, and an under-counted recent half is exactly the
 * shape that makes a fleet look like it is improving on the day it is read.
 */
function compare(
  buckets: readonly SpendTrendWeek[],
  cohorts: ReadonlyMap<number, SpendGoal[]>,
): SpendTrendComparison | null {
  const complete = buckets.map((week, index) => ({ week, index })).filter((b) => !b.week.partial);
  const half = Math.floor(complete.length / 2);
  if (half < MIN_HALF_WEEKS) return null;
  const earlier = fold(complete.slice(0, half), cohorts);
  const recent = fold(complete.slice(complete.length - half), cohorts);
  return { earlier, recent, phases: shifts(earlier, recent) };
}

/**
 * Several weeks as one period.
 *
 * The medians are re-taken over the pooled goals rather than averaged from each
 * week's own median, which would be a median of medians — a figure that is not
 * the middle of anything and moves when a quiet week is added. The phase means
 * are pooled for the same reason: a week that closed one goal must not get the
 * same say as a week that closed nine.
 */
function fold(
  span: readonly { week: SpendTrendWeek; index: number }[],
  cohorts: ReadonlyMap<number, SpendGoal[]>,
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
    endsAt: new Date(Date.parse(last?.startsAt ?? first?.startsAt ?? '') + WEEK_MS).toISOString(),
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

/** Every phase either half spent anything on, in funnel order. */
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

/** How far back {@link buildSpendTrend} wants dated rows — the route's `since`. */
export function spendTrendSince(now: number): string {
  return new Date(now - TREND_WEEKS * WEEK_MS).toISOString();
}
