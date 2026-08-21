import type { Decision, WorldEvent } from '../types.js';

/**
 * Production statistics — is the floor producing, or merely busy?
 *
 * A question about *rates*, which can only be read against time, and the one the
 * rest of the overview does not answer: every other card there says what is
 * happening, not whether it is adding up to anything. The inputs are already on
 * the snapshot and already timestamped, so this derives rather than asking the
 * server for anything.
 *
 * **It keeps a fixed six-hour window while the Insights page obeys a control**,
 * and that is not an oversight. This is a *now* reading, drawn on the surface an
 * operator glances at; a window they have to set before the answer means anything
 * is a different question, and that question has a page of its own.
 * → docs/spec/17-cockpit.md#the-overview
 */

/** Six one-hour buckets. Long enough to show a trend, short enough to be about today. */
const WINDOW_MS = 6 * 60 * 60 * 1000;
const BUCKETS = 6;

type SeriesKey = 'dispatches' | 'merges' | 'escalations';

interface ProductionSeries {
  key: SeriesKey;
  label: string;
  /** Counts per bucket, oldest first. */
  points: number[];
  perHour: number;
  /** Second half of the window against the first, as a percentage. Null when the first half was empty. */
  deltaPct: number | null;
}

interface ProductionReading {
  series: ProductionSeries[];
  windowMs: number;
  /** The tallest bucket across every series — the graph's shared y-scale. */
  peak: number;
  /**
   * Dispatches per merge. The one number that separates a floor producing from
   * a floor churning: agents going out is not output, merges are.
   */
  churnRatio: number | null;
  /** Spend per hour, from the rolling 5h cost window. Null when nothing was reported. */
  costPerHour: number | null;
  /**
   * The decision log does not reach back to the start of the window, so every
   * count derived from it is a floor rather than a total. Said out loud in the
   * panel: a rate that silently under-reports is worse than no rate.
   */
  truncated: boolean;
}

function bucketise(times: readonly number[], start: number, bucketMs: number): number[] {
  const points = new Array<number>(BUCKETS).fill(0);
  for (const t of times) {
    if (t < start) continue;
    const idx = Math.min(BUCKETS - 1, Math.floor((t - start) / bucketMs));
    if (idx >= 0) points[idx] = (points[idx] ?? 0) + 1;
  }
  return points;
}

/** Rate change across the window, comparing its two halves. */
function deltaOf(points: readonly number[]): number | null {
  const mid = Math.floor(points.length / 2);
  const first = points.slice(0, mid).reduce((a, b) => a + b, 0);
  const second = points.slice(mid).reduce((a, b) => a + b, 0);
  if (first === 0) return null;
  return Math.round(((second - first) / first) * 100);
}

/**
 * A decision that actually happened — a deferred, rejected or skipped one
 * produced no work. `executed` is the whole of it: the `'ok'` arm this also read
 * was never a {@link Decision} outcome, and only compiled while the cockpit's
 * copy of the union was `string`.
 */
function landed(d: Decision): boolean {
  return d.outcome === 'executed';
}

function timesOf(rows: readonly { createdAt: string }[]): number[] {
  return rows.map((r) => Date.parse(r.createdAt)).filter((t) => !Number.isNaN(t));
}

export function productionReading(input: {
  decisions: readonly Decision[];
  worldEvents: readonly WorldEvent[];
  fiveHourCostUsd: number | null;
  now: number;
}): ProductionReading {
  const { decisions, worldEvents, now } = input;
  const start = now - WINDOW_MS;
  const bucketMs = WINDOW_MS / BUCKETS;
  const hours = WINDOW_MS / 3_600_000;

  const dispatchTimes = timesOf(decisions.filter((d) => landed(d) && d.action.type.startsWith('dispatch_')));
  const mergeTimes = timesOf(worldEvents.filter((e) => e.kind === 'pr_merged'));
  const escalationTimes = timesOf(decisions.filter((d) => landed(d) && d.action.type === 'escalate_to_human'));

  const build = (key: SeriesKey, label: string, times: number[]): ProductionSeries => {
    const points = bucketise(times, start, bucketMs);
    const total = points.reduce((a, b) => a + b, 0);
    return { key, label, points, perHour: total / hours, deltaPct: deltaOf(points) };
  };

  const series = [
    build('dispatches', 'Dispatches', dispatchTimes),
    build('merges', 'Merges', mergeTimes),
    build('escalations', 'Escalations', escalationTimes),
  ];

  const dispatched = series[0]?.points.reduce((a, b) => a + b, 0) ?? 0;
  const merged = series[1]?.points.reduce((a, b) => a + b, 0) ?? 0;

  // The log's own reach, not a guess at the server's row limit: if the oldest
  // decision we hold is newer than the window, the window is not covered.
  const oldest = decisions.length > 0 ? Math.min(...timesOf(decisions)) : null;

  return {
    series,
    windowMs: WINDOW_MS,
    peak: Math.max(1, ...series.flatMap((s) => s.points)),
    churnRatio: merged > 0 ? dispatched / merged : null,
    costPerHour: input.fiveHourCostUsd === null ? null : input.fiveHourCostUsd / 5,
    truncated: oldest !== null && oldest > start,
  };
}
