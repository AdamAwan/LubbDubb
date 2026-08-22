/**
 * A cross-process advisory lock for `npm run check`, and the core budget it defends.
 *
 * `check` sizes its pool to the whole machine, which is right exactly once: two runs
 * at the same time each claim every core, and an 8-core box goes to a load average
 * in the forties. Nothing in the pool can see the other run, so the arbitration has
 * to live outside both — a lockfile, whose name only one of two racing runs can win,
 * decided by the kernel rather than by a read-then-write both runs would win.
 *
 * The record and the name are claimed in one step: the payload is written to a private
 * file and `link`ed into place. `link` fails `EEXIST` when the name is taken, which is
 * the same arbitration `O_EXCL` gives — minus `O_EXCL`'s window, where the winner's
 * lockfile exists, is empty, and names nobody. A waiter arriving in that window used to
 * read a file that named nobody, take that for an abandoned lock, and unlink a live
 * holder's file. So the two-step take is the bug, not a detail of it: an empty lockfile
 * must never be a state this file can produce.
 *
 * A lock that can wedge the gate is worse than the contention it fixes, so a stale
 * lockfile is never fatal. Three things clear one: a release on the way out (clean
 * exit, SIGINT or SIGTERM), a liveness probe on the recorded pid, and an age ceiling
 * for the case liveness gets wrong — `SIGKILL` leaves the file behind, and the pid it
 * names is eventually reused by something unrelated that would otherwise look alive
 * forever. Each of those names a pid and judges it; a lockfile that names nobody is
 * never grounds enough on its own.
 */
import { linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface Holder {
  readonly pid: number;
  readonly startedAt: number;
}

/** One reading of the lockfile: what it said, and which file said it. */
interface Sighting {
  readonly raw: string;
  readonly ino: number;
  readonly mtimeMs: number;
  /** Absent when the bytes name nobody — corrupt, or written by something else. */
  readonly holder?: Holder;
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

/**
 * How long a lockfile that names nobody is left alone before it is treated as litter.
 * A take is one `link` of an already-written file, so no reading of a lockfile this
 * file wrote can be unnamed — but a build from before that, or a hand-edited file,
 * can be, and the two are indistinguishable from the outside. Waiting is the safe way
 * round: seconds is far longer than any write, and short enough that a corrupt file
 * costs one pause rather than a wedged gate.
 */
const UNNAMED_GRACE_MS = 5_000;

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

const sight = (path: string): Sighting | undefined => {
  let raw: string;
  let ino: number;
  let mtimeMs: number;
  try {
    raw = readFileSync(path, 'utf8');
    const stat = statSync(path);
    ino = Number(stat.ino);
    mtimeMs = stat.mtimeMs;
  } catch {
    // Gone between the failed take and this read: the holder released. Retry.
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isHolder(parsed) ? { raw, ino, mtimeMs, holder: parsed } : { raw, ino, mtimeMs };
  } catch {
    // A truncated or hand-edited lockfile names nobody, so it holds nothing.
    return { raw, ino, mtimeMs };
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

let staged = 0;

/**
 * Takes the lock, or reports that someone else holds it. The payload is complete
 * before the name exists, so there is no instant at which the lockfile is visible and
 * says nothing. The private file is staged beside the lock — the same directory, so
 * `link` stays within one filesystem — and is unlinked on both arms. The sighting we
 * hold on to is stat'd through the staged name rather than the lock's: the two are
 * one inode once the link lands, and the staged name is ours alone, so reading it
 * back through the shared one would be a race with whoever takes the lock next.
 */
const take = (path: string, holder: Holder): Sighting | undefined => {
  staged += 1;
  const stage = `${path}.${process.pid}.${staged}.staged`;
  const raw = JSON.stringify(holder);
  // Overwrites rather than refuses: the name carries our pid, so anything already
  // under it is our own litter from a crash between the write and the link.
  writeFileSync(stage, raw, { mode: 0o600 });
  try {
    linkSync(stage, path);
    const stat = statSync(stage);
    return { raw, ino: Number(stat.ino), mtimeMs: stat.mtimeMs, holder };
  } catch (err) {
    if (errnoOf(err) !== 'EEXIST') throw err;
    return undefined;
  } finally {
    try {
      unlinkSync(stage);
    } catch {
      // Nothing staged is worth failing a check over.
    }
  }
};

/**
 * Unlinks the lockfile only if it is still the exact file that was judged — same
 * bytes, same inode, same mtime. Judging and deleting are two reads of a shared name,
 * and everything that goes wrong here lives between them: the holder released and
 * someone else took the lock, or the file named nobody a moment ago and names its
 * holder now. Identity makes the two reads one decision.
 */
const clearJudged = (path: string, judged: Sighting): void => {
  const current = sight(path);
  if (current === undefined) return;
  if (current.raw !== judged.raw || current.ino !== judged.ino || current.mtimeMs !== judged.mtimeMs) return;
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
    const mine = take(path, { pid: process.pid, startedAt: Date.now() });
    if (mine !== undefined) return arm(path, mine);

    const seen = sight(path);
    if (seen === undefined) continue;
    if (seen.holder === undefined) {
      // Names nobody. Only its age separates litter from a file mid-arrival.
      if (Date.now() - seen.mtimeMs >= UNNAMED_GRACE_MS) {
        clearJudged(path, seen);
        continue;
      }
    } else if (!holds(seen.holder)) {
      clearJudged(path, seen);
      continue;
    } else if (!announced) {
      announced = true;
      onWait?.(seen.holder);
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
function arm(path: string, mine: Sighting): Lock {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.off('exit', release);
    for (const signal of SIGNALS) process.off(signal, onSignal);
    // Never unlink a lock that is no longer ours — ours may have been broken as stale.
    clearJudged(path, mine);
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
