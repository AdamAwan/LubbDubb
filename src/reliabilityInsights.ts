import type { Agent, AgentStatus, Task, UsageEvent, WorldEvent } from './types.js';
import { roundUsd } from './issueSpend.js';
import { phaseLabel, phaseOf, type SpendPhase } from './spendInsights.js';
import { ciStatusOf } from './world/worldDiff.js';

/**
 * The reliability breakdown: does the work the fleet starts finish, and does what
 * it opens go green.
 *
 * The spend panel answers *where the money went* and stops exactly one question
 * short of the one an operator asks next — **what did it buy**. A phase total
 * cannot answer that, because a run that crashed on its third turn and a run that
 * merged a pull request are the same dollars there. Two readings answer it, and
 * they are the two halves of the same funnel:
 *
 * - **Run outcomes** — of the agents the harness has dispatched, how many ended
 *   `done`, and what the rest cost. Split by the *same phases* the spend panel
 *   uses, so "assayers always finish, part agents crash a third of the time" is a
 *   sentence the two panels can be read into together.
 * - **CI health** — how often a pull request went red, how long it stayed red, and
 *   which ones did it repeatedly. The spend panel's `landing` phase already
 *   argues that "a goal whose landing dwarfs its build is not an expensive goal,
 *   it is a flaky pipeline"; this is the reading that settles which one it is, and
 *   it carries the landing spend of the same window so the flakiness has a price
 *   next to it.
 *
 * ## Why the two halves are windowed differently
 *
 * Run outcomes are **all-time** and CI health is **the last fortnight**, which
 * looks inconsistent and is deliberate. A completion rate is a property of the
 * harness and wants every run it has ever done behind it; a red rate is a property
 * of a pipeline *as it stands*, and folding in a suite that was fixed a month ago
 * describes a repository that no longer exists. Both windows are stated in the
 * payload rather than assumed by the panel.
 *
 * ## One classifier, one matcher
 *
 * Phases come from `spendInsights.phaseOf` and CI statuses from
 * `worldDiff.ciStatusOf` — neither is re-derived here. That is the same rule the
 * spend module keeps about goal attribution, for the same reason: a second
 * opinion drawn a panel away from the first is free to disagree silently, and on
 * exactly the shapes the two classify differently.
 *
 * ## Derived, never stored
 *
 * Everything here folds records that are already durable and already dated — the
 * `agents` rows, `usage_events`, and the `pr_ci` rows of `world_events`, none of
 * which anything prunes. A table of pre-summed reliability would be a copy that
 * goes stale the moment an agent exits.
 */

/** How far back the CI half reaches, and at what resolution — the spend trend's window. */
const WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** How many rows the two rankings carry. Both are rankings, and both say the cap out loud. */
const TOP_ROWS = 10;

/**
 * How a run ended. The live statuses (`starting`, `running`, `waiting`) are not
 * outcomes and are counted separately: a rate that folded them in would fall every
 * time the fleet got busy.
 */
export type RunOutcome = Extract<AgentStatus, 'done' | 'failed' | 'crashed' | 'killed' | 'interrupted'>;

/** Reading order: the one good end, the two failures, the two stops. */
const OUTCOME_ORDER: readonly RunOutcome[] = ['done', 'failed', 'crashed', 'killed', 'interrupted'];

/**
 * The outcomes that are the harness failing, as opposed to it being stopped.
 *
 * `killed` and `interrupted` are an operator's doing and a crash is not, and the
 * difference is the whole reason the completion rate is not just `done` over
 * everything: a fleet an operator steers is not an unreliable one. They are still
 * shown, because money spent on a run someone stopped is money spent.
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
 * An origin the harness ran more than once.
 *
 * Repetition is not failure — a part agent that lands, then answers review
 * comments, legitimately runs twice — so this is a ranking to read, never a count
 * of mistakes. What makes it worth a table is that the expensive kind of
 * repetition looks exactly like the cheap kind on every other surface: a goal
 * whose card shows one number quietly went round four times.
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
 * The headline count, folded once and read in two places.
 *
 * This rides on `/api/state` as well as on this panel, because the Yield gauge
 * has to draw a completion rate without fetching and the panel has to open by
 * agreeing with the gauge it was clicked from. Two folds of the same agent rows,
 * a panel apart, is the disagreement the spend module already refuses to make
 * about goal totals — so there is one fold, and both sides call it.
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
   * Settled runs that reported no usage at all — PTY throughout, or dead before
   * the first result. They are counted in every *rate* here (an outcome is
   * observed whether or not a dollar was) and in no *dollar*. Shipped for the
   * reason the spend panel ships its own: otherwise nothing says how much of the
   * fleet the money figures speak for.
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
   * `reds / (reds + greens)` — of the CI runs that reached a verdict in this
   * window, the share that went red. Null when neither was observed, which is a
   * different answer from zero and the panel must say so: a harness that has
   * watched no pull request has not got a clean pipeline.
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
   * What the `landing` phase cost inside this window — the price of everything
   * above, in the spend panel's own vocabulary.
   *
   * Summed from dated `usage_events` rather than from whole agent rows, because
   * the question is what was spent *in the window*: an agent that started before
   * it would otherwise drop its entire cost into a fortnight it barely touched.
   */
  landingCostUsd: number;
  timeline: { bucketMs: number; startsAt: string; buckets: CiBucket[] };
}

export interface ReliabilityInsights {
  generatedAt: string;
  /** The CI half's window, and the timelines' span. Stated rather than assumed by the panel. */
  windowDays: number;
  runs: RunHealth;
  ci: CiHealth;
}

interface ReliabilityInput {
  /** Every agent the harness has ever run — the run half is all-time. */
  agents: readonly Agent[];
  tasks: readonly Task[];
  /** `pr_ci` rows inside the window, oldest first (`listWorldEventsOfKindsSince`). */
  ciEvents: readonly WorldEvent[];
  /** Dated cost deltas inside the same window, for the landing figure. */
  usageEvents: readonly UsageEvent[];
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

/** Which bucket an instant falls in, or null when it predates the window. */
function bucketIndex(at: number, start: number): number | null {
  if (Number.isNaN(at) || at < start) return null;
  return Math.min(WINDOW_DAYS - 1, Math.floor((at - start) / DAY_MS));
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
  const { now } = input;
  return {
    generatedAt: new Date(now).toISOString(),
    windowDays: WINDOW_DAYS,
    runs: buildRunHealth(input),
    ci: buildCiHealth(input),
  };
}

function buildRunHealth({ agents, tasks, now }: ReliabilityInput): RunHealth {
  const originOfTask = new Map(tasks.map((t) => [t.id, t.originRef]));
  const titleOfTask = new Map(tasks.map((t) => [t.id, t.title]));
  const start = now - WINDOW_DAYS * DAY_MS;

  const health: RunHealth = {
    // The headline counts come from the fold the snapshot uses, never from the
    // loop below: the panel must open agreeing with the gauge it was clicked
    // from, and agreement by construction is the only kind that holds.
    ...tallyRunOutcomes(agents),
    costUsd: 0,
    lostCostUsd: 0,
    unmeasuredRuns: 0,
    byOutcome: [],
    byPhase: [],
    repeats: [],
    repeatedOrigins: 0,
    timeline: {
      bucketMs: DAY_MS,
      startsAt: new Date(start).toISOString(),
      buckets: Array.from({ length: WINDOW_DAYS }, (_, i) => ({
        startsAt: new Date(start + i * DAY_MS).toISOString(),
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
    if (agent.costUsd === null) health.unmeasuredRuns += 1;
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
    // Both ends or nothing: a run whose end was never stamped has no duration to
    // guess at, and clock-skewed negatives are dropped rather than clamped to zero
    // — a zero here would drag the median toward a number nothing took.
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
      // The title of the *latest* run, not the first: an origin picked up again
      // after a replan is best named by what it was last asked to do.
      if (at >= seen.lastAt) {
        seen.lastAt = at;
        seen.title = titleOfTask.get(agent.taskId) ?? null;
      }
      repeats.set(originRef, seen);
    }

    const index = bucketIndex(Date.parse(agent.endedAt ?? agent.startedAt), start);
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

function buildCiHealth({ agents, tasks, ciEvents, usageEvents, now }: ReliabilityInput): CiHealth {
  const start = now - WINDOW_DAYS * DAY_MS;
  const buckets: CiBucket[] = Array.from({ length: WINDOW_DAYS }, (_, i) => ({
    startsAt: new Date(start + i * DAY_MS).toISOString(),
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
    // `pending` and `unknown` are not verdicts: a rerun passing through pending on
    // its way back to green must not end the red span, or every retry would read
    // as a recovery that took no time.
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
    };

    if (status === 'failing') {
      reds += 1;
      subject.reds += 1;
      const bucket = buckets[bucketIndex(at, start) ?? -1];
      if (bucket) bucket.red += 1;
      // A second failure while already red — a rerun that failed again — is
      // another red, and it does not restart the clock. The pull request has been
      // unlanded continuously since the first one, which is what redMs measures.
      if (!redSince.has(event.ref)) redSince.set(event.ref, at);
    } else {
      greens += 1;
      subject.greens += 1;
      const bucket = buckets[bucketIndex(at, start) ?? -1];
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

  // A red with no green after it is still red *now*, so its span runs to the read
  // rather than to its last event. Left out, the reddest pull request on the
  // board — the one nobody has fixed — would show the least red time.
  for (const [ref, since] of redSince) {
    const subject = subjects.get(ref);
    if (!subject) continue;
    subject.stillRed = true;
    subject.redMs += now - since;
  }

  const originOfTask = new Map(tasks.map((t) => [t.id, t.originRef]));
  const landingAgents = new Set(
    agents.filter((a) => phaseOf(originOfTask.get(a.taskId) ?? null) === 'landing').map((a) => a.id),
  );
  const landingCostUsd = usageEvents
    .filter((e) => landingAgents.has(e.agentId) && Date.parse(e.at) >= start)
    .reduce((sum, e) => roundUsd(sum + e.costUsd), 0);

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
    landingCostUsd,
    timeline: { bucketMs: DAY_MS, startsAt: new Date(start).toISOString(), buckets },
  };
}

/** How far back {@link buildReliabilityInsights} wants dated rows — the route's `since`. */
export function reliabilityWindowSince(now: number): string {
  return new Date(now - WINDOW_DAYS * DAY_MS).toISOString();
}
