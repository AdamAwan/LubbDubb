import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ErrorLogEntry, ErrorLogInput } from '../src/types.js';
import { loadConfig } from '../src/config/config.js';
import { RuntimeControl } from '../src/runtimeControl.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { defaultPoolSize, WorktreeManager } from '../src/worktree/worktreeManager.js';
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

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

function salvageRefs(repo: string): string[] {
  return git(repo, ['for-each-ref', '--format=%(refname)', 'refs/lubbdubb/salvage'])
    .split('\n')
    .filter((line) => line !== '');
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

function strand(dir: string): void {
  writeFileSync(join(dir, 'README.md'), '# half-finished\n');
  writeFileSync(join(dir, 'new.ts'), 'export const x = 1;\n');
  mkdirSync(join(dir, 'deps'), { recursive: true });
  writeFileSync(join(dir, 'deps', 'installed.txt'), 'a 13 GB dependency tree, in miniature');
}

function manager(repo: string, size: number, errors?: ReturnType<typeof recorder>): WorktreeManager {
  return new WorktreeManager(repo, join(repo, '.wt'), { size, held: () => false }, join(repo, '.preview'), errors);
}

test('the pool bound follows the live cap, not the cap the harness booted with', async () => {
  const repo = initRepo();
  const root = join(repo, '.wt');
  const control = new RuntimeControl(1, false);
  const wt = new WorktreeManager(
    repo,
    root,
    {
      get size() {
        return defaultPoolSize(control.cap);
      },
      held: () => false,
    },
    join(repo, '.preview'),
    recorder(),
  );

  for (const n of [1, 2, 3]) await wt.ensure(`issue/${n}`, 'main');
  await assert.rejects(() => wt.ensure('issue/4', 'main'), /all 3 slots/, 'three is the bound a cap of one gives');

  control.apply({ cap: 5 });

  const grown = await wt.ensure('issue/4', 'main');
  assert.ok(grown.endsWith('slot-3'), 'the pool grew rather than rejecting');
  assert.deepEqual(
    readdirSync(root).sort(),
    ['slot-0', 'slot-1', 'slot-2', 'slot-3'],
    'and grew lazily: a raised ceiling mints nothing until a dispatch needs it',
  );
});

test('the bound is the live cap through the composition root', async () => {
  const dir = tmpDir();
  const base = {
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw' as const,
    deskRoot: join(dir, 'desk'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 1,
  };
  const derived = buildSystem(loadConfig({ ...base, repoRoot: initRepo(), worktreeRoot: join(dir, 'a') }), {
    backend: new FakePtyBackend(),
  });
  for (const n of [1, 2, 3]) await derived.worktrees.ensure(`issue/${n}`, 'main');
  await assert.rejects(() => derived.worktrees.ensure('issue/4', 'main'));
  derived.runtimeControl.apply({ cap: 5 });
  assert.ok(await derived.worktrees.ensure('issue/4', 'main'), 'the cap the cockpit raised raised the pool too');

  derived.runtimeControl.apply({ cap: 1 });
  await assert.rejects(() => derived.worktrees.ensure('issue/5', 'main'), /all 3 slots/);
});

test('a slot stranded by uncommitted work is reclaimed, and the work is not lost', async () => {
  const repo = initRepo();
  const errors = recorder();
  const wt = manager(repo, 1, errors);

  const dir = await wt.ensure('issue/1', 'main');
  strand(dir);
  await wt.remove('issue/1');

  const next = await wt.ensure('issue/2', 'main');
  assert.equal(next, dir, 'the stranded slot came back to the pool');
  assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'issue/2');

  const refs = salvageRefs(repo);
  assert.equal(refs.length, 1, 'and its work went onto a ref of its own');
  assert.ok(refs[0]?.startsWith('refs/lubbdubb/salvage/slot-0/'), refs[0]);

  const check = join(repo, 'recovered');
  git(repo, ['worktree', 'add', '-q', '--detach', check, 'issue/1']);
  git(check, ['stash', 'apply', refs[0]!]);
  assert.equal(readFileSync(join(check, 'README.md'), 'utf8'), '# half-finished\n', 'the tracked edit');
  assert.equal(readFileSync(join(check, 'new.ts'), 'utf8'), 'export const x = 1;\n', 'and the untracked new file');
  assert.ok(!existsSync(join(check, 'deps')), 'but not the ignored dependency tree, which is not git objects');

  const note = errors.entries.find((e) => e.message.includes('Reclaimed worktree slot'));
  assert.ok(note, 'a reclaim that runs invisibly is the same silent failure as the bug');
  assert.match(note.message, /git stash apply refs\/lubbdubb\/salvage/, 'and says where the work went');
});

test('a stranded slot on a detached HEAD is reclaimed too — there is no branch to commit onto', async () => {
  const repo = initRepo();
  const wt = manager(repo, 1, recorder());

  const dir = await wt.ensureReadOnly('appraisal/issue/1', 'main');
  assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD');
  strand(dir);
  await wt.remove('appraisal/issue/1');

  assert.equal(await wt.ensure('issue/2', 'main'), dir);
  assert.equal(salvageRefs(repo).length, 1, 'the stash takes whatever HEAD is, named or not');
});

test('a slot somebody still holds is never reclaimed, however dirty it is', async () => {
  const repo = initRepo();
  const wt = manager(repo, 1, recorder());
  const dir = await wt.ensure('issue/1', 'main');
  strand(dir);

  await assert.rejects(() => wt.ensure('issue/2', 'main'), /work in flight on issue\/1/);
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), '# half-finished\n', 'untouched');
  assert.deepEqual(salvageRefs(repo), [], 'and nothing reached past the lease to stash it');
});

test('nothing is stashed while the pool has a slot to give', async () => {
  const repo = initRepo();
  const wt = manager(repo, 2, recorder());
  const stranded = await wt.ensure('issue/1', 'main');
  strand(stranded);
  await wt.remove('issue/1');

  const next = await wt.ensure('issue/2', 'main');
  assert.notEqual(next, stranded);
  assert.deepEqual(salvageRefs(repo), []);
  assert.equal(readFileSync(join(stranded, 'README.md'), 'utf8'), '# half-finished\n');
});

test('a refusal names the directories under the root that git has forgotten', async () => {
  const repo = initRepo();
  const root = join(repo, '.wt');
  const wt = manager(repo, 1, recorder());
  await wt.ensure('issue/1', 'main');

  const dead = join(root, 'issue-35704');
  mkdirSync(dead, { recursive: true });
  writeFileSync(join(dead, 'stale.txt'), 'a dead checkout');

  await assert.rejects(
    () => wt.ensure('issue/2', 'main'),
    (err: Error) => {
      assert.match(err.message, /git no longer knows about/);
      assert.match(err.message, /issue-35704/, 'named, since nothing else in the harness can see them');
      return true;
    },
  );
  assert.ok(existsSync(dead), 'and left alone: an unguarded delete under a mistyped root is unrecoverable');
});
