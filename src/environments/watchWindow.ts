import type { GoalArrival, WatchWindow } from '../types.js';
import type { EnvironmentConfig } from './policy.js';

/**
 * The window, as arithmetic: which arrivals open one, which open windows are due
 * a reading, and which have run out of time.
 *
 * Pure and separate from the desk for `watchVerdict.ts`'s reason — the
 * freshness guard is the single most consequential line in the subsystem and it
 * must be exercisable without standing a server up.
 *
 * → `docs/spec/29-post-deploy-watch.md#the-window`
 */

/**
 * How long a window stays open where the environment declares nothing, in
 * milliseconds.
 *
 * Forty-eight hours because the subject of a watch is often a scheduled job, and a
 * window has to be long enough to contain several runs of one. An environment
 * overrules it with `watch.forMs`, which is where the judgement belongs: the
 * release cadence is a property of the deployment rather than of the goal.
 * → `docs/spec/29-post-deploy-watch.md#opening`
 */
const DEFAULT_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * How stale a confirming reading may be and still open a window, as a multiple of
 * the probe interval — `ANNOUNCE_WINDOW_INTERVALS` unchanged, and for its reason.
 *
 * Without it the first pulse after this ships — or after an operator adds a
 * `watch` to an environment that has been probing for a month — opens a window on
 * **every goal that ever arrived**: hundreds of queries a pulse against work that
 * shipped in March. Nothing errors, and the spend looks like the feature working.
 *
 * Two intervals rather than one, because a landing confirmed on the pulse before
 * this one is an arrival this harness watched, and a probe pass that ran long must
 * not turn that into silence.
 * → `docs/spec/29-post-deploy-watch.md#only-for-an-arrival-the-harness-watched`
 */
const WATCH_WINDOW_INTERVALS = 2;

/**
 * How many windows may be read per pulse.
 *
 * `MAX_LANDINGS_PER_PULSE`'s arrangement: deferring rather than dropping, oldest
 * window first, so a backlog drains in a fixed order and nothing starves. The cost
 * this bounds is a process spawn per open check, against the operator's own
 * telemetry, so it is deliberately smaller than the landings bound.
 * → `docs/spec/29-post-deploy-watch.md#cost`
 */
const MAX_WATCH_WINDOWS_PER_PULSE = 20;

/** One arrival, considered — and what opening a window for it would mean. */
interface WatchArrivalVerdict {
  arrival: GoalArrival;
  /**
   * When the window would settle, or **null where none is opened**.
   *
   * Null is not an omission: every arrival the pass considers comes back, because
   * the caller stamps them all. That stamp is what makes the *next* arrival the
   * first one watched, rather than the whole history arriving at once.
   */
  settlesAt: string | null;
}

/**
 * Which arrivals open a window, and every arrival considered either way.
 *
 * Three things have to be true to open one, and each is a different kind of no:
 *
 * - the environment declares an `observe`, or there is nothing to put a query to;
 * - the goal declares at least one check, or the window would be a row with no
 *   readings — **null is not clean**, and a goal that declared nothing must render
 *   as no surface rather than as an empty one;
 * - the confirming reading is fresh, which is the guard above.
 *
 * A goal that declares its first check *after* it arrived somewhere is therefore
 * not watched there, and that is the honest reading rather than a gap: the
 * declaration is what the operator approved, and approving it after the deploy is
 * approving it for the next one.
 */
export function openableArrivals(input: {
  /** Every arrival held — `Store.listGoalArrivals()`. */
  arrivals: readonly GoalArrival[];
  environments: readonly EnvironmentConfig[];
  /** The goal refs that declare at least one check, off `Store.listGoalWatches()`. */
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
    // An environment the operator has since removed is still stamped, exactly as
    // the announce pass stamps it: the row is history, and leaving it unstamped
    // would open a window if the name ever came back.
    out.push({
      arrival,
      settlesAt:
        watchable && fresh ? new Date(seen + (environment.watch?.forMs ?? DEFAULT_WINDOW_MS)).toISOString() : null,
    });
  }
  return out;
}

/**
 * The open windows whose time is up.
 *
 * Settling is answered **before** the readings are taken, so a window that ran out
 * between two pulses stops there rather than collecting one more reading past its
 * own end. Its verdict is fixed and its rows stay on the goal page as the
 * permanent account of what production said about this work.
 */
export function settlingWindows(windows: readonly WatchWindow[], now: number): WatchWindow[] {
  return windows.filter((w) => w.settledAt === null && Date.parse(w.settlesAt) <= now);
}

/**
 * The open windows due a reading this pulse, oldest first and capped.
 *
 * Due is measured off the window's own newest reading rather than off a shared
 * clock, so a window opened mid-interval is read on its own schedule and a backlog
 * that defers past the cap keeps its place: what this leaves out is asked on the
 * next pulse, oldest first.
 */
export function dueWindows(input: {
  windows: readonly WatchWindow[];
  /** Every reading held — read only for the newest `readAt` per window. */
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
    // Never read is due now: the first reading is the one the operator is waiting
    // for, and holding it back an interval would make a fresh arrival look unwatched.
    if (read !== undefined && read > floor) continue;
    out.push(w);
    if (out.length >= MAX_WATCH_WINDOWS_PER_PULSE) break;
  }
  return out;
}
