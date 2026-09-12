import { z } from 'zod';

import type { AccountRateLimits } from '../types.js';

// → docs/spec/18-observability.md

export type InsightsWindow = 'session' | '6h' | '24h' | '7d' | '30d' | 'all';

const INSIGHTS_WINDOWS: readonly InsightsWindow[] = ['session', '6h', '24h', '7d', '30d', 'all'];

const DEFAULT_INSIGHTS_WINDOW: InsightsWindow = '7d';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const ALL_BUCKETS = 26;
const ALL_MIN_SPAN_MS = 7 * DAY_MS;

const SESSION_MS = 5 * HOUR_MS;
const SESSION_BUCKETS = 20;

const SESSION_MIN_SPAN_MS = 30 * MINUTE_MS;

interface WindowShape {
  spanMs: number;
  bucketMs: number;
  buckets: number;
  label: string;
  bucketLabel: string;
}

const SHAPES: Record<Exclude<InsightsWindow, 'all' | 'session'>, WindowShape> = {
  '6h': { spanMs: 6 * HOUR_MS, bucketMs: 30 * MINUTE_MS, buckets: 12, label: '6h', bucketLabel: '30m buckets' },
  '24h': { spanMs: 24 * HOUR_MS, bucketMs: HOUR_MS, buckets: 24, label: '24h', bucketLabel: '1h buckets' },
  '7d': { spanMs: 7 * DAY_MS, bucketMs: 6 * HOUR_MS, buckets: 28, label: '7d', bucketLabel: '6h buckets' },
  '30d': { spanMs: 30 * DAY_MS, bucketMs: DAY_MS, buckets: 30, label: '30d', bucketLabel: '1d buckets' },
};

type SessionAnchor =
  | {
      kind: 'anchored';
      startsAt: string;
      resetsAt: string;
      usedPercentage: number | null;
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

export interface ResolvedWindow {
  key: InsightsWindow;
  startMs: number | null;
  since: string | null;
  spanMs: number | null;
  label: string;
  bucketLabel: string;
  session: SessionAnchor | null;
  period: { spanMs: number; endMs: number } | null;
  now: number;
}

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
    period: { spanMs: SESSION_MS, endMs: anchor.kind === 'anchored' ? Date.parse(anchor.resetsAt) : now },
    now,
  };
}

function sessionBucketMs(spanMs: number): number {
  return Math.ceil(Math.max(spanMs, SESSION_MIN_SPAN_MS) / SESSION_BUCKETS);
}

function bucketLabelFor(bucketMs: number): string {
  const minutes = Math.max(1, Math.round(bucketMs / MINUTE_MS));
  return minutes < 60 ? `${minutes}m buckets` : `${Math.round(minutes / 60)}h buckets`;
}

export function inWindow(window: ResolvedWindow, at: number): boolean {
  if (Number.isNaN(at)) return false;
  if (at > window.now) return false;
  return window.startMs === null || at >= window.startMs;
}

export interface TimelineSpan {
  startMs: number;
  bucketMs: number;
  buckets: number;
}

export function timelineSpan(window: ResolvedWindow, earliestMs: number | null): TimelineSpan {
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

export function bucketIndexIn(span: TimelineSpan, at: number): number | null {
  if (Number.isNaN(at) || at < span.startMs) return null;
  return Math.min(span.buckets - 1, Math.floor((at - span.startMs) / span.bucketMs));
}

export function runInstant(run: { startedAt: string; endedAt: string | null }): number {
  return Date.parse(run.endedAt ?? run.startedAt);
}

export function runInWindow(window: ResolvedWindow, run: { startedAt: string; endedAt: string | null }): boolean {
  if (run.endedAt === null) return true;
  return inWindow(window, runInstant(run));
}

export interface InsightsWindowView {
  key: InsightsWindow;
  label: string;
  bucketLabel: string;
  since: string | null;
  startsAt: string;
  bucketMs: number;
  buckets: number;
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

const TREND_PERIODS = 8;
const TREND_MIN_SPAN_MS = TREND_PERIODS * 7 * DAY_MS;

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

export function trendSince(window: ResolvedWindow): string | null {
  if (window.period === null) return null;
  return new Date(window.period.endMs - TREND_PERIODS * window.period.spanMs).toISOString();
}

export const InsightsQuery = z.object({
  window: z
    .enum(['session', '6h', '24h', '7d', '30d', 'all'], {
      errorMap: () => ({ message: `window must be one of ${INSIGHTS_WINDOWS.join(', ')}` }),
    })
    .default(DEFAULT_INSIGHTS_WINDOW),
});

export function sinceOrEpoch(since: string | null): string {
  return since ?? new Date(0).toISOString();
}
