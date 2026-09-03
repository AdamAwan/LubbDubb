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
 * **`session` is the one window that is not measured from `now`.** The other
 * five are spans an operator picked; this one is a stretch the *account* is
 * keeping, and the question it answers — where did the five hours go — is only
 * answerable against the account's own boundaries. It is therefore anchored to
 * the five-hour reset the CLI reports ({@link sessionAnchor}), which is the one
 * datum here the harness did not compute and cannot recompute.
 *
 * → docs/spec/18-observability.md#the-window, docs/spec/17-cockpit.md#the-time-bar
 */

import { z } from 'zod';

import type { AccountRateLimits } from './types.js';

/** The windows the cockpit offers, in the order the control draws them. */
export type InsightsWindow = 'session' | '6h' | '24h' | '7d' | '30d' | 'all';

const INSIGHTS_WINDOWS: readonly InsightsWindow[] = ['session', '6h', '24h', '7d', '30d', 'all'];

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

/**
 * How long the account's five-hour window is, and how finely the elapsed part of
 * one is cut.
 *
 * The length is Anthropic's, not this harness's — nothing here can shorten or
 * lengthen it, and it is a constant only so that the anchor arithmetic and the
 * sanity check below cannot spell it differently.
 */
const SESSION_MS = 5 * HOUR_MS;
const SESSION_BUCKETS = 20;

/**
 * The shortest stretch a fresh session's timeline is cut over.
 *
 * A window that reset four minutes ago is four minutes of history, and dividing
 * it into twenty buckets draws twelve-second bars. The floor is `ALL_MIN_SPAN_MS`'
 * reasoning at the other end of the scale: the axis covers at least this much of
 * the window whether or not it has happened yet, so the graph settles rather than
 * re-scaling under the reader every time it refreshes.
 */
const SESSION_MIN_SPAN_MS = 30 * MINUTE_MS;

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
const SHAPES: Record<Exclude<InsightsWindow, 'all' | 'session'>, WindowShape> = {
  '6h': { spanMs: 6 * HOUR_MS, bucketMs: 30 * MINUTE_MS, buckets: 12, label: '6h', bucketLabel: '30m buckets' },
  '24h': { spanMs: 24 * HOUR_MS, bucketMs: HOUR_MS, buckets: 24, label: '24h', bucketLabel: '1h buckets' },
  '7d': { spanMs: 7 * DAY_MS, bucketMs: 6 * HOUR_MS, buckets: 28, label: '7d', bucketLabel: '6h buckets' },
  '30d': { spanMs: 30 * DAY_MS, bucketMs: DAY_MS, buckets: 30, label: '30d', bucketLabel: '1d buckets' },
};

/**
 * Where the account's current five-hour window began, or why this harness cannot
 * say.
 *
 * Three-valued for [the reach verdict's reason](../docs/spec/24-environments.md#the-three-verdicts):
 * a deployment that has never reported a window and one whose last reading has
 * since expired are different facts, and folded together they become "the last
 * five hours" — a span that looks exactly like the account's and is not it. The
 * page states which of the three it drew, so an operator reading a breakdown of
 * *a* five hours is never left believing it is a breakdown of *theirs*.
 *
 * A reading is usable only while the reset it names is still ahead and no further
 * off than a window is long. Both halves are one check because both are the same
 * failure: `resetsAt` in the past means the window turned over since an agent
 * last took a turn and nothing observed the new one's start
 * ([10](../docs/spec/10-agent-runtimes.md#the-account-usage-windows)); further off
 * than {@link SESSION_MS} means the figure cannot be describing a five-hour
 * window at all. Anchoring on either would put the start at an instant nothing
 * reported, and the breakdown under it would be as plausible as it was wrong.
 */
// Not exported: the cockpit reaches it as `InsightsWindowView['session']`, which
// is the only shape it may name — and one exported name is one fewer way for the
// two to drift apart.
type SessionAnchor =
  | {
      kind: 'anchored';
      /** When the window opened — `resetsAt` less {@link SESSION_MS}, never observed directly. */
      startsAt: string;
      resetsAt: string;
      /** How much of it the account says is spent, for the reading the cost split cannot give. */
      usedPercentage: number | null;
      /** When an agent last reported this, so a stale figure is drawn stale rather than hidden. */
      capturedAt: string;
    }
  | { kind: 'unreported' }
  | { kind: 'stale'; capturedAt: string; resetsAt: string };

function sessionAnchor(limits: AccountRateLimits | null, now: number): SessionAnchor {
  const five = limits?.fiveHour ?? null;
  if (limits === null || five === null || five.resetsAt === null) return { kind: 'unreported' };
  const resetsAt = Date.parse(five.resetsAt);
  if (Number.isNaN(resetsAt) || resetsAt <= now || resetsAt > now + SESSION_MS)
    return { kind: 'stale', capturedAt: limits.capturedAt, resetsAt: five.resetsAt };
  return {
    kind: 'anchored',
    startsAt: new Date(resetsAt - SESSION_MS).toISOString(),
    resetsAt: five.resetsAt,
    usedPercentage: five.usedPercentage,
    capturedAt: limits.capturedAt,
  };
}

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
  /**
   * The account window this was anchored to, and `null` on every key but
   * `session` — which is what stops a caller reading an anchor into a span that
   * never had one.
   */
  session: SessionAnchor | null;
  /**
   * One period of the trend's axis, and where the last one ends — `null` for
   * `all`, whose period cannot be known before the rows are in hand.
   *
   * Stated here rather than derived from {@link spanMs} at the trend's call site
   * because for `session` the two differ and must: the span is the part of the
   * window that has *elapsed*, which is what every other reading measures, while
   * one period of "the last eight sessions" is a whole five hours. Derived, the
   * trend would draw eight bars of whatever fraction of a window the page
   * happened to be opened in — bars whose width moved with the clock, compared
   * against each other as though it had not.
   */
  period: { spanMs: number; endMs: number } | null;
  now: number;
}

/**
 * The window a route was asked for, resolved.
 *
 * `limits` is **required rather than optional** even though five of the six keys
 * ignore it: a route that forgot it would still answer `?window=session`, over a
 * rolling five hours labelled as the account's — the one failure this window has
 * that the others do not, and the kind nothing marks as wrong. A caller with
 * genuinely no reading passes `null` and says so.
 */
export function resolveWindow(key: InsightsWindow, now: number, limits: AccountRateLimits | null): ResolvedWindow {
  if (key === 'all') {
    return {
      key,
      startMs: null,
      since: null,
      spanMs: null,
      label: 'All time',
      bucketLabel: 'weekly buckets',
      session: null,
      period: null,
      now,
    };
  }
  if (key === 'session') return resolveSession(now, sessionAnchor(limits, now));
  const shape = SHAPES[key];
  const startMs = now - shape.spanMs;
  return {
    key,
    startMs,
    since: new Date(startMs).toISOString(),
    spanMs: shape.spanMs,
    label: shape.label,
    bucketLabel: shape.bucketLabel,
    session: null,
    period: { spanMs: shape.spanMs, endMs: now },
    now,
  };
}

/**
 * The session window, whether or not it could be anchored.
 *
 * Unanchored it is the last five hours — the same rows the account's window
 * would most likely have selected, since the two can be at most five hours
 * apart — and the *label changes with it*. That pairing is the whole of the
 * honesty here: the reading is still worth having, and a reader must not be able
 * to take "5h session" off the control while looking at a span the account never
 * named.
 *
 * The span is what has **elapsed**, not the five hours: the remaining part of the
 * window holds nothing by construction, and drawing it would put empty buckets on
 * the right of every timeline — read as a fleet that stopped, which is exactly
 * the sentence this page exists to let an operator make correctly.
 */
function resolveSession(now: number, anchor: SessionAnchor): ResolvedWindow {
  const startMs = anchor.kind === 'anchored' ? Date.parse(anchor.startsAt) : now - SESSION_MS;
  const spanMs = Math.max(0, now - startMs);
  return {
    key: 'session',
    startMs,
    since: new Date(startMs).toISOString(),
    spanMs,
    label: anchor.kind === 'anchored' ? '5h session' : 'Last 5h',
    bucketLabel: bucketLabelFor(sessionBucketMs(spanMs)),
    session: anchor,
    // Whole windows, never the elapsed part — see {@link ResolvedWindow.period}.
    // Ending at the reset rather than at `now` so the bars sit on the account's
    // own boundaries: a bar that straddled two windows would be a comparison
    // between stretches the limit was never applied over.
    period: { spanMs: SESSION_MS, endMs: anchor.kind === 'anchored' ? Date.parse(anchor.resetsAt) : now },
    now,
  };
}

/** How finely the elapsed part of a session is cut, floored so a fresh window is not drawn at twelve-second resolution. */
function sessionBucketMs(spanMs: number): number {
  return Math.ceil(Math.max(spanMs, SESSION_MIN_SPAN_MS) / SESSION_BUCKETS);
}

/**
 * A bucket width in the operator's units, for the one window whose resolution is
 * computed rather than declared.
 *
 * The fixed shapes carry their caption as a literal because it is a property of
 * the shape; this one moves with the clock, and a caption that said `15m buckets`
 * over bars covering nine would be the disagreement `windowView` exists to
 * prevent, printed in the half a reader believes.
 */
function bucketLabelFor(bucketMs: number): string {
  const minutes = Math.max(1, Math.round(bucketMs / MINUTE_MS));
  return minutes < 60 ? `${minutes}m buckets` : `${Math.round(minutes / 60)}h buckets`;
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
  // Anchored at its own start rather than back from `now`, which is the whole
  // difference between this window and the five measured from the clock.
  if (window.key === 'session')
    return {
      startMs: window.startMs as number,
      bucketMs: sessionBucketMs(window.spanMs as number),
      buckets: SESSION_BUCKETS,
    };
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
 * Whether a run falls inside the window.
 *
 * A run that has not ended is inside every window that ends at `now`, whatever
 * its age: its money is being spent now, which is the question the window asks.
 * Dating it at `startedAt` — the instant it counts at on a timeline, where the
 * start is the only honest end it has — put a nine-hour live agent outside the
 * six-hour window it is in fact spending in, and the tab then drew the empty
 * state over a fleet that is out.
 */
export function runInWindow(window: ResolvedWindow, run: { startedAt: string; endedAt: string | null }): boolean {
  if (run.endedAt === null) return true;
  return inWindow(window, runInstant(run));
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
  /**
   * The account window the rows were anchored to, or why they were not — `null`
   * on every key but `session`.
   *
   * Shipped for the reason the caption is: the cockpit cannot compute it. The
   * reading lives on `account_rate_limits` server-side, and a page that asked for
   * `session` and drew the *chip's* percentage beside the split would be pairing
   * a figure with a span it was not necessarily taken over — the chip is the
   * freshest reading whenever it was read, and this is the reading the fold
   * actually anchored on.
   */
  session: SessionAnchor | null;
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
    session: window.session,
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
 *
 * `session` is the exception that proves it: its period is a **whole** five-hour
 * window rather than the elapsed part the rest of the page measures, and the axis
 * ends at the reset rather than at `now`, so the eight bars are the account's last
 * eight windows on their own boundaries — which is the only division of them the
 * limit was ever applied over. See {@link ResolvedWindow.period}.
 */
export function trendSpan(window: ResolvedWindow, earliestMs: number | null): TimelineSpan {
  if (window.period !== null) {
    return {
      startMs: window.period.endMs - TREND_PERIODS * window.period.spanMs,
      bucketMs: window.period.spanMs,
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
  if (window.period === null) return null;
  return new Date(window.period.endMs - TREND_PERIODS * window.period.spanMs).toISOString();
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
    .enum(['session', '6h', '24h', '7d', '30d', 'all'], {
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
