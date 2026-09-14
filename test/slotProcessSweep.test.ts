import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ErrorLogEntry, ErrorLogInput } from '../src/types.js';
import { WorktreeManager } from '../src/worktree/worktreeManager.js';
import { FakeSlotProcesses } from '../src/worktree/fakeSlotProcesses.js';
import { childrenFirst, CommandSlotProcesses, probeFailure, type SlotProcess } from '../src/worktree/slotProcesses.js';
import { tmpDir } from './support/gitRepo.js';

function initRepo(): string {
  const dir = tmpDir('lubbdubb-repo-');
  const run = (args: string[]) => execFileSync('git', args, { cwd: dir });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 't@t.com']);
  run(['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  writeFileSync(join(dir, '.gitignore'), 'deps/\n');
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
      return { ...input, id: 'e1', detail: input.detail ?? null, createdAt: '2026-08-19T00:00:00.000Z' };
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

/**
 * Makes `git clean -ffdx` fail on a slot, the way a left-behind process does, without the sweep
 * being able to fix it: on Windows a live process whose cwd is a directory in the slot, which rmdir
 * refuses; on POSIX an unwritable directory, since POSIX removes a live process's cwd quite happily.
 */
function wedge(slot: string): () => Promise<void> {
  const dir = join(slot, 'wedge');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'left-behind.txt'), 'an earlier occupant');
  if (process.platform !== 'win32') {
    chmodSync(dir, 0o500);
    return () => {
      chmodSync(dir, 0o700);
      return Promise.resolve();
    };
  }
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dir, stdio: 'ignore' });
  const gone = settle(child);
  return async () => {
    child.kill();
    await gone;
  };
}

/** Resolves once the process has actually exited and Windows has given its handles back. */
function settle(child: ChildProcess): Promise<void> {
  return new Promise<void>((done) => {
    if (child.exitCode !== null) {
      done();
      return;
    }
    child.once('exit', () => setTimeout(done, HANDLES_SETTLE_MS));
  });
}

const HANDLES_SETTLE_MS = 300;

test('releasing a slot terminates what the last occupant left standing in it', async () => {
  const repo = initRepo();
  const processes = new FakeSlotProcesses();
  const wt = manager(repo, 4, processes);

  const slot = await wt.ensure('feature/x');
  processes.standing(slot, [
    { pid: 4100, parentPid: 4000, detail: `${slot}/node_modules/esbuild/esbuild.exe` },
    { pid: 4000, parentPid: 1, detail: `${slot}/node_modules/.bin/vite` },
  ]);

  await wt.remove('feature/x');

  assert.deepEqual(processes.killed, [4100, 4000], 'children are signalled before their parents');
  assert.ok(processes.asked.includes(slot));
});

test('a handover sweeps the slot before it wipes it', async () => {
  const repo = initRepo();
  const processes = new FakeSlotProcesses();
  const wt = manager(repo, 1, processes);

  const slot = await wt.ensure('feature/x');
  mkdirSync(join(slot, 'deps'), { recursive: true });
  writeFileSync(join(slot, 'deps', 'installed.txt'), 'a dependency tree, in miniature');
  await wt.remove('feature/x');
  processes.killed.length = 0;
  processes.standing(slot, [{ pid: 5000, parentPid: 1, detail: `${slot}/node_modules/.bin/tsc` }]);

  const handed = await wt.ensure('feature/y');

  assert.equal(handed, slot);
  assert.deepEqual(processes.killed, [5000]);
  assert.ok(!existsSync(join(slot, 'deps', 'installed.txt')), 'the wipe ran after the sweep');
});

test('a slot whose wipe is refused is taken out of the pool and the dispatch goes to another', async () => {
  const repo = initRepo();
  const processes = new FakeSlotProcesses();
  const errors = recorder();
  const wt = manager(repo, 2, processes, errors);

  const first = await wt.ensure('feature/x');
  const spare = await wt.ensure('feature/w');
  await wt.remove('feature/x');
  await wt.remove('feature/w');
  const release = wedge(first);
  processes.standing(first, [{ pid: 6000, parentPid: 1, detail: `${first}/node_modules/.bin/vite` }]).stubborn(6000);

  try {
    const second = await wt.ensure('feature/y');
    assert.equal(second, spare, 'the condemned slot is skipped and another is handed over');

    const faults = errors.entries.filter((e) => e.message.includes('cannot be emptied'));
    assert.equal(faults.length, 1, 'the fault is surfaced once, not once per pulse');
    assert.match(faults[0]?.message ?? '', /pid 6000/);
    assert.match(faults[0]?.message ?? '', /node_modules/);

    await wt.remove('feature/y');
    const third = await wt.ensure('feature/z');
    assert.notEqual(third, first);
    assert.equal(
      errors.entries.filter((e) => e.message.includes('cannot be emptied')).length,
      1,
      'a second dispatch does not re-propose the same handover',
    );
  } finally {
    await release();
  }
});

test('the exhaustion refusal names the slot that was taken out and why', async () => {
  const repo = initRepo();
  const processes = new FakeSlotProcesses();
  const wt = manager(repo, 1, processes, recorder());

  const only = await wt.ensure('feature/x');
  await wt.remove('feature/x');
  const release = wedge(only);
  processes.standing(only, [{ pid: 7000, parentPid: 1, detail: `${only}/node_modules/.bin/vite` }]);

  try {
    await assert.rejects(wt.ensure('feature/y'), (err: Error) => {
      assert.match(err.message, /No free worktree slot/);
      assert.ok(err.message.includes(only));
      assert.match(err.message, /the wipe was refused/);
      return true;
    });
  } finally {
    await release();
  }
});

test('a slot comes back into the pool once nothing is holding it', async () => {
  const repo = initRepo();
  const processes = new FakeSlotProcesses();
  const errors = recorder();
  const wt = manager(repo, 1, processes, errors);

  const only = await wt.ensure('feature/x');
  await wt.remove('feature/x');
  const release = wedge(only);
  processes.standing(only, [{ pid: 8000, parentPid: 1, detail: `${only}/node_modules/.bin/vite` }]).stubborn(8000);
  await assert.rejects(wt.ensure('feature/y'));

  await release();
  processes.standing(only, []);

  const back = await wt.ensure('feature/z');
  assert.equal(back, only);
  assert.equal(errors.entries.filter((e) => e.message.includes('is back in the pool')).length, 1);
});

test('a slot condemned while the process table could not be read comes back once it can', async () => {
  const repo = initRepo();
  const processes = new FakeSlotProcesses();
  const errors = recorder();
  const wt = manager(repo, 1, processes, errors);

  const only = await wt.ensure('feature/x');
  await wt.remove('feature/x');
  const release = wedge(only);
  processes.unreadable(only);
  await assert.rejects(wt.ensure('feature/y'));

  const fault = errors.entries.find((e) => e.message.includes('cannot be emptied'));
  assert.ok(fault !== undefined);
  assert.match(fault.message, /could not read the process table/);
  assert.doesNotMatch(fault.message, /Nothing the harness can see is holding it/);

  await release();
  processes.unreadable(only, false);

  const back = await wt.ensure('feature/z');
  assert.equal(back, only, 'an unreadable probe is not a condemnation nothing could ever change');
});

test('a probe that could not answer says why, not which script it ran', () => {
  assert.match(
    probeFailure(Object.assign(new Error('Command failed: powershell …'), { killed: true, signal: 'SIGTERM' })),
    /still running after 20000ms and was killed/,
  );
  assert.equal(
    probeFailure(
      Object.assign(new Error('Command failed'), { code: 1, stderr: 'Get-Process : Access denied\nat line:1' }),
    ),
    'it exited 1: Get-Process : Access denied',
  );
  assert.equal(probeFailure(Object.assign(new Error('spawn powershell ENOENT'), { code: 'ENOENT' })), 'ENOENT');
});

test('children are signalled before their parents, however the list arrives', () => {
  const held: SlotProcess[] = [
    { pid: 10, parentPid: 1, detail: 'the shell' },
    { pid: 30, parentPid: 20, detail: 'the bundler' },
    { pid: 20, parentPid: 10, detail: 'the dev server' },
  ];
  assert.deepEqual(
    childrenFirst(held).map((p) => p.pid),
    [30, 20, 10],
  );
});

test('a cycle in the parent links does not hang the ordering', () => {
  const held: SlotProcess[] = [
    { pid: 1, parentPid: 2, detail: 'a' },
    { pid: 2, parentPid: 1, detail: 'b' },
  ];
  assert.equal(childrenFirst(held).length, 2);
});

test(
  'a run that leaves a dev server in a slot does not wedge the next handover',
  { skip: process.platform !== 'win32' ? 'a mapped image only refuses an unlink on Windows' : false },
  async () => {
    const repo = initRepo();
    const worktrees = join(repo, '.wt');
    const swept = new WorktreeManager(
      repo,
      worktrees,
      { size: 1, held: () => false },
      join(repo, '.preview'),
      recorder(),
      new CommandSlotProcesses(),
    );

    const slot = await swept.ensure('feature/x');
    // The reported symptom exactly: a binary under the slot's own node_modules, running.
    const bin = join(slot, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    const exe = join(bin, 'devserver.exe');
    copyFileSync(process.execPath, exe);
    const server = spawn(exe, ['-e', 'setInterval(() => {}, 1000)'], { cwd: slot, stdio: 'ignore' });
    const reaped = settle(server);
    await new Promise((r) => setTimeout(r, 500));

    // Without the sweep the wipe is refused, which is the bug this is about.
    try {
      execFileSync('git', ['clean', '-ffdx'], { cwd: slot, stdio: 'pipe' });
    } catch {
      // Expected: `warning: failed to remove …`, a non-zero exit.
    }
    assert.ok(existsSync(exe), 'the mapped image survives a wipe while its process is alive');

    await swept.remove('feature/x');
    const handed = await swept.ensure('feature/y');

    await reaped;
    assert.equal(handed, slot, 'the same slot is handed over, with no manual cleanup');
    assert.ok(!existsSync(exe), 'the wipe emptied the slot once the process was reaped');
  },
);
