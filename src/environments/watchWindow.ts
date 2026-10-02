import type { GoalArrival, WatchWindow } from '../types.js';
import type { EnvironmentConfig } from './policy.js';
import type { CheckSetStanding } from '../validation/planApproval.js';

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
 * **An arrival waiting on its check set is deferred the same way, however long that takes**; freshness
 * is the arrival's, the authoring's or the acceptance's: a sheet is drawn once its set is written, so the
OK can accept it. → docs/spec/36-remote-validation.md#a-sheet-waits-for-its-checks
 *
 * → docs/spec/36-remote-validation.md#the-desk
 */
export function sheetableArrivals(input: {
  arrivals: readonly GoalArrival[];
  environments: readonly EnvironmentConfig[];
  /** This goal's check set: whether it is accepted, and when. An arrival waits until it is. */
  checkSet: (goalRef: string) => CheckSetStanding;
  probeIntervalMs: number;
  now: number;
}): SheetArrivalVerdict[] {
  const byName = new Map(input.environments.map((e) => [e.name, e]));
  const oldestFirst = [...input.arrivals].sort((a, b) => a.arrivedAt.localeCompare(b.arrivedAt));
  const out: SheetArrivalVerdict[] = [];
  let assembling = 0;
  for (const arrival of oldestFirst) {
    const step = arrivalSheetStep({
      arrival,
      validates: byName.get(arrival.environment)?.validate !== undefined,
      checkSet: () => input.checkSet(arrival.goalRef),
      probeIntervalMs: input.probeIntervalMs,
      now: input.now,
    });
    if (step === 'stale') out.push({ arrival, assemble: false });
    if (step !== 'ready' || assembling >= MAX_SHEETS_PER_PULSE) continue;
    assembling += 1;
    out.push({ arrival, assemble: true });
  }
  return out;
}

/**
 * Where one arrival stands in `sheetableArrivals`' cut, before the per-pulse cap. The one statement of
 * that cut: the desk acts on it and the cockpit's reason for a missing sheet words it.
 * → docs/spec/36-remote-validation.md#when-there-is-no-sheet
 */
export type ArrivalSheetStep = 'not-validating' | 'sheeted' | 'stale' | 'awaiting-checks' | 'ready';

export function arrivalSheetStep(input: {
  arrival: GoalArrival;
  validates: boolean;
  checkSet: () => CheckSetStanding;
  probeIntervalMs: number;
  now: number;
}): ArrivalSheetStep {
  if (!input.validates) return 'not-validating';
  const checks = input.checkSet();
  if (!checks.accepted && checks.authoredAt === null) return 'awaiting-checks';
  if (input.arrival.sheetedAt !== null) return 'sheeted';
  const floor = input.now - input.probeIntervalMs * WATCH_WINDOW_INTERVALS;
  const since = (at: string | null): boolean => at !== null && Date.parse(at) >= floor;
  return since(input.arrival.arrivedAt) || since(checks.acceptedAt) || since(checks.authoredAt ?? null)
    ? 'ready'
    : 'stale';
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
