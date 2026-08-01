import type { Decision, WorldEvent } from '../../types.js';

/**
 * Production statistics — the panel the game opens on `P`, and the one reading
 * this cockpit had no equivalent of.
 *
 * Every other panel answers "what is happening right now". None of them answers
 * "is this floor actually producing", which is a question about *rates* and can
 * only be read against time. The inputs are already on the snapshot and already
 * timestamped, so this derives rather than asking the server for anything.
 */

/** Six one-hour buckets. Long enough to show a trend, short enough to be about today. */
const WINDOW_MS = 6 * 60 * 60 * 1000;
const BUCKETS = 6;

export type SeriesKey = 'dispatches' | 'merges' | 'escalations';

export interface ProductionSeries {
  key: SeriesKey;
  label: string;
  /** Counts per bucket, oldest first. */
  points: number[];
  perHour: number;
  /** Second half of the window against the first, as a percentage. Null when the first half was empty. */
  deltaPct: number | null;
}

export interface ProductionReading {
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

/**
 * A y-scale whose labels are whole events.
 *
 * Four fixed gridlines over a raw peak prints "1 1 1 0 0" whenever the floor is
 * quiet, because these are counts and a quarter of an event does not exist. So
 * the axis takes as many steps as it can label with an integer: the peak itself
 * while it is small, and a multiple of four above that.
 */
export function axisScale(peak: number): { max: number; lines: number[] } {
  const top = Math.max(1, Math.ceil(peak));
  const steps = top <= 4 ? top : 4;
  const max = top <= 4 ? top : Math.ceil(top / 4) * 4;
  return { max, lines: Array.from({ length: steps + 1 }, (_, i) => i / steps) };
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

/**
 * The belt's tier, read as queue pressure against the cap.
 *
 * Against the cap rather than an absolute count: four items behind a cap of two is
 * congestion and behind a cap of eight is a normal cycle, so an absolute threshold
 * would call a healthy fleet saturated. Yellow up to one full pulse of work, red to
 * two, blue past that — the game's own hierarchy, so a player reads it with no
 * legend.
 *
 * A cap of zero is a paused-to-nothing fleet, where any queued item is saturation.
 */
export function beltTier(queued: number, cap: number): 'yellow' | 'red' | 'blue' {
  if (queued === 0) return 'yellow';
  if (cap <= 0) return 'blue';
  if (queued <= cap) return 'yellow';
  if (queued <= cap * 2) return 'red';
  return 'blue';
}
