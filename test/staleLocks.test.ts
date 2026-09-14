import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ErrorLogEntry, ErrorLogInput } from '../src/types.js';
import { WorktreeManager } from '../src/worktree/worktreeManager.js';
import { FakeSlotProcesses } from '../src/worktree/fakeSlotProcesses.js';
import { lockPaths } from '../src/worktree/staleLocks.js';
import { tmpDir } from './support/gitRepo.js';

function initRepo(): string {
  const dir = tmpDir('lubbdubb-repo-');
  const run = (args: string[]) => execFileSync('git', args, { cwd: dir });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 't@t.com']);
  run(['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'init']);
  return dir;
}

function recorder(): { entries: ErrorLogInput[]; record: (input: ErrorLogInput) => ErrorLogEntry } {
  const entries: ErrorLogInput[] = [];
  return {
    entries,
    record(input) {
      entries.push(input);
      return { ...input, id: 'e1', detail: input.detail ?? null, createdAt: '2026-09-14T00:00:00.000Z' };
    },
  };
}

function manager(
  repo: string,
  size: number,
  processes: FakeSlotProcesses,
  errors?: ReturnType<typeof recorder>,
): WorktreeManager {
  return new WorktreeManager(
    repo,
    join(repo, '.wt'),
    { size, held: () => false },
    join(repo, '.preview'),
    errors,
    processes,
  );
}

/** The index.lock a git process that died mid-command leaves in a slot's own metadata directory. */
function plantLock(slot: string, ageMs: number): string {
  const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: slot, encoding: 'utf8' }).trim();
  mkdirSync(gitDir, { recursive: true });
  const lock = join(gitDir, 'index.lock');
  writeFileSync(lock, '');
  const when = (Date.now() - ageMs) / 1000;
  utimesSync(lock, when, when);
  return lock;
}

test('the lock files a git refusal names are read out of its message', () => {
  const slot = resolve('/repo/slot-1');
  const gitDir = resolve('/repo/.git/worktrees/slot-1');
  const detail =
    'Command failed: git switch --quiet issue/36420/filters\n' +
    `fatal: Unable to create '${gitDir}/index.lock': File exists.\n` +
    'Another git process seems to be running in this repository, e.g. an editor opened by\n' +
    "'git commit'. Please make sure all processes are terminated then try again. If it still\n" +
    'fails, a git process may have crashed in this repository earlier:\n' +
    `remove the file manually to continue.\nfatal: Unable to create '${gitDir}/index.lock': File exists.\n`;

  assert.deepEqual(lockPaths(slot, detail), [join(gitDir, 'index.lock')], 'named twice, asked about once');
  assert.deepEqual(lockPaths(slot, "fatal: Unable to create 'refs/heads/x.lock': File exists."), [
    join(slot, 'refs/heads/x.lock'),
  ]);
  assert.deepEqual(lockPaths(slot, 'error: unable to create file deps/x: Invalid argument'), []);
});

test('a slot wedged by a stale index.lock is cleared and handed over', async () => {
  const repo = initRepo();
  const processes = new FakeSlotProcesses();
  const errors = recorder();
  const wt = manager(repo, 1, processes, errors);

  const only = await wt.ensure('feature/x');
  await wt.remove('feature/x');
  const lock = plantLock(only, 17 * 24 * 3_600_000);

  const handed = await wt.ensure('feature/y');

  assert.equal(handed, only, 'the same slot is handed over rather than refused for ever');
  assert.ok(!existsSync(lock), 'the stale lock was removed');
  const cleared = errors.entries.filter((e) => e.message.includes('Removed the stale git lock'));
  assert.equal(cleared.length, 1);
  assert.match(cleared[0]?.message ?? '', /17 days old/);
  assert.deepEqual(
    processes.askedPaths.at(-1),
    [lock],
    'the probe for a holder is asked about the lock, not walked over the whole slot',
  );
});

test('a lock too young to be stale is left alone and the slot leaves the pool', async () => {
  const repo = initRepo();
  const processes = new FakeSlotProcesses();
  const errors = recorder();
  const wt = manager(repo, 2, processes, errors);

  const first = await wt.ensure('feature/x');
  const spare = await wt.ensure('feature/w');
  await wt.remove('feature/x');
  await wt.remove('feature/w');
  const lock = plantLock(first, 30_000);

  const second = await wt.ensure('feature/y');

  assert.equal(second, spare, 'the condemned slot is skipped and another is handed over');
  assert.ok(existsSync(lock), 'a lock a live git command could still own is not removed');
  const faults = errors.entries.filter((e) => e.message.includes('cannot be handed to'));
  assert.equal(faults.length, 1, 'the fault is surfaced once, not once per pulse');
  assert.match(faults[0]?.message ?? '', /branch feature\/y/);
  assert.ok(faults[0]?.message.includes(lock));
});

test('a slot held out by a lock comes back into the pool once the lock is gone', async () => {
  const repo = initRepo();
  const processes = new FakeSlotProcesses();
  const errors = recorder();
  const wt = manager(repo, 1, processes, errors);

  const only = await wt.ensure('feature/x');
  await wt.remove('feature/x');
  const lock = plantLock(only, 30_000);
  await assert.rejects(wt.ensure('feature/y'), (err: Error) => {
    assert.match(err.message, /No free worktree slot/);
    assert.match(err.message, /the switch was refused/);
    return true;
  });

  // The wipe the revival performs succeeds on this slot every time — the lock is metadata, not
  // working tree — so the lock's own presence is what has to hold the condemnation.
  await assert.rejects(wt.ensure('feature/y'), /No free worktree slot/);
  assert.equal(errors.entries.filter((e) => e.message.includes('cannot be handed to')).length, 1);

  rmSync(lock);
  const handed = await wt.ensure('feature/y');
  assert.equal(handed, only);
  assert.match(errors.entries.at(-1)?.message ?? '', /is back in the pool/);
});
