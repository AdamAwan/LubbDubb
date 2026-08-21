/**
 * The window every insights reading is measured over.
 *
 * Before this, each reading picked its own span and none of them lined up: the
 * production graph counted six hours, the spend tiles five and seven days, the
 * spend timeline a fortnight, the CI half another fortnight, the trend eight
 * weeks — and the run half of reliability and the spend totals were all-time, so
 * two figures side by side on one surface described different stretches of the
 * fleet's life. Nothing said so, and a number moving in one panel could not be
 * read against a number in another. This is that decision made once, in one
 * place, and passed down: the cockpit picks a key, the routes resolve it here,
 * and every fold under them measures the same stretch.
 *
 * **`all` is genuinely unbounded**, which is what makes it worth having: it is
 * the reading the panels used to give by default, and folding it into a long
 * fixed span would quietly drop the deployment that has been running since
 * March. {@link ResolvedWindow.startMs} is therefore `null` for it, and every
 * fold reads that as "no lower bound" rather than as a date. A *timeline* still
 * needs two ends, so {@link timelineSpan} takes the earliest datum the caller
 * actually holds and divides what it finds — the buckets describe the history
 * that exists rather than a span guessed at here.
 *
 * → docs/spec/18-observability.md#the-window, docs/spec/17-cockpit.md#the-time-bar
 */

import { z } from 'zod';

/** The windows the cockpit offers, in the order the control draws them. */
export type InsightsWindow = '6h' | '24h' | '7d' | '30d' | 'all';

const INSIGHTS_WINDOWS: readonly InsightsWindow[] = ['6h', '24h', '7d', '30d', 'all'];

/**
 * What the page opens on.
 *
 * A week rather than a day: the fleet's own rhythm is a working week, and a
 * deployment whose agents ran on Tuesday should not open on Thursday to a page
 * of zeroes and conclude the harness does nothing.
 */
const DEFAULT_INSIGHTS_WINDOW: InsightsWindow = '7d';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How many buckets an unbounded window's timeline is cut into, and the shortest
 * history worth cutting.
 *
 * A harness two hours old has no eight-week story to tell, and dividing two
 * hours into twenty-six buckets draws a graph of noise at four-minute
 * resolution. The floor is what stops that.
 */
const ALL_BUCKETS = 26;
const ALL_MIN_SPAN_MS = 7 * DAY_MS;

interface WindowShape {
  spanMs: number;
  bucketMs: number;
  buckets: number;
  label: string;
  bucketLabel: string;
}

/**
 * Each window's span and the resolution it is drawn at.
 *
 * The bucket count is stated rather than derived from `spanMs / bucketMs`,
 * because the two must agree and a derived count hides the disagreement: a span
 * that is not a whole number of buckets silently draws a final bucket covering
 * less time than the ones beside it, which is a bar shorter for a reason nothing
 * on the glass gives.
 */
const SHAPES: Record<Exclude<InsightsWindow, 'all'>, WindowShape> = {
  '6h': { spanMs: 6 * HOUR_MS, bucketMs: 30 * MINUTE_MS, buckets: 12, label: '6h', bucketLabel: '30m buckets' },
  '24h': { spanMs: 24 * HOUR_MS, bucketMs: HOUR_MS, buckets: 24, label: '24h', bucketLabel: '1h buckets' },
  '7d': { spanMs: 7 * DAY_MS, bucketMs: 6 * HOUR_MS, buckets: 28, label: '7d', bucketLabel: '6h buckets' },
  '30d': { spanMs: 30 * DAY_MS, bucketMs: DAY_MS, buckets: 30, label: '30d', bucketLabel: '1d buckets' },
};

/**
 * A window key turned into the facts every fold under it needs.
 *
 * `startMs` and `since` are the same instant twice because the two consumers ask
 * differently — a fold compares numbers, a store read takes an ISO string — and
 * converting at each call site is how the two end up an hour apart on the one
 * route that forgets.
 */
export interface ResolvedWindow {
  key: InsightsWindow;
  /** When the window opens, or `null` for `all` — no lower bound at all. */
  startMs: number | null;
  /** {@link startMs} as ISO, for the store reads. `null` for `all`. */
  since: string | null;
  /** The whole span, or `null` when unbounded. */
  spanMs: number | null;
  label: string;
  bucketLabel: string;
  now: number;
}

export function resolveWindow(key: InsightsWindow, now: number): ResolvedWindow {
  if (key === 'all') {
    return {
      key,
      startMs: null,
      since: null,
      spanMs: null,
      label: 'All time',
      bucketLabel: 'weekly buckets',
      now,
    };
  }
  const shape = SHAPES[key];
  const startMs = now - shape.spanMs;
  return {
    key,
    startMs,
    since: new Date(startMs).toISOString(),
    spanMs: shape.spanMs,
    label: shape.label,
    bucketLabel: shape.bucketLabel,
    now,
  };
}

/** Whether an instant falls inside the window. Everything is inside `all`. */
export function inWindow(window: ResolvedWindow, at: number): boolean {
  if (Number.isNaN(at)) return false;
  if (at > window.now) return false;
  return window.startMs === null || at >= window.startMs;
}

/** The two ends and the resolution a timeline is drawn at. */
export interface TimelineSpan {
  startMs: number;
  bucketMs: number;
  buckets: number;
}

/**
 * Where a timeline starts and how finely it is cut.
 *
 * For a bounded window this is the shape above and nothing else. For `all` it is
 * the caller's own earliest datum divided into {@link ALL_BUCKETS} — so the
 * graph describes the history the deployment actually has, and a harness that
 * started last Tuesday does not draw twenty-five empty buckets in front of it.
 */
export function timelineSpan(window: ResolvedWindow, earliestMs: number | null): TimelineSpan {
  if (window.key !== 'all') {
    const shape = SHAPES[window.key];
    return { startMs: window.now - shape.spanMs, bucketMs: shape.bucketMs, buckets: shape.buckets };
  }
  const spanMs = Math.max(ALL_MIN_SPAN_MS, earliestMs === null ? ALL_MIN_SPAN_MS : window.now - earliestMs);
  return {
    startMs: window.now - spanMs,
    bucketMs: Math.ceil(spanMs / ALL_BUCKETS),
    buckets: ALL_BUCKETS,
  };
}

/**
 * Which bucket an instant falls in, or `null` when it predates the timeline.
 *
 * The clamp on the top end is deliberate and is not a guard against bad data: a
 * run that reports at `now` lands exactly one bucket past the end, and dropping
 * it would lose the most recent reading on the graph on every draw.
 */
export function bucketIndexIn(span: TimelineSpan, at: number): number | null {
  if (Number.isNaN(at) || at < span.startMs) return null;
  return Math.min(span.buckets - 1, Math.floor((at - span.startMs) / span.bucketMs));
}

/**
 * The instant a run counts at.
 *
 * Where it **ended**, and where it started only while it is still going. A run
 * that opened before the window and finished inside it spent its money inside
 * it, and counting it at its start would leave a nine-hour agent out of the
 * six-hour window it in fact dominated.
 */
export function runInstant(run: { startedAt: string; endedAt: string | null }): number {
  return Date.parse(run.endedAt ?? run.startedAt);
}

/**
 * The window as the cockpit reads it back.
 *
 * Shipped with every payload rather than re-derived in the browser, for the
 * reason the splits themselves are: a panel that computed its own "24h to now ·
 * 1h buckets" caption from the key it asked with would be free to disagree with
 * the timeline drawn under it — and the disagreement a reader would see is a
 * caption, which is the half they would believe.
 */
export interface InsightsWindowView {
  key: InsightsWindow;
  label: string;
  bucketLabel: string;
  /** The lower bound the rows were selected by, or `null` when there was none. */
  since: string | null;
  /** Where the timeline's first bucket opens — not the same as {@link since} for `all`. */
  startsAt: string;
  bucketMs: number;
  buckets: number;
}

export function windowView(window: ResolvedWindow, span: TimelineSpan): InsightsWindowView {
  return {
    key: window.key,
    label: window.label,
    bucketLabel: window.bucketLabel,
    since: window.since,
    startsAt: new Date(span.startMs).toISOString(),
    bucketMs: span.bucketMs,
    buckets: span.buckets,
  };
}

/**
 * How many periods the trend draws, and the shortest history worth splitting
 * into that many.
 */
const TREND_PERIODS = 8;
const TREND_MIN_SPAN_MS = TREND_PERIODS * 7 * DAY_MS;

/**
 * The trend's axis: **the last eight windows of the length the operator picked**.
 *
 * That is what makes one control serve a page whose last tab is inherently about
 * change. A fixed eight weeks would have left the trend the one reading the time
 * bar could not move, which is the arrangement this whole page replaces — and it
 * has a second payoff: the comparison the headline draws ("against the previous
 * 24h") is then literally the last two bars here, rather than a second, separate
 * notion of "before" for a reader to reconcile.
 */
export function trendSpan(window: ResolvedWindow, earliestMs: number | null): TimelineSpan {
  if (window.spanMs !== null) {
    return {
      startMs: window.now - TREND_PERIODS * window.spanMs,
      bucketMs: window.spanMs,
      buckets: TREND_PERIODS,
    };
  }
  const spanMs = Math.max(TREND_MIN_SPAN_MS, earliestMs === null ? TREND_MIN_SPAN_MS : window.now - earliestMs);
  return {
    startMs: window.now - spanMs,
    bucketMs: Math.ceil(spanMs / TREND_PERIODS),
    buckets: TREND_PERIODS,
  };
}

/**
 * How far back the trend's store reads must reach — eight windows, not one.
 *
 * `null` for `all`, which is the whole point of `all` and the one case where the
 * route must ask for everything: the span cannot be known before the rows are in
 * hand, since it is derived from the oldest of them.
 */
export function trendSince(window: ResolvedWindow): string | null {
  if (window.spanMs === null) return null;
  return new Date(window.now - TREND_PERIODS * window.spanMs).toISOString();
}

/**
 * The window as a query parameter, declared here rather than in the routes.
 *
 * It is a domain rule and not a request shape — three routes take it and all
 * three must accept exactly the set the cockpit can ask for — which is the same
 * reason `ShortfallBody` lives with the rule it encodes rather than in
 * `src/server/`. The default is applied here too, so a route reached without one
 * answers for the same stretch the page opens on rather than for whatever that
 * route's author picked.
 */
export const InsightsQuery = z.object({
  window: z
    .enum(['6h', '24h', '7d', '30d', 'all'], {
      errorMap: () => ({ message: `window must be one of ${INSIGHTS_WINDOWS.join(', ')}` }),
    })
    .default(DEFAULT_INSIGHTS_WINDOW),
});

/**
 * A `since` a store read can take.
 *
 * `all` has no lower bound, and the store reads all want a string — so the
 * epoch is what "no bound" spells there. Written once, because a route that
 * reached for `?? new Date(0)` itself would be a second spelling of the same
 * decision, free to be a different one.
 */
export function sinceOrEpoch(since: string | null): string {
  return since ?? new Date(0).toISOString();
}
