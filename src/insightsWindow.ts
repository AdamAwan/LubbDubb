/**
 * The window every insights reading is measured over — decided once here, so every fold
 * under a route measures the same stretch. → docs/spec/18-observability.md#the-window,
 * docs/spec/17-cockpit.md#the-time-bar
 */

import { z } from 'zod';

import type { AccountRateLimits } from './types.js';

/** The windows the cockpit offers, in the order the control draws them. */
export type InsightsWindow = 'session' | '6h' | '24h' | '7d' | '30d' | 'all';

const INSIGHTS_WINDOWS: readonly InsightsWindow[] = ['session', '6h', '24h', '7d', '30d', 'all'];

/** What the page opens on. */
const DEFAULT_INSIGHTS_WINDOW: InsightsWindow = '7d';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How many buckets an unbounded window's timeline is cut into, and the shortest history
 * worth cutting — the floor stops a two-hour-old harness drawing noise.
 */
const ALL_BUCKETS = 26;
const ALL_MIN_SPAN_MS = 7 * DAY_MS;

/** How long the account's five-hour window is, and how finely the elapsed part is cut. */
const SESSION_MS = 5 * HOUR_MS;
const SESSION_BUCKETS = 20;

/**
 * The shortest stretch a fresh session's timeline is cut over: the axis covers at least
 * this much whether or not it has happened yet, so the graph does not re-scale on every
 * refresh.
 */
const SESSION_MIN_SPAN_MS = 30 * MINUTE_MS;

interface WindowShape {
  spanMs: number;
  bucketMs: number;
  buckets: number;
  label: string;
  bucketLabel: string;
}

/** Each window's span and the resolution it is drawn at. */
const SHAPES: Record<Exclude<InsightsWindow, 'all' | 'session'>, WindowShape> = {
  '6h': { spanMs: 6 * HOUR_MS, bucketMs: 30 * MINUTE_MS, buckets: 12, label: '6h', bucketLabel: '30m buckets' },
  '24h': { spanMs: 24 * HOUR_MS, bucketMs: HOUR_MS, buckets: 24, label: '24h', bucketLabel: '1h buckets' },
  '7d': { spanMs: 7 * DAY_MS, bucketMs: 6 * HOUR_MS, buckets: 28, label: '7d', bucketLabel: '6h buckets' },
  '30d': { spanMs: 30 * DAY_MS, bucketMs: DAY_MS, buckets: 30, label: '30d', bucketLabel: '1d buckets' },
};

/**
 * Where the account's current five-hour window began, or why this harness cannot say.
 * Three-valued — never reported and gone stale are different facts, and folded together they
 * would read as "the last five hours" dressed as the account's own.
 */
// Not exported: the cockpit reaches it as `InsightsWindowView['session']`, the only
// shape it may name.
type SessionAnchor =
  | {
      kind: 'anchored';
      /**
       * When the window opened — `resetsAt` less {@link SESSION_MS}, never observed
       * directly.
       */
      startsAt: string;
      resetsAt: string;
      /**
       * How much of it the account says is spent, for the reading the cost split cannot
       * give.
       */
      usedPercentage: number | null;
      /**
       * When an agent last reported this, so a stale figure is drawn stale rather than
       * hidden.
       */
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

/** A window key turned into the facts every fold under it needs. */
export interface ResolvedWindow {
  key: InsightsWindow;
  /** When the window opens, or `null` for `all` — no lower bound at all. */
  startMs: number | null;
  /** {@link startMs} as ISO, for the store reads. */
  since: string | null;
  /** The whole span, or `null` when unbounded. */
  spanMs: number | null;
  label: string;
  bucketLabel: string;
  /**
   * The account window this was anchored to, and `null` on every key but `session` — which
   * is what stops a caller reading an anchor into a span that never had one.
   */
  session: SessionAnchor | null;
  /**
   * One period of the trend's axis, and where the last one ends — `null` for `all`, whose
   * period cannot be known before the rows are in hand.
   */
  period: { spanMs: number; endMs: number } | null;
  now: number;
}

/** The window a route was asked for, resolved. */
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
 * The session window, whether or not it could be anchored. Unanchored it is the last five
 * hours and **the label changes with it**, so nobody reads "5h session" over a span the
 * account never named.
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
    // Whole windows, never the elapsed part ({@link ResolvedWindow.period}), ending at
    // the reset so the bars sit on the account's own boundaries.
    period: { spanMs: SESSION_MS, endMs: anchor.kind === 'anchored' ? Date.parse(anchor.resetsAt) : now },
    now,
  };
}

/**
 * How finely the elapsed part of a session is cut, floored so a fresh window is not drawn
 * at twelve-second resolution.
 */
function sessionBucketMs(spanMs: number): number {
  return Math.ceil(Math.max(spanMs, SESSION_MIN_SPAN_MS) / SESSION_BUCKETS);
}

/**
 * A bucket width in the operator's units, for the one window whose resolution is computed
 * rather than declared — a caption that disagreed with the bars is the half a reader
 * believes.
 */
function bucketLabelFor(bucketMs: number): string {
  const minutes = Math.max(1, Math.round(bucketMs / MINUTE_MS));
  return minutes < 60 ? `${minutes}m buckets` : `${Math.round(minutes / 60)}h buckets`;
}

/** Whether an instant falls inside the window. */
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

/** Where a timeline starts and how finely it is cut. */
export function timelineSpan(window: ResolvedWindow, earliestMs: number | null): TimelineSpan {
  // Anchored at its own start rather than back from `now`.
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

/** Which bucket an instant falls in, or `null` when it predates the timeline. */
export function bucketIndexIn(span: TimelineSpan, at: number): number | null {
  if (Number.isNaN(at) || at < span.startMs) return null;
  return Math.min(span.buckets - 1, Math.floor((at - span.startMs) / span.bucketMs));
}

/**
 * The instant a run counts at: where it **ended**, and where it started only while it is
 * still going — a run that opened before the window and finished inside it spent its money
 * inside it.
 */
export function runInstant(run: { startedAt: string; endedAt: string | null }): number {
  return Date.parse(run.endedAt ?? run.startedAt);
}

/** Whether a run falls inside the window. */
export function runInWindow(window: ResolvedWindow, run: { startedAt: string; endedAt: string | null }): boolean {
  if (run.endedAt === null) return true;
  return inWindow(window, runInstant(run));
}

/** The window as the cockpit reads it back. */
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
   * The account window the rows were anchored to, or why they were not — `null` on every
   * key but `session`.
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
 * How many periods the trend draws, and the shortest history worth splitting into that
 * many.
 */
const TREND_PERIODS = 8;
const TREND_MIN_SPAN_MS = TREND_PERIODS * 7 * DAY_MS;

/**
 * The trend's axis: **the last eight windows of the length the operator picked**, so the
 * headline's "against the previous 24h" is literally the last two bars.
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

/** How far back the trend's store reads must reach — eight windows, not one. */
export function trendSince(window: ResolvedWindow): string | null {
  if (window.period === null) return null;
  return new Date(window.period.endMs - TREND_PERIODS * window.period.spanMs).toISOString();
}

/**
 * The window as a query parameter, declared here rather than in the routes: it is a domain
 * rule, and all three routes must accept exactly the set the cockpit can ask for.
 */
export const InsightsQuery = z.object({
  window: z
    .enum(['session', '6h', '24h', '7d', '30d', 'all'], {
      errorMap: () => ({ message: `window must be one of ${INSIGHTS_WINDOWS.join(', ')}` }),
    })
    .default(DEFAULT_INSIGHTS_WINDOW),
});

/**
 * A `since` a store read can take. `all` has no lower bound and the store reads want a
 * string, so the epoch is what "no bound" spells — written once, never at a call site.
 */
export function sinceOrEpoch(since: string | null): string {
  return since ?? new Date(0).toISOString();
}
