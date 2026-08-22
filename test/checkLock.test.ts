/**
 * The check lock, exercised the way it fails: several real processes racing for one
 * lockfile. Every test here spawns `test/support/checkLockChild.ts`, because the bug
 * this guards against — two `npm run check` runs budgeting the same cores — is
 * cross-process by construction and invisible to a single-process test.
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveCoreBudget } from '../scripts/checkLock.js';

const CHILD = fileURLToPath(new URL('./support/checkLockChild.ts', import.meta.url));

let dir: string;
let seq = 0;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'checklock-'));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A fresh lock/log pair per test, so a leaked lockfile cannot leak between them. */
const paths = (): { lock: string; log: string } => {
  seq += 1;
  return { lock: join(dir, `${seq}.lock`), log: join(dir, `${seq}.log`) };
};

const spawnChild = (lock: string, log: string, holdMs: number): ChildProcess =>
  spawn(process.execPath, ['--import', 'tsx', CHILD, lock, log, String(holdMs)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** Resolves when the child reports the lock is in hand, rejects if it exits first. */
const acquired = (child: ChildProcess): Promise<void> =>
  new Promise((resolve, reject) => {
    let seen = '';
    child.stdout?.on('data', (c: Buffer) => {
      seen += c.toString();
      if (seen.includes('acquired')) resolve();
    });
    child.on('exit', (code) => reject(new Error(`child exited (${code}) before acquiring`)));
  });

const stderrOf = (child: ChildProcess): { text: () => string } => {
  let text = '';
  child.stderr?.on('data', (c: Buffer) => (text += c.toString()));
  return { text: () => text };
};

/** The non-throwing view of `acquired`: what the child has said so far, if anything. */
const stdoutOf = (child: ChildProcess): { text: () => string } => {
  let text = '';
  child.stdout?.on('data', (c: Buffer) => (text += c.toString()));
  return { text: () => text };
};

/** Puts a record under the lock's name the way the lock does: complete, in one step. */
const publishRecord = (lock: string, pid: number): void => {
  const staging = `${lock}.seed`;
  writeFileSync(staging, JSON.stringify({ pid, startedAt: Date.now() }));
  renameSync(staging, lock);
};

/** A reading of the lockfile, or undefined if those bytes are not a whole record. */
const recordIn = (raw: string): { pid: number } | undefined => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && 'pid' in parsed && typeof parsed.pid === 'number'
      ? { pid: parsed.pid }
      : undefined;
  } catch {
    return undefined;
  }
};

/** So a failed assertion cannot leave a child holding the lock and the suite open. */
const reap = (child: ChildProcess): void => {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
};

/** Whatever a take staged beside the lock and did not clean up. */
const litter = (): string[] => readdirSync(dir).filter((name) => name.endsWith('.staged'));

const exited = (child: ChildProcess): Promise<number | null> =>
  new Promise((resolve) => child.on('exit', (code) => resolve(code)));

const waitFor = async (predicate: () => boolean, ms = 10_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out waiting for condition');
};

describe('check lock', () => {
  it('serialises concurrent processes', async () => {
    const { lock, log } = paths();
    const children = [0, 1, 2, 3].map(() => spawnChild(lock, log, 200));
    const codes = await Promise.all(children.map(exited));

    assert.deepEqual(codes, [0, 0, 0, 0]);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(lines.length, 8, 'every child both entered and exited');
    // An overlap shows up as two `enter`s in a row — the only shape a lock forbids.
    for (const [i, line] of lines.entries()) {
      assert.match(line, i % 2 === 0 ? /^enter / : /^exit /);
    }
    for (let i = 0; i < lines.length; i += 2) {
      assert.equal(lines[i]?.split(' ')[1], lines[i + 1]?.split(' ')[1], 'paired by pid');
    }
    assert.equal(existsSync(lock), false, 'released on clean exit');
  });

  it('never shows a lockfile that names nobody', async () => {
    const { lock, log } = paths();
    // A take is one `link` of an already-written file, so every reading of the
    // lockfile — the first one included — is a whole record. The two-step take this
    // replaces created the name empty and filled it in afterwards, and a waiter that
    // read it in between cleared a live holder's lock.
    const readings: string[] = [];
    const watcher = { stop: false };
    const watching = (async () => {
      while (!watcher.stop) {
        try {
          readings.push(readFileSync(lock, 'utf8'));
        } catch {
          // Not taken yet, or released already. Only what exists is evidence.
        }
        await new Promise((r) => setImmediate(r));
      }
    })();

    const holder = spawnChild(lock, log, -1);
    try {
      await acquired(holder);
      watcher.stop = true;
      await watching;
      // The holder is still in, so this last one is not a race with anything: how
      // many of the arrival the loop caught is up to the machine, but not this.
      readings.push(readFileSync(lock, 'utf8'));

      for (const raw of readings) {
        assert.equal(recordIn(raw)?.pid, holder.pid, `a reading that names nobody: ${JSON.stringify(raw)}`);
      }
      assert.deepEqual(litter(), [], 'the staged file is not left behind');
    } finally {
      watcher.stop = true;
      reap(holder);
    }
    await exited(holder);
  });

  it('leaves a lockfile that names nobody alone while it could still be arriving', async () => {
    const { lock, log } = paths();
    // The window itself, held open: the name is taken and the record is not there
    // yet. Nothing in the file says who holds it, and that is not grounds to clear
    // it — the age of the bytes is what separates litter from an arrival.
    writeFileSync(lock, '');

    const waiter = spawnChild(lock, log, 0);
    const out = stdoutOf(waiter);
    const err = stderrOf(waiter);
    try {
      await new Promise((r) => setTimeout(r, 1_000));
      assert.equal(out.text().includes('acquired'), false, 'a lockfile that named nobody was taken as free');
      assert.equal(readFileSync(lock, 'utf8'), '', 'and it was left exactly as it was found');

      // Now it names its holder, the way it does a moment after the name is claimed.
      publishRecord(lock, process.pid);
      await waitFor(() => err.text().includes(`waiting ${process.pid}`));
    } catch (failure) {
      reap(waiter);
      throw failure;
    }

    rmSync(lock);
    assert.equal(await exited(waiter), 0);
  });

  it('names the holder to whoever is waiting', async () => {
    const { lock, log } = paths();
    const holder = spawnChild(lock, log, -1);
    await acquired(holder);

    const waiter = spawnChild(lock, log, 0);
    const err = stderrOf(waiter);
    await waitFor(() => err.text().includes(`waiting ${holder.pid}`));

    holder.kill('SIGKILL');
    await exited(waiter);
  });

  it('takes over a lock whose holder was killed outright', async () => {
    const { lock, log } = paths();
    const holder = spawnChild(lock, log, -1);
    await acquired(holder);
    // SIGKILL is the case no handler can cover: the lockfile outlives the process.
    holder.kill('SIGKILL');
    await exited(holder);
    assert.equal(existsSync(lock), true, 'the stale lockfile is still there');

    const next = spawnChild(lock, log, 0);
    await acquired(next);
    assert.equal(await exited(next), 0);
  });

  it('releases on SIGINT', async () => {
    const { lock, log } = paths();
    const holder = spawnChild(lock, log, -1);
    await acquired(holder);

    holder.kill('SIGINT');
    const code = await exited(holder);
    assert.notEqual(code, 0, 'an interrupted check is not a passing check');
    assert.equal(existsSync(lock), false, 'released, not left for the next run to clear');
  });

  it('releases on SIGTERM', async () => {
    const { lock, log } = paths();
    const holder = spawnChild(lock, log, -1);
    await acquired(holder);

    holder.kill('SIGTERM');
    await exited(holder);
    assert.equal(existsSync(lock), false);
  });

  it('breaks a lock held by a live but unrelated pid', async () => {
    const { lock, log } = paths();
    // Our own pid is alive, so liveness alone would wait forever: pids get reused,
    // and the age ceiling is the only thing that tells the two cases apart.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 7_200_000 }));

    const child = spawnChild(lock, log, 0);
    await acquired(child);
    assert.equal(await exited(child), 0);
  });

  it('discards a lockfile it cannot read once it has stopped changing', async () => {
    const { lock, log } = paths();
    writeFileSync(lock, 'not json');
    // Backdated past the grace an arriving lock gets: these bytes name nobody, and
    // nothing is going to fill them in.
    const settled = new Date(Date.now() - 60_000);
    utimesSync(lock, settled, settled);

    const child = spawnChild(lock, log, 0);
    await acquired(child);
    assert.equal(await exited(child), 0);
  });
});

describe('core budget', () => {
  it('defaults to the machine', () => {
    assert.equal(resolveCoreBudget({}, 8), 8);
    assert.equal(resolveCoreBudget({ CHECK_CORES: '' }, 8), 8);
  });

  it('takes CHECK_CORES when it is a positive integer', () => {
    assert.equal(resolveCoreBudget({ CHECK_CORES: '4' }, 8), 4);
    assert.equal(resolveCoreBudget({ CHECK_CORES: '1' }, 8), 1);
    assert.equal(resolveCoreBudget({ CHECK_CORES: '16' }, 8), 16);
  });

  it('ignores values that are not a core count', () => {
    for (const bad of ['0', '-2', '2.5', 'four', ' ']) {
      assert.equal(resolveCoreBudget({ CHECK_CORES: bad }, 8), 8, bad);
    }
  });
});
