/**
 * A cross-process advisory lock for `npm run check`, and the core budget it defends.
 *
 * `check` sizes its pool to the whole machine, which is right exactly once: two runs
 * at the same time each claim every core, and an 8-core box goes to a load average
 * in the forties. Nothing in the pool can see the other run, so the arbitration has
 * to live outside both — a lockfile, taken with `O_EXCL` so the winner is decided by
 * the kernel rather than by a read-then-write both runs would win.
 *
 * A lock that can wedge the gate is worse than the contention it fixes, so a stale
 * lockfile is never fatal. Three things clear one: a release on the way out (clean
 * exit, SIGINT or SIGTERM), a liveness probe on the recorded pid, and an age ceiling
 * for the case liveness gets wrong — `SIGKILL` leaves the file behind, and the pid it
 * names is eventually reused by something unrelated that would otherwise look alive
 * forever.
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

interface Holder {
  readonly pid: number;
  readonly startedAt: number;
}

interface Lock {
  /** Idempotent: the signal handlers and a normal return both end up here. */
  readonly release: () => void;
}

interface AcquireOptions {
  readonly path: string;
  readonly pollMs?: number;
  /** Called once, with the holder, when this run is about to start waiting. */
  readonly onWait?: (holder: Holder) => void;
}

/**
 * Long enough that no honest check is mistaken for dead — the suite is a couple of
 * minutes, and a cold `npm ci` box is slower — short enough that a `SIGKILL`ed run
 * whose pid has been reused does not hold the gate for a working day.
 */
const MAX_AGE_MS = 60 * 60 * 1000;

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/** The lockfile is written by another process, so nothing about it is assumed. */
const isHolder = (value: unknown): value is Holder =>
  typeof value === 'object' &&
  value !== null &&
  'pid' in value &&
  typeof value.pid === 'number' &&
  'startedAt' in value &&
  typeof value.startedAt === 'number';

const errnoOf = (err: unknown): string | undefined =>
  err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : undefined;

const readHolder = (path: string): Holder | undefined => {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // Gone between the failed create and this read: the holder released. Retry.
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isHolder(parsed) ? parsed : undefined;
  } catch {
    // A truncated or hand-edited lockfile names nobody, so it holds nothing.
    return undefined;
  }
};

const holds = (holder: Holder): boolean => {
  if (Date.now() - holder.startedAt > MAX_AGE_MS) return false;
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch (err) {
    // EPERM means alive and owned by another user; anything else means gone.
    return errnoOf(err) === 'EPERM';
  }
};

/**
 * Only clears the file if it still names the pid we judged dead, so a waiter cannot
 * delete the fresh lock another waiter took in the gap between the two.
 */
const clearStale = (path: string, stale: Holder | undefined): void => {
  const current = readHolder(path);
  if (current !== undefined && current.pid !== stale?.pid) return;
  try {
    unlinkSync(path);
  } catch {
    // Someone else cleared it first, which is the outcome we wanted anyway.
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function acquireCheckLock(options: AcquireOptions): Promise<Lock> {
  const { path, pollMs = 250, onWait } = options;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let announced = false;

  for (;;) {
    try {
      // 'wx' is the whole lock: O_EXCL, so exactly one of two racing runs creates it.
      const fd = openSync(path, 'wx', 0o600);
      const holder: Holder = { pid: process.pid, startedAt: Date.now() };
      writeSync(fd, JSON.stringify(holder));
      closeSync(fd);
      return arm(path, holder);
    } catch (err) {
      if (errnoOf(err) !== 'EEXIST') throw err;
    }

    const holder = readHolder(path);
    if (holder === undefined || !holds(holder)) {
      clearStale(path, holder);
      continue;
    }
    if (!announced) {
      announced = true;
      onWait?.(holder);
    }
    await sleep(pollMs);
  }
}

/**
 * Registers the exits before handing the lock back. `exit` covers a throw and a
 * normal return; the signal handlers exist because node's defaults terminate without
 * running it, and re-raising with the default handler removed keeps the exit status
 * the one the shell expects from an interrupted command.
 */
function arm(path: string, mine: Holder): Lock {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.off('exit', release);
    for (const signal of SIGNALS) process.off(signal, onSignal);
    // Never unlink a lock that is no longer ours — ours may have been broken as stale.
    const current = readHolder(path);
    if (current?.pid !== mine.pid) return;
    try {
      unlinkSync(path);
    } catch {
      // Already gone. Nothing to hold on to.
    }
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    release();
    process.kill(process.pid, signal);
  };

  process.on('exit', release);
  for (const signal of SIGNALS) process.on(signal, onSignal);
  return { release };
}

/**
 * `CHECK_CORES` is for the case the machine is not idle — a game client, a build in
 * another checkout — where the honest core count is a lie about what is available.
 * Anything that is not a positive integer is ignored rather than clamped: a typo
 * silently pinning the pool to one job is the failure mode worth avoiding.
 */
export function resolveCoreBudget(env: Record<string, string | undefined>, fallback: number): number {
  const raw = env['CHECK_CORES'];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    process.stderr.write(`check: ignoring CHECK_CORES=${raw} (want a positive integer)\n`);
    return fallback;
  }
  return parsed;
}
