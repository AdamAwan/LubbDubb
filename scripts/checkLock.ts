import { linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface Holder {
  readonly pid: number;
  readonly startedAt: number;
}

interface Sighting {
  readonly raw: string;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly holder?: Holder;
}

interface Lock {
  readonly release: () => void;
}

interface AcquireOptions {
  readonly path: string;
  readonly pollMs?: number;
  readonly onWait?: (holder: Holder) => void;
}

const MAX_AGE_MS = 60 * 60 * 1000;

const UNNAMED_GRACE_MS = 5_000;

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

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
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isHolder(parsed) ? { raw, ino, mtimeMs, holder: parsed } : { raw, ino, mtimeMs };
  } catch {
    return { raw, ino, mtimeMs };
  }
};

const holds = (holder: Holder): boolean => {
  if (Date.now() - holder.startedAt > MAX_AGE_MS) return false;
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch (err) {
    return errnoOf(err) === 'EPERM';
  }
};

let staged = 0;

const take = (path: string, holder: Holder): Sighting | undefined => {
  staged += 1;
  const stage = `${path}.${process.pid}.${staged}.staged`;
  const raw = JSON.stringify(holder);
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

function arm(path: string, mine: Sighting): Lock {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.off('exit', release);
    for (const signal of SIGNALS) process.off(signal, onSignal);
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
