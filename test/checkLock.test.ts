/**
 * The check lock, exercised the way it fails: several real processes racing for one
 * lockfile. Every test here spawns `test/support/checkLockChild.ts`, because the bug
 * this guards against — two `npm run check` runs budgeting the same cores — is
 * cross-process by construction and invisible to a single-process test.
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('discards a lockfile it cannot read', async () => {
    const { lock, log } = paths();
    writeFileSync(lock, 'not json');

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
