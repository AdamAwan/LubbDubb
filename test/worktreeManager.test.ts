import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { defaultPoolSize, WorktreeManager } from '../src/worktree/worktreeManager.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { tmpDir } from './support/gitRepo.js';

function initRepo(): string {
  const dir = tmpDir('lubbdubb-repo-');
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir });
  git(['init', '-q', '-b', 'main']);
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

function commitOn(dir: string, branch: string, file: string): void {
  git(dir, ['checkout', '-q', '-B', branch]);
  writeFileSync(join(dir, file), file);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', `add ${file}`]);
}

function manager(repo: string, size = 4, held: (branch: string) => boolean = () => false): WorktreeManager {
  return new WorktreeManager(repo, join(repo, '.wt'), { size, held }, join(repo, '.preview'));
}

function warmable(repo: string, size = 4): WorktreeManager {
  writeFileSync(join(repo, '.gitignore'), 'deps/\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'ignore deps']);
  return manager(repo, size);
}

function install(dir: string, note: string): void {
  mkdirSync(join(dir, 'deps'), { recursive: true });
  writeFileSync(join(dir, 'deps', 'installed.txt'), note);
}

test('creates a new slot on a new branch and reuses it', async () => {
  const repo = initRepo();
  const wt = manager(repo);

  const path1 = await wt.ensure('feature/x');
  assert.ok(path1.endsWith('slot-0'));

  const path2 = await wt.ensure('feature/x');
  assert.equal(path1, path2);

  const existing = await wt.findExisting('feature/x');
  assert.equal(existing, path1);
});

test('checks out an existing branch into a slot', async () => {
  const repo = initRepo();
  execFileSync('git', ['branch', 'existing'], { cwd: repo });
  const wt = manager(repo);
  const dir = await wt.ensure('existing');
  assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'existing');
});

test('a new branch forks from the named base, not from HEAD', async () => {
  const repo = initRepo();
  commitOn(repo, 'trunk', 'trunk.txt');
  const trunkTip = git(repo, ['rev-parse', 'trunk']);
  commitOn(repo, 'someones-feature', 'stray.txt');
  assert.notEqual(git(repo, ['rev-parse', 'HEAD']), trunkTip);

  const wt = manager(repo);
  const dir = await wt.ensure('issue/12/schema', 'trunk');

  assert.equal(git(dir, ['rev-parse', 'HEAD']), trunkTip);
});

test('a base resolves through origin/<base> ahead of the local ref', async () => {
  const repo = initRepo();
  commitOn(repo, 'trunk', 'local.txt');
  const localTip = git(repo, ['rev-parse', 'trunk']);
  commitOn(repo, 'pushed', 'remote.txt');
  const remoteTip = git(repo, ['rev-parse', 'pushed']);
  git(repo, ['update-ref', 'refs/remotes/origin/trunk', remoteTip]);
  git(repo, ['checkout', '-q', 'trunk']);

  const wt = manager(repo);
  const dir = await wt.ensure('issue/12/schema', 'trunk');

  assert.equal(git(dir, ['rev-parse', 'HEAD']), remoteTip);
  assert.notEqual(remoteTip, localTip);
});

test('the base is cut from a commit, so the new branch tracks nothing', async () => {
  const repo = initRepo();
  commitOn(repo, 'trunk', 'trunk.txt');
  git(repo, ['update-ref', 'refs/remotes/origin/trunk', git(repo, ['rev-parse', 'trunk'])]);

  const wt = manager(repo);
  await wt.ensure('issue/12/schema', 'trunk');

  assert.throws(() => git(repo, ['rev-parse', '--abbrev-ref', 'issue/12/schema@{upstream}']));
});

test('reuse comes first: an existing branch keeps its base', async () => {
  const repo = initRepo();
  commitOn(repo, 'trunk', 'trunk.txt');
  const trunkTip = git(repo, ['rev-parse', 'trunk']);
  commitOn(repo, 'issue/12/schema', 'part.txt');
  const branchTip = git(repo, ['rev-parse', 'issue/12/schema']);
  git(repo, ['checkout', '-q', 'trunk']);

  const wt = manager(repo);
  const dir = await wt.ensure('issue/12/schema', 'trunk');

  assert.equal(git(dir, ['rev-parse', 'HEAD']), branchTip);
  assert.notEqual(branchTip, trunkTip);
});

test('reuse comes first: a slot already on the branch is handed back untouched', async () => {
  const repo = initRepo();
  commitOn(repo, 'trunk', 'trunk.txt');
  const wt = manager(repo);

  const first = await wt.ensure('issue/12/schema', 'trunk');
  const tip = git(first, ['rev-parse', 'HEAD']);
  const second = await wt.ensure('issue/12/schema', 'no-such-branch');

  assert.equal(second, first);
  assert.equal(git(second, ['rev-parse', 'HEAD']), tip);
});

test('an unresolvable base fails loudly instead of falling back to HEAD', async () => {
  const repo = initRepo();
  const wt = manager(repo);

  await assert.rejects(() => wt.ensure('issue/12/schema', 'no-such-branch'), /no commit/);
  assert.equal(await wt.findExisting('issue/12/schema'), null);
});

test('an unresolvable base leaves a free slot exactly as it was, not cleaned and half-prepared', async () => {
  const repo = initRepo();
  const wt = manager(repo);
  const dir = await wt.ensure('issue/1');
  writeFileSync(join(dir, 'stray.txt'), 'left by the previous occupant');
  await wt.remove('issue/1');

  await assert.rejects(() => wt.ensure('issue/2', 'no-such-branch'), /no commit/);

  assert.ok(existsSync(join(dir, 'stray.txt')), 'the start point is resolved before anything is touched');
  assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'issue/1');
});

test('an orphaned slot directory is reclaimed instead of shrinking the pool forever', async () => {
  const repo = initRepo();
  commitOn(repo, 'trunk', 'trunk.txt');
  const root = join(repo, '.wt');
  mkdirSync(join(root, 'slot-0'), { recursive: true });
  writeFileSync(join(root, 'slot-0', 'stray.txt'), 'left over');

  const wt = manager(repo);
  const dir = await wt.ensure('issue/35377', 'trunk');

  assert.equal(dir, join(root, 'slot-0'));
  assert.equal(git(dir, ['rev-parse', 'HEAD']), git(repo, ['rev-parse', 'trunk']));
  assert.equal(await wt.findExisting('issue/35377'), dir);
});

test('a de-registered slot is pruned out of the pool rather than counted against its bound', async () => {
  const repo = initRepo();
  const root = join(repo, '.wt');
  const wt = manager(repo);
  const dir = await wt.ensure('issue/35225');
  rmSync(join(repo, '.git', 'worktrees'), { recursive: true, force: true });
  assert.equal(await wt.findExisting('issue/35225'), null);

  await wt.remove('issue/35225');
  assert.equal(await wt.ensure('issue/35225'), dir);
  assert.deepEqual(readdirSync(root), ['slot-0'], 'and no second slot was minted around it');
});

test('a reclaim held up by a live process says so, rather than reporting an errno', async (t) => {
  if (process.platform !== 'win32') return t.skip('EBUSY on a live process cwd is a Windows rule');

  const repo = initRepo();
  const root = join(repo, '.wt');
  const dir = join(root, 'slot-0');
  mkdirSync(dir, { recursive: true });
  const squatter = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dir, stdio: 'ignore' });
  t.after(() => squatter.kill());
  await new Promise((r) => setTimeout(r, 200));

  const wt = manager(repo);
  await assert.rejects(
    () => wt.ensure('issue/35174'),
    (err: Error) => {
      assert.match(err.message, /held open by another process/);
      assert.match(err.message, /retries/, 'and that it was not a moment of contention');
      assert.ok(err.message.includes(dir), 'naming the directory that is stuck');
      return true;
    },
  );
});

test('an omitted base still forks from the repo root HEAD, not from the slot the branch inherits', async () => {
  const repo = initRepo();
  commitOn(repo, 'trunk', 'trunk.txt');
  const wt = manager(repo, 1);

  const first = await wt.ensure('issue/12/schema');
  assert.equal(git(first, ['rev-parse', 'HEAD']), git(repo, ['rev-parse', 'HEAD']));

  writeFileSync(join(first, 'work.txt'), 'work');
  git(first, ['add', '.']);
  git(first, ['commit', '-q', '-m', 'work']);
  await wt.remove('issue/12/schema');

  const second = await wt.ensure('issue/12/api');

  assert.equal(second, first);
  assert.equal(git(second, ['rev-parse', 'HEAD']), git(repo, ['rev-parse', 'HEAD']));
});

test('the same branch coming back gets its tree exactly as it left it', async () => {
  const repo = initRepo();
  const wt = warmable(repo);

  const first = await wt.ensure('issue/1');
  install(first, 'warm');
  writeFileSync(join(first, 'scratch.txt'), 'a stray from the run');
  await wt.remove('issue/1');

  const again = await wt.ensure('issue/1');

  assert.equal(again, first);
  assert.equal(readFileSync(join(again, 'deps', 'installed.txt'), 'utf8'), 'warm', 'the whole point of the pool');
  assert.ok(existsSync(join(again, 'scratch.txt')), 'and nothing is cleaned out from under it either');
});

test('a slot handed to a different branch is wiped, ignored files and all', async () => {
  const repo = initRepo();
  const wt = warmable(repo, 1);

  const first = await wt.ensure('issue/1');
  install(first, 'resolved from issue/1’s lockfile');
  writeFileSync(join(first, 'scratch.txt'), 'a stray from the last goal');
  await wt.remove('issue/1');

  const second = await wt.ensure('issue/2');

  assert.equal(second, first, 'the slot is the pool’s and gets reissued');
  assert.equal(existsSync(join(second, 'deps')), false, 'no ignored state crosses to another branch');
  assert.equal(existsSync(join(second, 'scratch.txt')), false, "and neither do the previous occupant's strays");
  assert.equal(git(second, ['rev-parse', '--abbrev-ref', 'HEAD']), 'issue/2');
});

test('the pool grows before it takes a tree off a branch that still exists', async () => {
  const repo = initRepo();
  const wt = manager(repo, 2);

  const first = await wt.ensure('issue/1');
  await wt.remove('issue/1');
  const second = await wt.ensure('issue/2');

  assert.notEqual(second, first, 'a free slot still on a live branch is not the first choice');
  assert.equal(await wt.ensure('issue/1'), first, 'and issue/1 still has its own tree to come back to');
});

test('a slot whose branch was reaped is taken before the pool grows', async () => {
  const repo = initRepo();
  const wt = manager(repo, 3);

  const first = await wt.ensure('issue/1');
  await wt.remove('issue/1');
  await wt.deleteBranch('issue/1');

  assert.equal(await wt.ensure('issue/2'), first);
});

test('a branch with commits, handed a slot, still has them: the reset form is unreachable', async () => {
  const repo = initRepo();
  commitOn(repo, 'trunk', 'trunk.txt');
  const trunkTip = git(repo, ['rev-parse', 'trunk']);
  const wt = manager(repo, 1);

  const dir = await wt.ensure('issue/12/schema', 'trunk');
  writeFileSync(join(dir, 'part.txt'), 'part');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'part']);
  const partTip = git(dir, ['rev-parse', 'HEAD']);

  await wt.remove('issue/12/schema');
  assert.equal(await wt.ensure('issue/13', 'trunk'), dir);
  await wt.remove('issue/13');

  const back = await wt.ensure('issue/12/schema', 'trunk');

  assert.equal(back, dir);
  assert.equal(git(back, ['rev-parse', 'HEAD']), partTip, 'the commit survives the switch');
  assert.notEqual(partTip, trunkTip);
});

test('a slot leased to a live agent is never handed to a second branch', async () => {
  const repo = initRepo();
  const wt = manager(repo);

  const live = await wt.ensure('issue/1');
  writeFileSync(join(live, 'work-in-progress.txt'), 'unpushed');

  const second = await wt.ensure('issue/2');

  assert.notEqual(second, live);
  assert.equal(git(live, ['rev-parse', '--abbrev-ref', 'HEAD']), 'issue/1');
  assert.ok(existsSync(join(live, 'work-in-progress.txt')), "a live agent's checkout must survive");
});

test('`remove` releases the lease and deletes nothing', async () => {
  const repo = initRepo();
  const wt = manager(repo, 1);
  const first = await wt.ensure('issue/1');

  await wt.remove('issue/1');
  assert.ok(existsSync(first), 'the directory is the warm state — removing it is the bug being fixed');

  assert.equal(await wt.ensure('issue/2'), first, 'and with nowhere else to go the released slot is reissued');
});

test('a released slot still on the branch is handed back to it, warm', async () => {
  const repo = initRepo();
  const wt = manager(repo);
  const first = await wt.ensure('issue/1');
  await wt.remove('issue/1');

  assert.equal(await wt.ensure('issue/1'), first);
});

test('a slot carrying uncommitted tracked changes is never handed to another branch', async () => {
  const repo = initRepo();
  const wt = manager(repo, 2);
  const dir = await wt.ensure('issue/1');
  writeFileSync(join(dir, 'README.md'), '# half-finished\n');
  await wt.remove('issue/1');

  const next = await wt.ensure('issue/2');

  assert.notEqual(next, dir);
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), '# half-finished\n', 'and the work is still there');
});

test('the pool never exceeds its bound, and exhaustion is a refusal that names the slots', async () => {
  const repo = initRepo();
  const root = join(repo, '.wt');
  const wt = manager(repo, 1);
  await wt.ensure('issue/1');

  await assert.rejects(
    () => wt.ensure('issue/2'),
    (err: Error) => {
      assert.match(err.message, /No free worktree slot for branch issue\/2/);
      assert.match(err.message, /work in flight on issue\/1/, 'saying what is holding the one slot there is');
      assert.match(err.message, /live agent cap/, 'and which knob raises the bound');
      return true;
    },
  );
  assert.deepEqual(readdirSync(root), ['slot-0'], 'and nothing was minted past the bound');
});

test('the pool bound defaults to the concurrency cap plus slack', () => {
  assert.equal(defaultPoolSize(3), 5);
  assert.equal(defaultPoolSize(20), 22);
  assert.equal(defaultPoolSize(0), 3, 'a cap of zero still leaves a pool that can be leased from');
});

test('a restart holds the slot of work still outstanding, and releases it once recovery settles', async () => {
  const repo = initRepo();
  const root = join(repo, '.wt');
  const before = new WorktreeManager(repo, root, { size: 2, held: () => false }, join(repo, '.preview'));
  const restored = await before.ensure('issue/1');

  const outstanding = new Set(['issue/1']);
  const after = new WorktreeManager(repo, root, { size: 2, held: (b) => outstanding.has(b) }, join(repo, '.preview'));
  assert.notEqual(await after.ensure('issue/2'), restored, "a restored agent's slot is not reissued under it");

  outstanding.clear();
  const later = new WorktreeManager(repo, root, { size: 2, held: () => false }, join(repo, '.preview'));
  assert.equal(await later.ensure('issue/3'), restored);
});

test('deleteBranch drops the branch ref and keeps the directory, squash-merged or not', async () => {
  const repo = initRepo();
  const wt = manager(repo);

  const dir = await wt.ensure('issue/12');
  writeFileSync(join(dir, 'work.txt'), 'work');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'work']);
  git(repo, ['merge', '-q', '--squash', 'issue/12']);
  git(repo, ['commit', '-q', '-m', 'squashed']);

  await wt.remove('issue/12');
  await wt.deleteBranch('issue/12');

  assert.equal(git(repo, ['branch', '--list', 'issue/12']), '', 'the local branch should be gone');
  assert.ok(existsSync(dir), 'the slot is the pool’s, not the branch’s');
  assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD', 'detached, which is what freed the ref');
  assert.equal(await wt.ensure('issue/13'), dir, 'and it goes straight back into the pool');
});

test('deleteBranch refuses a slot this run still leases, and leaves it exactly as it was', async () => {
  const repo = initRepo();
  const wt = manager(repo, 3);
  const slot = await wt.ensure('issue/12', 'main');

  await assert.rejects(() => wt.deleteBranch('issue/12'), /still held by issue\/12/);

  assert.equal(git(slot, ['rev-parse', '--abbrev-ref', 'HEAD']), 'issue/12', 'the slot is still on the branch');
  assert.notEqual(git(repo, ['branch', '--list', 'issue/12']), '', 'and the ref still exists');
  assert.equal(await wt.ensure('issue/12', 'main'), slot, 'the lease survives the refusal');
});

test('deleteBranch refuses on the durable half of the lease too, with no in-memory lease at all', async () => {
  const repo = initRepo();
  const held = new Set(['issue/12']);
  const wt = manager(repo, 3, (b) => held.has(b));
  const slot = await wt.ensure('issue/12', 'main');
  await wt.remove('issue/12');

  await assert.rejects(() => wt.deleteBranch('issue/12'), /still held by issue\/12/);
  assert.equal(git(slot, ['rev-parse', '--abbrev-ref', 'HEAD']), 'issue/12');

  held.delete('issue/12');
  await wt.deleteBranch('issue/12');
  assert.equal(git(repo, ['branch', '--list', 'issue/12']), '', 'and it reaps once nothing holds it');
});

test('the reuse arm is scoped to the pool: the operator’s own checkout is never leased', async () => {
  const repo = initRepo();
  const wt = manager(repo, 3);
  commitOn(repo, 'issue/12', 'agent.txt');
  writeFileSync(join(repo, 'uncommitted.txt'), 'mine');

  await assert.rejects(() => wt.ensure('issue/12', 'main'), /already checked out at .*not a pool slot/);

  assert.ok(existsSync(join(repo, 'uncommitted.txt')), 'the operator’s working copy is untouched');
  assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'issue/12', 'still on their own branch');
  assert.ok(!existsSync(join(repo, '.wt', 'slot-0')), 'and nothing was minted for it');

  git(repo, ['checkout', '-q', 'main']);
  const dir = await wt.ensure('issue/12', 'main');
  assert.notEqual(dir, repo, 'the repo root is never a slot');
  assert.ok(dir.startsWith(join(repo, '.wt')), 'a directory under the worktree root is');
});

test('deleteBranch refuses the operator’s own checkout by name, and leaves both refs where they are', async () => {
  const repo = initRepo();
  const wt = manager(repo);
  commitOn(repo, 'issue/12', 'agent.txt');
  writeFileSync(join(repo, 'uncommitted.txt'), 'mine');

  await assert.rejects(() => wt.deleteBranch('issue/12'), /own working copy[\s\S]*Switch that checkout/);

  assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'issue/12', 'still on their own branch');
  assert.ok(existsSync(join(repo, 'uncommitted.txt')), 'the operator’s working copy is untouched');
  assert.notEqual(git(repo, ['branch', '--list', 'issue/12']), '', 'and the ref is still there to reap');

  git(repo, ['checkout', '-q', 'main']);
  await wt.deleteBranch('issue/12');
  assert.equal(git(repo, ['branch', '--list', 'issue/12']), '', 'the local branch should be gone');
});

test('deleteBranch on a branch that does not exist is a no-op', async () => {
  const repo = initRepo();
  const wt = manager(repo);
  await wt.deleteBranch('never/existed');
});

test('the fake records what a dispatch asked for and touches no repository', async () => {
  const wt = new FakeWorktreeManager();

  const dir = await wt.ensure('issue/12/schema', 'main');

  assert.deepEqual(wt.ensured, [{ branch: 'issue/12/schema', base: 'main' }]);
  assert.ok(existsSync(dir));
  await wt.ensure('job/j_1');
  assert.deepEqual(wt.ensured[1], { branch: 'job/j_1' });
});

test('the fake is reuse-first, like the real one, and ignores base on reuse', async () => {
  const wt = new FakeWorktreeManager();

  const first = await wt.ensure('issue/12', 'main');
  const second = await wt.ensure('issue/12', 'some/other/base');

  assert.equal(second, first);
  assert.equal(wt.ensured.length, 2);
});

test('the fake leases slots too: a live branch keeps its directory, a released one gives it up', async () => {
  const wt = new FakeWorktreeManager(undefined, 2);

  const live = await wt.ensure('issue/12', 'main');
  const other = await wt.ensure('issue/13', 'main');
  assert.notEqual(other, live);

  await wt.remove('issue/12');
  await wt.remove('never/existed');
  assert.ok(existsSync(live), 'and it deletes nothing — the directory is the warm state');
  assert.deepEqual(wt.removed, ['issue/12', 'never/existed']);

  assert.equal(await wt.ensure('issue/12'), live);
  await wt.remove('issue/12');
  assert.equal(await wt.ensure('issue/14'), live, 'and with the pool at its bound another branch evicts it');
});

test('the fake grows the pool before evicting, and takes a reaped slot before either', async () => {
  const wt = new FakeWorktreeManager(undefined, 4);

  const first = await wt.ensure('issue/12');
  await wt.remove('issue/12');

  assert.notEqual(await wt.ensure('issue/13'), first);
  await wt.deleteBranch('issue/12');
  assert.equal(await wt.ensure('issue/14'), first);
});

test('the fake refuses past its bound, as the real one does', async () => {
  const wt = new FakeWorktreeManager(undefined, 1);

  await wt.ensure('issue/12');

  await assert.rejects(() => wt.ensure('issue/13'), /No free worktree slot for branch issue\/13/);
});

test('every test that builds a System either fakes worktrees or brings its own repo', async () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.test.ts'));

  const offenders = files.filter((f) => {
    const source = readFileSync(join(dir, f), 'utf8');
    if (!source.includes('buildSystem(')) return false;
    return !source.includes('FakeWorktreeManager') && !source.includes('repoRoot');
  });

  assert.deepEqual(offenders, []);
});
