import type { GoalArrival, WatchWindow } from '../types.js';
import type { EnvironmentConfig } from './policy.js';

// → docs/spec/24-environments.md

const DEFAULT_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * How long a window on this environment runs for.
 *
 * One reader of `forMs` rather than two, which is the point: the arrival that
 * opens a window and the operator's click that extends one must agree about how
 * long a window on this environment is, and a second `?? DEFAULT_WINDOW_MS`
 * elsewhere is one edit from a watch that extends by a different length from the
 * one it opened with, with nothing red.
 *
 * @public read by the extend route, which measures the new end from now
 */
export function watchWindowMs(environment: EnvironmentConfig): number {
  return environment.watch?.forMs ?? DEFAULT_WINDOW_MS;
}

const WATCH_WINDOW_INTERVALS = 2;

const MAX_WATCH_WINDOWS_PER_PULSE = 20;

interface WatchArrivalVerdict {
  arrival: GoalArrival;
  settlesAt: string | null;
}

export function openableArrivals(input: {
  arrivals: readonly GoalArrival[];
  environments: readonly EnvironmentConfig[];
  declared: ReadonlySet<string>;
  probeIntervalMs: number;
  now: number;
}): WatchArrivalVerdict[] {
  const byName = new Map(input.environments.map((e) => [e.name, e]));
  const floor = input.now - input.probeIntervalMs * WATCH_WINDOW_INTERVALS;
  const out: WatchArrivalVerdict[] = [];
  for (const arrival of input.arrivals) {
    if (arrival.watchedAt !== null) continue;
    const environment = byName.get(arrival.environment);
    const seen = Date.parse(arrival.arrivedAt);
    const fresh = Number.isFinite(seen) && seen >= floor;
    const watchable = environment?.watch !== undefined && input.declared.has(arrival.goalRef);
    out.push({
      arrival,
      settlesAt: watchable && fresh ? new Date(seen + watchWindowMs(environment)).toISOString() : null,
    });
  }
  return out;
}

export function settlingWindows(windows: readonly WatchWindow[], now: number): WatchWindow[] {
  return windows.filter((w) => w.settledAt === null && Date.parse(w.settlesAt) <= now);
}

export function dueWindows(input: {
  windows: readonly WatchWindow[];
  readings: readonly { goalRef: string; environment: string; readAt: string }[];
  watchIntervalMs: number;
  now: number;
}): WatchWindow[] {
  const lastRead = new Map<string, number>();
  for (const r of input.readings) {
    const at = Date.parse(r.readAt);
    if (!Number.isFinite(at)) continue;
    const key = `${r.goalRef} ${r.environment}`;
    const held = lastRead.get(key);
    if (held === undefined || at > held) lastRead.set(key, at);
  }
  const floor = input.now - input.watchIntervalMs;
  const out: WatchWindow[] = [];
  for (const w of input.windows) {
    if (w.settledAt !== null) continue;
    const read = lastRead.get(`${w.goalRef} ${w.environment}`);
    if (read !== undefined && read > floor) continue;
    out.push(w);
    if (out.length >= MAX_WATCH_WINDOWS_PER_PULSE) break;
  }
  return out;
}
