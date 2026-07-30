import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeManager } from '../src/worktree/worktreeManager.js';

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-repo-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
  return dir;
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

/** Commit a file on `branch`, creating it, and leave the repo checked out there. */
function commitOn(dir: string, branch: string, file: string): void {
  git(dir, ['checkout', '-q', '-B', branch]);
  writeFileSync(join(dir, file), file);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', `add ${file}`]);
}

test('creates a new worktree on a new branch and reuses it', async () => {
  const repo = initRepo();
  const wt = new WorktreeManager(repo, join(repo, '.wt'));

  const path1 = await wt.ensure('feature/x');
  assert.ok(path1.includes('feature-x'));

  // Reused, not recreated.
  const path2 = await wt.ensure('feature/x');
  assert.equal(path1, path2);

  const existing = await wt.findExisting('feature/x');
  assert.equal(existing, path1);
});

test('checks out an existing branch into a worktree', async () => {
  const repo = initRepo();
  execFileSync('git', ['branch', 'existing'], { cwd: repo });
  const wt = new WorktreeManager(repo, join(repo, '.wt'));
  const path = await wt.ensure('existing');
  assert.ok(path.includes('existing'));
});

test('a new branch forks from the named base, not from HEAD', async () => {
  const repo = initRepo();
  commitOn(repo, 'trunk', 'trunk.txt');
  const trunkTip = git(repo, ['rev-parse', 'trunk']);
  // Leave the repo root sitting somewhere else entirely — the incidental base
  // that made every agent branch fork off whatever was checked out.
  commitOn(repo, 'someones-feature', 'stray.txt');
  assert.notEqual(git(repo, ['rev-parse', 'HEAD']), trunkTip);

  const wt = new WorktreeManager(repo, join(repo, '.wt'));
  const dir = await wt.ensure('issue/12/schema', 'trunk');

  assert.equal(git(dir, ['rev-parse', 'HEAD']), trunkTip);
});

test('a base resolves through origin/<base> ahead of the local ref', async () => {
  const repo = initRepo();
  commitOn(repo, 'trunk', 'local.txt');
  const localTip = git(repo, ['rev-parse', 'trunk']);
  commitOn(repo, 'pushed', 'remote.txt');
  const remoteTip = git(repo, ['rev-parse', 'pushed']);
  // A server-side clone never checks trunk out, so its local ref goes stale while
  // the remote-tracking one moves. The remote is the one that should win.
  git(repo, ['update-ref', 'refs/remotes/origin/trunk', remoteTip]);
  git(repo, ['checkout', '-q', 'trunk']);

  const wt = new WorktreeManager(repo, join(repo, '.wt'));
  const dir = await wt.ensure('issue/12/schema', 'trunk');

  assert.equal(git(dir, ['rev-parse', 'HEAD']), remoteTip);
  assert.notEqual(remoteTip, localTip);
});

test('the base is cut from a commit, so the new branch tracks nothing', async () => {
  const repo = initRepo();
  commitOn(repo, 'trunk', 'trunk.txt');
  git(repo, ['update-ref', 'refs/remotes/origin/trunk', git(repo, ['rev-parse', 'trunk'])]);

  const wt = new WorktreeManager(repo, join(repo, '.wt'));
  await wt.ensure('issue/12/schema', 'trunk');

  // An upstream of origin/trunk would aim a later bare `git push` at the base.
  assert.throws(() => git(repo, ['rev-parse', '--abbrev-ref', 'issue/12/schema@{upstream}']));
});

test('reuse comes first: an existing branch keeps its base', async () => {
  const repo = initRepo();
  commitOn(repo, 'trunk', 'trunk.txt');
  const trunkTip = git(repo, ['rev-parse', 'trunk']);
  commitOn(repo, 'issue/12/schema', 'part.txt');
  const branchTip = git(repo, ['rev-parse', 'issue/12/schema']);
  git(repo, ['checkout', '-q', 'trunk']);

  const wt = new WorktreeManager(repo, join(repo, '.wt'));
  const dir = await wt.ensure('issue/12/schema', 'trunk');

  // Not re-based onto trunk — an in-flight agent's branch is left alone.
  assert.equal(git(dir, ['rev-parse', 'HEAD']), branchTip);
  assert.notEqual(branchTip, trunkTip);
});

test('reuse comes first: an existing worktree is handed back untouched', async () => {
  const repo = initRepo();
  commitOn(repo, 'trunk', 'trunk.txt');
  const wt = new WorktreeManager(repo, join(repo, '.wt'));

  const first = await wt.ensure('issue/12/schema', 'trunk');
  const tip = git(first, ['rev-parse', 'HEAD']);
  // A base that names nothing would throw if it were consulted at all.
  const second = await wt.ensure('issue/12/schema', 'no-such-branch');

  assert.equal(second, first);
  assert.equal(git(second, ['rev-parse', 'HEAD']), tip);
});

test('an unresolvable base fails loudly instead of falling back to HEAD', async () => {
  const repo = initRepo();
  const wt = new WorktreeManager(repo, join(repo, '.wt'));

  await assert.rejects(() => wt.ensure('issue/12/schema', 'no-such-branch'), /no commit/);
  assert.equal(await wt.findExisting('issue/12/schema'), null);
});

test('an orphaned worktree directory is reclaimed instead of wedging the branch forever', async () => {
  const repo = initRepo();
  commitOn(repo, 'trunk', 'trunk.txt');
  const root = join(repo, '.wt');
  // What an interrupted agent leaves behind: the admin entry is gone while the
  // folder is still on disk, so `git worktree list` cannot see it and
  // `git worktree add` refuses the path — every retry, forever.
  mkdirSync(join(root, 'issue-35377'), { recursive: true });
  writeFileSync(join(root, 'issue-35377', 'stray.txt'), 'left over');

  const wt = new WorktreeManager(repo, root);
  const dir = await wt.ensure('issue/35377', 'trunk');

  assert.equal(dir, join(root, 'issue-35377'));
  assert.equal(git(dir, ['rev-parse', 'HEAD']), git(repo, ['rev-parse', 'trunk']));
  assert.equal(await wt.findExisting('issue/35377'), dir);
});

test('a de-registered worktree whose branch still exists is reclaimed too', async () => {
  const repo = initRepo();
  const root = join(repo, '.wt');
  const wt = new WorktreeManager(repo, root);
  const dir = await wt.ensure('issue/35225');
  // Exactly the observed damage: the .git/worktrees admin entry went, the
  // checkout did not. `git worktree prune` is for the opposite case.
  rmSync(join(repo, '.git', 'worktrees'), { recursive: true, force: true });
  assert.equal(await wt.findExisting('issue/35225'), null);

  assert.equal(await wt.ensure('issue/35225'), dir);
});

test('a registered worktree standing on the target path is never reclaimed', async () => {
  const repo = initRepo();
  const root = join(repo, '.wt');
  const wt = new WorktreeManager(repo, root);
  // `sanitize` maps both branches onto one directory, so a live agent's checkout
  // is what stands where the second one wants to go. Reclaiming it would yank a
  // running agent's work; failing loudly is the only honest answer.
  const live = await wt.ensure('feature/x');
  writeFileSync(join(live, 'work-in-progress.txt'), 'unpushed');

  await assert.rejects(() => wt.ensure('feature-x'), /already exists/);
  assert.ok(existsSync(join(live, 'work-in-progress.txt')), "a live agent's checkout must survive");
  assert.equal(await wt.findExisting('feature/x'), live);
});

test('an omitted base still forks from HEAD', async () => {
  const repo = initRepo();
  commitOn(repo, 'trunk', 'trunk.txt');
  const wt = new WorktreeManager(repo, join(repo, '.wt'));

  const dir = await wt.ensure('issue/12/schema');

  assert.equal(git(dir, ['rev-parse', 'HEAD']), git(repo, ['rev-parse', 'HEAD']));
});
