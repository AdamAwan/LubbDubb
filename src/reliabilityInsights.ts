import type { Agent, AgentStatus, TaskSummary, UsageEvent, WorldEvent } from './types.js';
import { prNodeRefOf, roundUsd, unmeasured } from './issueSpend.js';
import { phaseLabel, phaseOf, type SpendPhase } from './spendInsights.js';
import { ciStatusOf } from './world/worldDiff.js';
import {
  bucketIndexIn,
  runInWindow,
  runInstant,
  timelineSpan,
  windowView,
  type InsightsWindowView,
  type ResolvedWindow,
  type TimelineSpan,
} from './insightsWindow.js';

/**
 * The reliability breakdown: does the work the fleet starts finish, and does what it opens
 * go green. Two readings — run outcomes (how the dispatched agents ended, and what the rest
 * cost, split by the spend panel's own phases) and CI health (how often a pull request went
 * red, how long it stayed red, and what answering it cost, fleet-wide and per pull request).
 *
 * **One classifier, one matcher**: phases come from `spendInsights.phaseOf` and CI statuses
 * from `worldDiff.ciStatusOf`, never re-derived here — a second opinion a panel away is free
 * to disagree silently on exactly the shapes the two classify differently.
 *
 * Derived, never stored: everything folds records that are already durable and dated.
 */

/** How many rows the two rankings carry. Both are rankings, and both say the cap out loud. */
const TOP_ROWS = 10;

/**
 * How a run ended. The live statuses are not outcomes and are counted separately: a rate
 * that folded them in would fall every time the fleet got busy.
 */
export type RunOutcome = Extract<AgentStatus, 'done' | 'failed' | 'crashed' | 'killed' | 'interrupted'>;

/** Reading order: the one good end, the two failures, the two stops. */
const OUTCOME_ORDER: readonly RunOutcome[] = ['done', 'failed', 'crashed', 'killed', 'interrupted'];

/**
 * The outcomes that are the harness failing, as opposed to it being stopped. `killed` and
 * `interrupted` are an operator's doing, which is why the completion rate is not `done` over
 * everything; they are still shown, because money spent on a stopped run is money spent.
 */
const LOST: readonly RunOutcome[] = ['failed', 'crashed'];

/** What each ending is, in the operator's words. Shipped with the figures, as the phase copy is. */
const OUTCOME_COPY: Record<RunOutcome, { label: string; blurb: string }> = {
  done: { label: 'Finished', blurb: 'The agent ran to its own end' },
  failed: { label: 'Failed', blurb: 'The process exited non-zero — the harness did not stop it' },
  crashed: { label: 'Crashed', blurb: 'Found dead at boot: the server went down with the agent still out' },
  killed: { label: 'Killed', blurb: 'An operator stopped it, or the harness reclaimed its slot' },
  interrupted: { label: 'Interrupted', blurb: 'Cut short mid-run and left recoverable' },
};

export interface RunOutcomeTotal {
  outcome: RunOutcome;
  label: string;
  blurb: string;
  runs: number;
  /** What runs ending this way cost. Measured runs only — see {@link RunHealth.unmeasuredRuns}. */
  costUsd: number;
}

/** One phase's record, in the spend panel's vocabulary and with its label. */
export interface RunPhaseHealth {
  phase: SpendPhase;
  label: string;
  /** Runs that have ended. The denominator for everything else in the row. */
  settled: number;
  completed: number;
  /** Failed or crashed. */
  lost: number;
  /** Killed or interrupted — someone's decision, not a fault. */
  stopped: number;
  /** `completed / settled`, or null when nothing in this phase has ended yet. */
  completionRate: number | null;
  /** What the lost runs cost — the phase's waste, in dollars. */
  lostCostUsd: number;
  /** Median wall-clock of a settled run, ms. Null when none reported both ends. */
  medianMs: number | null;
}

/**
 * An origin the harness ran more than once. Repetition is not failure — a part agent that
 * lands and then answers review comments legitimately runs twice — so this is a ranking to
 * read, never a count of mistakes.
 */
export interface RunRepeat {
  originRef: string;
  /** The task's title, from the most recent run on this origin. */
  title: string | null;
  runs: number;
  lost: number;
  costUsd: number;
  lastAt: string;
}

interface RunBucket {
  startsAt: string;
  settled: number;
  lost: number;
}

/**
 * The headline count, folded once and read in two places: this rides on `/api/state` for the
 * Yield gauge as well as on the panel, which must open agreeing with the gauge it was
 * clicked from. One fold, both callers.
 */
export interface RunTally {
  /** Runs that have ended — the denominator for everything derived from it. */
  settled: number;
  /** Runs still out. Not in any rate: an unfinished run has no outcome yet. */
  live: number;
  completed: number;
  /** Failed or crashed — the harness's own faults. */
  lost: number;
  /** Killed or interrupted — someone's decision, counted apart from a fault. */
  stopped: number;
  /** `completed / settled`, or null when nothing has ended yet. */
  completionRate: number | null;
}

/**
 * Not exported: the cockpit reaches it as `ReliabilityInsights['runs']`, and an
 * export nothing names by name is what `knip` is set to `error` to catch.
 */
interface RunHealth extends RunTally {
  /** Every settled run's cost, so the waste has a whole to be a share of. */
  costUsd: number;
  lostCostUsd: number;
  /**
   * Settled runs that reported no usage at all. Counted in every *rate* here — an outcome is
   * observed whether or not a dollar was — and in no *dollar*.
   */
  unmeasuredRuns: number;
  byOutcome: RunOutcomeTotal[];
  byPhase: RunPhaseHealth[];
  /** The {@link TOP_ROWS} most-repeated origins, most runs first. */
  repeats: RunRepeat[];
  /** How many origins ran more than once, so the ranking's cap can be stated. */
  repeatedOrigins: number;
  /** Settled runs bucketed by when they ended — the only dated half of this reading. */
  timeline: { bucketMs: number; startsAt: string; buckets: RunBucket[] };
}

/** One pull request's CI record inside the window. */
export interface CiSubject {
  ref: string;
  prNumber: number | null;
  /** Transitions into failing. */
  reds: number;
  /** Transitions into passing. */
  greens: number;
  /** How long this pull request spent red inside the window, ms. */
  redMs: number;
  /** True when it was still red at the window's end — its `redMs` is still running. */
  stillRed: boolean;
  /**
   * What the `ci` phase spent on *this* pull request inside the window. Beside `reds` this is
   * a **cost per red, not a cost per fix**: one agent often answers several reds at once.
   * Windowed from dated `usage_events` like {@link CiHealth.ciCostUsd}, so an agent that
   * started before the window does not drop its whole cost into it.
   */
  costUsd: number;
}

interface CiBucket {
  startsAt: string;
  red: number;
  green: number;
}

export interface CiHealth {
  reds: number;
  greens: number;
  /**
   * `reds / (reds + greens)` over the CI runs that reached a verdict in this window. Null
   * when neither was observed — a different answer from zero, and the panel must say so.
   */
  redRate: number | null;
  /** Pull requests that went red at least once. */
  prsAffected: number;
  /** Pull requests observed transitioning at all — what the above is out of. */
  prsObserved: number;
  /** Reds that were followed by a green inside the window. */
  recoveries: number;
  medianToGreenMs: number | null;
  slowestToGreenMs: number | null;
  /** Reds with no green after them yet. Their red time is still accruing. */
  unrecovered: number;
  /** The {@link TOP_ROWS} reddest pull requests, most reds first. */
  flakiest: CiSubject[];
  /**
   * What the `ci` phase cost inside this window. Summed from dated `usage_events` rather than
   * whole agent rows: an agent that started before the window would otherwise drop its entire
   * cost into it.
   */
  ciCostUsd: number;
  /**
   * What the rest of landing cost over the same window — review comments, the merge, a
   * retarget. Beside `ciCostUsd` rather than folded in, so the price of a red pipeline is not
   * mixed with the cost of being reviewed.
   */
  landingCostUsd: number;
  timeline: { bucketMs: number; startsAt: string; buckets: CiBucket[] };
}

export interface ReliabilityInsights {
  generatedAt: string;
  /**
   * The stretch both halves were measured over — one window for the runs and the CI alike, so
   * a completion rate and a red rate drawn side by side describe the same stretch.
   */
  window: InsightsWindowView;
  runs: RunHealth;
  ci: CiHealth;
}

interface ReliabilityInput {
  /** Every agent the harness has ever run. Cut to the window here, once, below. */
  agents: readonly Agent[];
  tasks: readonly TaskSummary[];
  /** `pr_ci` rows inside the window, oldest first (`listWorldEventsOfKindsSince`). */
  ciEvents: readonly WorldEvent[];
  /** Dated cost deltas inside the same window, for the landing figure. */
  usageEvents: readonly UsageEvent[];
  /** The stretch to measure — both halves obey it. */
  window: ResolvedWindow;
  now: number;
}

/** Whether a status is an ending. The live three are not outcomes. */
function outcomeOf(status: AgentStatus): RunOutcome | null {
  return OUTCOME_ORDER.includes(status as RunOutcome) ? (status as RunOutcome) : null;
}

/** The middle sample, or the upper of the two middles. Null on an empty set. */
function median(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

/** `pr:42` → 42. Null for a ref that names something else, which nothing should. */
function prNumberOf(ref: string): number | null {
  const found = /^pr:(\d+)$/.exec(ref)?.[1];
  return found === undefined ? null : Number(found);
}

/**
 * How the fleet's runs have ended, all-time. The one fold behind both the Yield
 * gauge and the panel it opens.
 */
export function tallyRunOutcomes(agents: readonly Agent[]): RunTally {
  const tally: RunTally = { settled: 0, live: 0, completed: 0, lost: 0, stopped: 0, completionRate: null };
  for (const agent of agents) {
    const outcome = outcomeOf(agent.status);
    if (outcome === null) {
      tally.live += 1;
      continue;
    }
    tally.settled += 1;
    if (outcome === 'done') tally.completed += 1;
    else if (LOST.includes(outcome)) tally.lost += 1;
    else tally.stopped += 1;
  }
  tally.completionRate = tally.settled > 0 ? tally.completed / tally.settled : null;
  return tally;
}

export function buildReliabilityInsights(input: ReliabilityInput): ReliabilityInsights {
  const { now, window } = input;
  // Cut once, at the door, so both halves fold the same population: two rates on one surface
  // over two different stretches is a disagreement a reader cannot see.
  const windowed: ReliabilityInput = {
    ...input,
    agents: input.agents.filter((agent) => runInWindow(window, agent)),
  };
  const span = timelineSpan(
    window,
    // The oldest thing the axis could be about, over **both** populations the timeline
    // buckets. Off the agents alone, an unbounded window draws an axis starting after CI
    // history it is counting, and the graph disagrees with the headline above it.
    [...windowed.agents.map(runInstant), ...input.ciEvents.map((e) => Date.parse(e.createdAt))].reduce<number | null>(
      (oldest, at) => (Number.isNaN(at) ? oldest : oldest === null || at < oldest ? at : oldest),
      null,
    ),
  );
  return {
    generatedAt: new Date(now).toISOString(),
    window: windowView(window, span),
    runs: buildRunHealth(windowed, span),
    ci: buildCiHealth(windowed, span),
  };
}

function buildRunHealth({ agents, tasks }: ReliabilityInput, span: TimelineSpan): RunHealth {
  const originOfTask = new Map(tasks.map((t) => [t.id, t.originRef]));
  const titleOfTask = new Map(tasks.map((t) => [t.id, t.title]));

  const health: RunHealth = {
    // The headline counts come from the fold that owns the question, never from the loop
    // below: two counts of one population is the disagreement this reading least survives.
    ...tallyRunOutcomes(agents),
    costUsd: 0,
    lostCostUsd: 0,
    unmeasuredRuns: 0,
    byOutcome: [],
    byPhase: [],
    repeats: [],
    repeatedOrigins: 0,
    timeline: {
      bucketMs: span.bucketMs,
      startsAt: new Date(span.startMs).toISOString(),
      buckets: Array.from({ length: span.buckets }, (_, i) => ({
        startsAt: new Date(span.startMs + i * span.bucketMs).toISOString(),
        settled: 0,
        lost: 0,
      })),
    },
  };

  const outcomes = new Map<RunOutcome, RunOutcomeTotal>();
  const phases = new Map<SpendPhase, RunPhaseHealth & { durations: number[] }>();
  const repeats = new Map<string, RunRepeat>();

  for (const agent of agents) {
    const outcome = outcomeOf(agent.status);
    if (outcome === null) continue;
    const cost = agent.costUsd ?? 0;
    const lost = LOST.includes(outcome);
    const originRef = originOfTask.get(agent.taskId) ?? null;
    const phase = phaseOf(originRef);

    health.costUsd = roundUsd(health.costUsd + cost);
    if (unmeasured(agent)) health.unmeasuredRuns += 1;
    if (lost) health.lostCostUsd = roundUsd(health.lostCostUsd + cost);

    const total = outcomes.get(outcome) ?? { outcome, ...OUTCOME_COPY[outcome], runs: 0, costUsd: 0 };
    total.runs += 1;
    total.costUsd = roundUsd(total.costUsd + cost);
    outcomes.set(outcome, total);

    const row = phases.get(phase) ?? {
      phase,
      label: phaseLabel(phase),
      settled: 0,
      completed: 0,
      lost: 0,
      stopped: 0,
      completionRate: null,
      lostCostUsd: 0,
      medianMs: null,
      durations: [],
    };
    row.settled += 1;
    if (outcome === 'done') row.completed += 1;
    else if (lost) {
      row.lost += 1;
      row.lostCostUsd = roundUsd(row.lostCostUsd + cost);
    } else row.stopped += 1;
    // Both ends or nothing, and clock-skewed negatives are dropped rather than clamped: a
    // zero would drag the median toward a duration nothing took.
    if (agent.endedAt !== null) {
      const ms = Date.parse(agent.endedAt) - Date.parse(agent.startedAt);
      if (Number.isFinite(ms) && ms >= 0) row.durations.push(ms);
    }
    phases.set(phase, row);

    if (originRef !== null) {
      const seen = repeats.get(originRef) ?? {
        originRef,
        title: null,
        runs: 0,
        lost: 0,
        costUsd: 0,
        lastAt: '',
      };
      seen.runs += 1;
      if (lost) seen.lost += 1;
      seen.costUsd = roundUsd(seen.costUsd + cost);
      const at = agent.endedAt ?? agent.startedAt;
      // The latest run's title, not the first: an origin picked up again after a replan is
      // best named by what it was last asked to do.
      if (at >= seen.lastAt) {
        seen.lastAt = at;
        seen.title = titleOfTask.get(agent.taskId) ?? null;
      }
      repeats.set(originRef, seen);
    }

    const index = bucketIndexIn(span, runInstant(agent));
    const bucket = index === null ? undefined : health.timeline.buckets[index];
    if (bucket) {
      bucket.settled += 1;
      if (lost) bucket.lost += 1;
    }
  }

  const repeated = [...repeats.values()].filter((r) => r.runs > 1);
  health.byOutcome = OUTCOME_ORDER.map((o) => outcomes.get(o)).filter((o): o is RunOutcomeTotal => o !== undefined);
  health.byPhase = [...phases.values()]
    .map(({ durations, ...row }) => ({
      ...row,
      completionRate: row.completed / row.settled,
      medianMs: median(durations),
    }))
    .sort((a, b) => b.settled - a.settled || a.phase.localeCompare(b.phase));
  health.repeats = repeated.sort((a, b) => b.runs - a.runs || b.costUsd - a.costUsd).slice(0, TOP_ROWS);
  health.repeatedOrigins = repeated.length;
  return health;
}

function buildCiHealth({ agents, tasks, ciEvents, usageEvents, now }: ReliabilityInput, span: TimelineSpan): CiHealth {
  const buckets: CiBucket[] = Array.from({ length: span.buckets }, (_, i) => ({
    startsAt: new Date(span.startMs + i * span.bucketMs).toISOString(),
    red: 0,
    green: 0,
  }));

  const subjects = new Map<string, CiSubject>();
  /** When each ref went red and has not gone green since. The whole of the fold's state. */
  const redSince = new Map<string, number>();
  const recoveries: number[] = [];
  let reds = 0;
  let greens = 0;

  for (const event of ciEvents) {
    const status = ciStatusOf(event);
    // `pending` and `unknown` are not verdicts: a rerun passing through pending must not end
    // the red span, or every retry would read as an instant recovery.
    if (event.ref === null || (status !== 'failing' && status !== 'passing')) continue;
    const at = Date.parse(event.createdAt);
    if (Number.isNaN(at)) continue;

    const subject = subjects.get(event.ref) ?? {
      ref: event.ref,
      prNumber: prNumberOf(event.ref),
      reds: 0,
      greens: 0,
      redMs: 0,
      stillRed: false,
      costUsd: 0,
    };

    if (status === 'failing') {
      reds += 1;
      subject.reds += 1;
      const bucket = buckets[bucketIndexIn(span, at) ?? -1];
      if (bucket) bucket.red += 1;
      // A second failure while already red is another red and does not restart the clock:
      // the pull request has been unlanded continuously since the first.
      if (!redSince.has(event.ref)) redSince.set(event.ref, at);
    } else {
      greens += 1;
      subject.greens += 1;
      const bucket = buckets[bucketIndexIn(span, at) ?? -1];
      if (bucket) bucket.green += 1;
      const since = redSince.get(event.ref);
      if (since !== undefined) {
        recoveries.push(at - since);
        subject.redMs += at - since;
        redSince.delete(event.ref);
      }
    }
    subjects.set(event.ref, subject);
  }

  // A red with no green after it is still red now, so its span runs to the read: left out,
  // the pull request nobody has fixed would show the least red time.
  for (const [ref, since] of redSince) {
    const subject = subjects.get(ref);
    if (!subject) continue;
    subject.stillRed = true;
    subject.redMs += now - since;
  }

  // Which pull-request phase each run belongs to, and for a CI run the `pr:<n>` its money is
  // about. The classifier decides; the ref is never re-read here.
  const originOfTask = new Map(tasks.map((t) => [t.id, t.originRef]));
  const prRuns = new Map<string, { phase: 'ci' | 'landing'; ref: string | null }>();
  for (const agent of agents) {
    const originRef = originOfTask.get(agent.taskId) ?? null;
    const phase = phaseOf(originRef);
    if (phase !== 'ci' && phase !== 'landing') continue;
    prRuns.set(agent.id, { phase, ref: originRef === null ? null : prNodeRefOf(originRef) });
  }

  let ciCostUsd = 0;
  let landingCostUsd = 0;
  for (const event of usageEvents) {
    const run = prRuns.get(event.agentId);
    // Against the **span**, not `window.startMs`: the span is the axis the bars are drawn on,
    // and a cost admitted before it would be in the total and in no bar.
    if (run === undefined || Date.parse(event.at) < span.startMs) continue;
    if (run.phase === 'landing') {
      landingCostUsd = roundUsd(landingCostUsd + event.costUsd);
      continue;
    }
    ciCostUsd = roundUsd(ciCostUsd + event.costUsd);
    // A CI run whose pull request reported no verdict in this window has no row to land on:
    // in the total above, in none of the rows below.
    const subject = run.ref === null ? undefined : subjects.get(run.ref);
    if (subject) subject.costUsd = roundUsd(subject.costUsd + event.costUsd);
  }

  const ranked = [...subjects.values()].sort((a, b) => b.reds - a.reds || b.redMs - a.redMs);
  return {
    reds,
    greens,
    redRate: reds + greens > 0 ? reds / (reds + greens) : null,
    prsAffected: ranked.filter((s) => s.reds > 0).length,
    prsObserved: ranked.length,
    recoveries: recoveries.length,
    medianToGreenMs: median(recoveries),
    slowestToGreenMs: recoveries.length > 0 ? Math.max(...recoveries) : null,
    unrecovered: redSince.size,
    flakiest: ranked.filter((s) => s.reds > 0).slice(0, TOP_ROWS),
    ciCostUsd,
    landingCostUsd,
    timeline: { bucketMs: span.bucketMs, startsAt: new Date(span.startMs).toISOString(), buckets },
  };
}
