import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorktreeManager } from '../src/worktree/worktreeManager.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeSlotProcesses } from '../src/worktree/fakeSlotProcesses.js';
import { PrewarmDesk } from '../src/worktree/prewarmDesk.js';
import type { ErrorLogEntry, ErrorLogInput } from '../src/types.js';
import type { ErrorRecorder } from '../src/errorLog.js';
import type { QueueItem } from '../src/dispatcher/dispatcher.js';
import { tmpDir } from './support/gitRepo.js';

class Recorded implements ErrorRecorder {
  readonly entries: ErrorLogInput[] = [];
  record(input: ErrorLogInput): ErrorLogEntry {
    this.entries.push(input);
    return { id: `err_${this.entries.length}`, createdAt: new Date().toISOString(), detail: null, ...input };
  }
}

function repo(): string {
  const dir = tmpDir('lubbdubb-prewarm-');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@t.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

function manager(dir: string, size: number, held: (branch: string) => boolean = () => false): WorktreeManager {
  return new WorktreeManager(
    dir,
    join(dir, '.wt'),
    { size, held },
    join(dir, '.preview'),
    undefined,
    new FakeSlotProcesses(),
  );
}

function item(branch: string, over: Partial<QueueItem> = {}): QueueItem {
  return {
    origin: `issue:1:code`,
    rule: 'issue-code' as QueueItem['rule'],
    title: branch,
    kind: 'code',
    branch,
    status: 'capped',
    reason: 'no headroom',
    ...over,
  };
}

test('warming mints the slot the queued branch will want, and only for a branch that is queued', async () => {
  const dir = repo();
  const wt = manager(dir, 2);
  git(dir, ['branch', 'fix/ci']);

  assert.equal(await wt.prewarm([]), null, 'an empty queue mints nothing — disk follows work, not the cap');

  const warmed = await wt.prewarm(['fix/ci']);
  assert.ok(warmed !== null && existsSync(warmed), 'a slot is on disk before the dispatch asked for one');
  assert.equal(git(warmed, ['rev-parse', '--abbrev-ref', 'HEAD']), 'fix/ci');

  assert.equal(await wt.prewarm(['fix/ci']), null, 'and a branch that already has a slot is left alone');
});

test('a warmed slot is the one the dispatch gets back, without a handover', async () => {
  const dir = repo();
  const wt = manager(dir, 2);
  git(dir, ['branch', 'fix/ci']);

  const warmed = await wt.prewarm(['fix/ci']);
  assert.equal(await wt.ensure('fix/ci'), warmed, 'ensure hands back the slot already on it');
});

test('warming takes a spare, and never evicts another branch on a guess', async () => {
  const dir = repo();
  const wt = manager(dir, 1);
  git(dir, ['branch', 'fix/ci']);
  git(dir, ['branch', 'other/work']);

  await wt.prewarm(['fix/ci']);
  assert.equal(await wt.prewarm(['other/work']), null, 'the one slot is another branch’s warm tree');
  assert.equal(git(join(dir, '.wt', 'slot-0'), ['rev-parse', '--abbrev-ref', 'HEAD']), 'fix/ci');
});

test('warming never cuts a branch that does not exist, because ensure would ignore the base it wanted', async () => {
  const dir = repo();
  const wt = manager(dir, 1);
  await wt.prewarm([]);

  assert.equal(await wt.prewarm(['issue/9/new-work']), null, 'nothing is warmed for a name with no ref');
  assert.equal(git(dir, ['branch', '--list', 'issue/9/new-work']), '', 'and no branch was cut for it');
});

test('warming takes no lease, so a dispatch for another branch can still take the slot', async () => {
  const dir = repo();
  const wt = manager(dir, 1);
  git(dir, ['branch', 'fix/ci']);
  const warmed = await wt.prewarm(['fix/ci']);

  assert.equal(await wt.ensure('other/work'), warmed, 'the only slot goes to the branch that actually dispatched');
});

test('warming leaves a slot the harness has work in flight on alone', async () => {
  const dir = repo();
  const wt = manager(dir, 1, (branch) => branch === 'fix/ci');
  git(dir, ['branch', 'fix/ci']);

  assert.equal(await wt.prewarm(['fix/ci']), null, 'a held branch is already somebody’s');
  assert.equal(existsSync(join(dir, '.wt', 'slot-0')), false, 'and no slot was minted for it');
});

test('the desk warms the branches the queue named, and only one pass runs at a time', async () => {
  const worktrees = new FakeWorktreeManager();
  const errors = new Recorded();
  const upcoming: QueueItem[] = [
    item('fix/ci'),
    item('fix/ci'),
    item('plan/only', { kind: 'desk', branch: null }),
    item('held/back', { status: 'unapproved' }),
    item('gone', { status: 'superseded' }),
    item('issue/2/work', { status: 'cooldown' }),
  ];
  const desk = new PrewarmDesk({ worktrees, upcoming: () => upcoming, enabled: () => true, errors });

  desk.run();
  desk.run();
  await new Promise((done) => setImmediate(done));

  assert.deepEqual(worktrees.warmed, [['fix/ci', 'issue/2/work']], 'deduped, code-only, and nothing held back');
});

test('the desk does nothing when warming is switched off, and records a failure rather than throwing', async () => {
  const errors = new Recorded();
  const off = new FakeWorktreeManager();
  new PrewarmDesk({ worktrees: off, upcoming: () => [], enabled: () => false, errors }).run();
  assert.deepEqual(off.warmed, []);

  class Refusing extends FakeWorktreeManager {
    override prewarm(): Promise<string | null> {
      return Promise.reject(new Error('EBUSY: slot held open'));
    }
  }
  new PrewarmDesk({ worktrees: new Refusing(), upcoming: () => [], enabled: () => true, errors }).run();
  await new Promise((done) => setImmediate(done));

  assert.match(errors.entries[0]!.message, /Could not warm a worktree slot/);
});
