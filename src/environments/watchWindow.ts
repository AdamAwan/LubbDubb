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

const MAX_SHEETS_PER_PULSE = 5;

interface SheetArrivalVerdict {
  arrival: GoalArrival;
  /** False where the arrival is only being stamped: it is older than the guard allows. */
  assemble: boolean;
}

/**
 * Which arrivals `RemoteValidationDesk` considers this pulse, oldest first.
 *
 * `openableArrivals`' guard, one subsystem over and for its reason: without it the first pulse after
 * an operator adds a `validate` block to an environment that has been probing for a month would
 * assemble a sheet for every goal that ever arrived, spawn a state command per approved query for
 * each of them, and put a bench row on work that shipped in March. An arrival confirmed longer ago
 * than two probe intervals is returned to be **stamped and not assembled**, which is what makes the
 * next arrival the first one sheeted rather than the whole history arriving at once — and is why
 * `goal_arrivals.sheeted_at` needs no backfill.
 *
 * An arrival on an environment that declares no `validate` block is not returned at all. Stamping it
 * would spend the guard where the feature is off, and burn it for the environment that turns it on.
 *
 * The cap defers rather than drops: a deferred arrival is left unstamped and is the oldest one the
 * next pulse sees. Deliberately smaller than the watch's twenty — what this bounds is a command per
 * approved row on each sheet, where that one bounds a query.
 *
 * **A fresh arrival whose goal has no check set yet is deferred the same way**, and the order of the
 * two cuts is what makes that safe. The set is authored after the assessor writes `delivered`
 * ([20](../../docs/spec/20-validation.md#when-the-check-set-is-written)), which routinely takes
 * longer than two probe intervals, so a sheet assembled first carries only the watch-derived rows —
 * a bench that offers nothing to run, reads as a misconfiguration, and is not one. The staleness cut
 * runs **first**, so the arrivals that would flood in on the pulse an operator turns this on are
 * stamped and not assembled before authoring is ever consulted; only an arrival that entered fresh
 * waits, and it waits as long as the planner takes.
 *
 * → docs/spec/36-remote-validation.md#the-desk
 */
export function sheetableArrivals(input: {
  arrivals: readonly GoalArrival[];
  environments: readonly EnvironmentConfig[];
  /** Whether this goal's validation check set has been authored. A fresh arrival waits until it has. */
  authored: (goalRef: string) => boolean;
  probeIntervalMs: number;
  now: number;
}): SheetArrivalVerdict[] {
  const byName = new Map(input.environments.map((e) => [e.name, e]));
  const floor = input.now - input.probeIntervalMs * WATCH_WINDOW_INTERVALS;
  const oldestFirst = [...input.arrivals].sort((a, b) => a.arrivedAt.localeCompare(b.arrivedAt));
  const out: SheetArrivalVerdict[] = [];
  let assembling = 0;
  for (const arrival of oldestFirst) {
    if (arrival.sheetedAt !== null) continue;
    if (byName.get(arrival.environment)?.validate === undefined) continue;
    const seen = Date.parse(arrival.arrivedAt);
    if (!Number.isFinite(seen) || seen < floor) {
      out.push({ arrival, assemble: false });
      continue;
    }
    if (!input.authored(arrival.goalRef)) continue;
    if (assembling >= MAX_SHEETS_PER_PULSE) continue;
    assembling += 1;
    out.push({ arrival, assemble: true });
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
