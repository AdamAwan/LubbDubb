import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { defaultPoolSize, WorktreeManager } from '../src/worktree/worktreeManager.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

/**
 * A throwaway repository, because everything in this file is git behaviour and
 * `config.repoRoot` defaults to `process.cwd()` — the exception `CLAUDE.md` names.
 * `main` is explicit so a `base` of `"main"` resolves whatever the host's
 * `init.defaultBranch` happens to be.
 */
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-repo-'));
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

/** Commit a file on `branch`, creating it, and leave the repo checked out there. */
function commitOn(dir: string, branch: string, file: string): void {
  git(dir, ['checkout', '-q', '-B', branch]);
  writeFileSync(join(dir, file), file);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', `add ${file}`]);
}

/** A manager over `repo` with nothing in flight anywhere — the plain test posture. */
function manager(repo: string, size = 4, held: (branch: string) => boolean = () => false): WorktreeManager {
  return new WorktreeManager(repo, join(repo, '.wt'), { size, held }, join(repo, '.preview'));
}

/**
 * A manager over a repo that ignores `deps/` — the dependency tree in miniature,
 * and the only thing the warm-versus-wiped distinction can be observed through.
 */
function warmable(repo: string, size = 4): WorktreeManager {
  writeFileSync(join(repo, '.gitignore'), 'deps/\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'ignore deps']);
  return manager(repo, size);
}

/** The warm state a dispatch leaves behind: an installed dependency tree, ignored. */
function install(dir: string, note: string): void {
  mkdirSync(join(dir, 'deps'), { recursive: true });
  writeFileSync(join(dir, 'deps', 'installed.txt'), note);
}

test('creates a new slot on a new branch and reuses it', async () => {
  const repo = initRepo();
  const wt = manager(repo);

  const path1 = await wt.ensure('feature/x');
  // The directory is a *slot*, not the branch: naming it after what it holds is
  // exactly the coupling the pool exists to break.
  assert.ok(path1.endsWith('slot-0'));

  // Reused, not recreated.
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
  // Leave the repo root sitting somewhere else entirely — the incidental base
  // that made every agent branch fork off whatever was checked out.
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
  // A server-side clone never checks trunk out, so its local ref goes stale while
  // the remote-tracking one moves. The remote is the one that should win.
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

  const wt = manager(repo);
  const dir = await wt.ensure('issue/12/schema', 'trunk');

  // Not re-based onto trunk — an in-flight agent's branch is left alone.
  assert.equal(git(dir, ['rev-parse', 'HEAD']), branchTip);
  assert.notEqual(branchTip, trunkTip);
});

test('reuse comes first: a slot already on the branch is handed back untouched', async () => {
  const repo = initRepo();
  commitOn(repo, 'trunk', 'trunk.txt');
  const wt = manager(repo);

  const first = await wt.ensure('issue/12/schema', 'trunk');
  const tip = git(first, ['rev-parse', 'HEAD']);
  // A base that names nothing would throw if it were consulted at all.
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
  // What an interrupted agent leaves behind: the admin entry is gone while the
  // folder is still on disk, so `git worktree list` cannot see it and
  // `git worktree add` refuses the path — every retry, forever.
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
  // Exactly the observed damage: the .git/worktrees admin entry went, the
  // checkout did not.
  rmSync(join(repo, '.git', 'worktrees'), { recursive: true, force: true });
  assert.equal(await wt.findExisting('issue/35225'), null);

  await wt.remove('issue/35225');
  assert.equal(await wt.ensure('issue/35225'), dir);
  assert.deepEqual(readdirSync(root), ['slot-0'], 'and no second slot was minted around it');
});

test('a reclaim held up by a live process says so, rather than reporting an errno', async (t) => {
  // Windows only, and not as a convenience: the failure *is* a Windows rule — a
  // directory that is a live process's cwd cannot be removed. POSIX allows it, so
  // there is nothing here to reproduce, and a skip is the honest result.
  if (process.platform !== 'win32') return t.skip('EBUSY on a live process cwd is a Windows rule');

  const repo = initRepo();
  const root = join(repo, '.wt');
  const dir = join(root, 'slot-0');
  mkdirSync(dir, { recursive: true });
  // The two-day wedge, reproduced: an agent's task was interrupted, its process
  // died, and the shell it had started with the Bash tool survived with its cwd
  // still inside the worktree.
  const squatter = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dir, stdio: 'ignore' });
  t.after(() => squatter.kill());
  await new Promise((r) => setTimeout(r, 200)); // let it actually be running in there

  const wt = manager(repo);
  await assert.rejects(
    () => wt.ensure('issue/35174'),
    (err: Error) => {
      // What the operator needs is the *cause*, because their next move is to go
      // find that process. `EBUSY: resource busy or locked, rmdir '<dir>'` is a
      // true statement of the syscall and a dead end as a report.
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

  // The pooled half of the same rule: the slot's own HEAD is now the *previous*
  // occupant's, and forking implicitly off it would silently mis-base the branch.
  writeFileSync(join(first, 'work.txt'), 'work');
  git(first, ['add', '.']);
  git(first, ['commit', '-q', '-m', 'work']);
  await wt.remove('issue/12/schema');

  const second = await wt.ensure('issue/12/api');

  assert.equal(second, first);
  assert.equal(git(second, ['rev-parse', 'HEAD']), git(repo, ['rev-parse', 'HEAD']));
});

// ---------------------------------------------------------------------------
// The pool: the lease, the warm state, and the bound.
// ---------------------------------------------------------------------------

test('the same branch coming back gets its tree exactly as it left it', async () => {
  const repo = initRepo();
  const wt = warmable(repo);

  const first = await wt.ensure('issue/1');
  // Ignored, and the whole reason the pool exists — a dispatch that has to rebuild
  // it pays minutes for nothing.
  install(first, 'warm');
  writeFileSync(join(first, 'scratch.txt'), 'a stray from the run');
  await wt.remove('issue/1');

  // What a CI failure or a review comment on that branch dispatches into.
  const again = await wt.ensure('issue/1');

  assert.equal(again, first);
  assert.equal(readFileSync(join(again, 'deps', 'installed.txt'), 'utf8'), 'warm', 'the whole point of the pool');
  assert.ok(existsSync(join(again, 'scratch.txt')), 'and nothing is cleaned out from under it either');
});

test('a slot handed to a different branch is wiped, ignored files and all', async () => {
  const repo = initRepo();
  // A bound of one, so the slot has nowhere else to go — the pool would otherwise
  // mint rather than take a tree the previous branch may still want.
  const wt = warmable(repo, 1);

  const first = await wt.ensure('issue/1');
  install(first, 'resolved from issue/1’s lockfile');
  writeFileSync(join(first, 'scratch.txt'), 'a stray from the last goal');
  await wt.remove('issue/1');

  const second = await wt.ensure('issue/2');

  assert.equal(second, first, 'the slot is the pool’s and gets reissued');
  // The bug this rule exists for: an agent reading a `dist/` its branch never built
  // as its own output, with nothing anywhere marking it stale.
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

  // Handing over wipes, so evicting a live branch early costs its warm tree and
  // buys nothing — the branch it belongs to is exactly what comes back from CI.
  assert.notEqual(second, first, 'a free slot still on a live branch is not the first choice');
  assert.equal(await wt.ensure('issue/1'), first, 'and issue/1 still has its own tree to come back to');
});

test('a slot whose branch was reaped is taken before the pool grows', async () => {
  const repo = initRepo();
  const wt = manager(repo, 3);

  const first = await wt.ensure('issue/1');
  await wt.deleteBranch('issue/1');

  // Detached by the reap: nothing is coming back for it, so it is the slot to take
  // rather than one more directory on disk.
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

  // The slot goes to something else and then comes back — a re-dispatch, a retry,
  // a part picked up again. `git switch -C` / `checkout -B` would *reset* the
  // branch to the start point here and discard that commit, with nothing red.
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

  // The property one directory per branch used to provide for free, and the one
  // pooling has to state: two agents in one tree on different branches is worse
  // than anything `fileOverlap` reports.
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
  // What a failed or killed agent leaves: an edit to a tracked file, uncommitted.
  // `git switch` would carry it across onto the next branch, where a later agent
  // would commit work it has no idea the origin of.
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
  // Derived rather than a flat default, so raising the cap does not silently start
  // rejecting dispatches for want of a directory.
  assert.equal(defaultPoolSize(3), 5);
  assert.equal(defaultPoolSize(20), 22);
  assert.equal(defaultPoolSize(0), 3, 'a cap of zero still leaves a pool that can be leased from');
});

test('a restart holds the slot of work still outstanding, and releases it once recovery settles', async () => {
  const repo = initRepo();
  const root = join(repo, '.wt');
  const before = new WorktreeManager(repo, root, { size: 2, held: () => false }, join(repo, '.preview'));
  const restored = await before.ensure('issue/1');

  // The restart. A fresh manager's in-memory leases are empty by construction, so
  // what is left is the branch the slot is checked out on and whether the harness
  // still has work in flight on it — which a restored orphan does.
  const outstanding = new Set(['issue/1']);
  const after = new WorktreeManager(repo, root, { size: 2, held: (b) => outstanding.has(b) }, join(repo, '.preview'));
  assert.notEqual(await after.ensure('issue/2'), restored, "a restored agent's slot is not reissued under it");

  // `requeue` and `remove` settle the task, and that is the boot release: nothing
  // in the manager had to remember anything for it to happen.
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
  // Landed the way `merge_pr` lands things: squashed, so the branch has *no*
  // ancestry link to main. `git branch -d` refuses on exactly this, which is why
  // the reap uses -D — with -d it would silently never delete anything.
  git(repo, ['merge', '-q', '--squash', 'issue/12']);
  git(repo, ['commit', '-q', '-m', 'squashed']);

  await wt.deleteBranch('issue/12');

  assert.equal(git(repo, ['branch', '--list', 'issue/12']), '', 'the local branch should be gone');
  assert.ok(existsSync(dir), 'the slot is the pool’s, not the branch’s');
  assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD', 'detached, which is what freed the ref');
  assert.equal(await wt.ensure('issue/13'), dir, 'and it goes straight back into the pool');
});

test('deleteBranch on a branch that does not exist is a no-op', async () => {
  const repo = initRepo();
  const wt = manager(repo);
  await wt.deleteBranch('never/existed');
});

// ---------------------------------------------------------------------------
// The fake, and the reason it exists.
// ---------------------------------------------------------------------------

test('the fake records what a dispatch asked for and touches no repository', async () => {
  const wt = new FakeWorktreeManager();

  const dir = await wt.ensure('issue/12/schema', 'main');

  assert.deepEqual(wt.ensured, [{ branch: 'issue/12/schema', base: 'main' }]);
  // A real directory, not a synthetic path: an agent's worktree is its cwd, and
  // the file-events spool and the artifact route (which `realpath`s the root
  // before serving) genuinely touch it.
  assert.ok(existsSync(dir));
  // No `base` at all is a distinct thing to have asked — the real manager forks
  // from HEAD there rather than resolving anything.
  await wt.ensure('job/j_1');
  assert.deepEqual(wt.ensured[1], { branch: 'job/j_1' });
});

test('the fake is reuse-first, like the real one, and ignores base on reuse', async () => {
  const wt = new FakeWorktreeManager();

  const first = await wt.ensure('issue/12', 'main');
  const second = await wt.ensure('issue/12', 'some/other/base');

  // Reuse-first is load-bearing in production — `Store.findActiveTaskByBranch`
  // exists because of it — so a fake minting a fresh path per call would let a
  // test assert behaviour the real manager does not have.
  assert.equal(second, first);
  assert.equal(wt.ensured.length, 2);
});

test('the fake leases slots too: a live branch keeps its directory, a released one gives it up', async () => {
  const wt = new FakeWorktreeManager(undefined, 2);

  const live = await wt.ensure('issue/12', 'main');
  const other = await wt.ensure('issue/13', 'main');
  // A fake still keyed on the branch would hand every branch its own path and keep
  // every test green while the real manager started leasing slots.
  assert.notEqual(other, live);

  await wt.remove('issue/12');
  await wt.remove('never/existed');
  assert.ok(existsSync(live), 'and it deletes nothing — the directory is the warm state');
  assert.deepEqual(wt.removed, ['issue/12', 'never/existed']);

  // Released, and still on its old occupant, so that branch gets it straight back.
  assert.equal(await wt.ensure('issue/12'), live);
  await wt.remove('issue/12');
  assert.equal(await wt.ensure('issue/14'), live, 'and with the pool at its bound another branch evicts it');
});

test('the fake grows the pool before evicting, and takes a reaped slot before either', async () => {
  const wt = new FakeWorktreeManager(undefined, 4);

  const first = await wt.ensure('issue/12');
  await wt.remove('issue/12');

  // The real manager's order, which is load-bearing now that a hand-over wipes the
  // tree: a slot still standing on a branch is the last thing taken, and one whose
  // branch was reaped is the first.
  assert.notEqual(await wt.ensure('issue/13'), first);
  await wt.deleteBranch('issue/12');
  assert.equal(await wt.ensure('issue/14'), first);
});

test('the fake refuses past its bound, as the real one does', async () => {
  const wt = new FakeWorktreeManager(undefined, 1);

  await wt.ensure('issue/12');

  await assert.rejects(() => wt.ensure('issue/13'), /No free worktree slot for branch issue\/13/);
});

/**
 * The regression guard for what the seam is *for*. `config.repoRoot` defaults to
 * `process.cwd()`, so a test that dispatches a code agent without injecting the
 * fake cuts a real branch in whichever checkout the suite is running in and never
 * deletes it — and on a CI `pull_request` checkout, which is a detached HEAD with
 * no `main` and no `origin/main`, `ensure` throws instead and the dispatch is
 * audited as rejected, so the test fails on an empty agent list rather than on
 * anything it was written to assert.
 *
 * Either answer is fine — inject the fake, or point `repoRoot` at a throwaway
 * repository from `test/support/gitRepo.ts`. Naming neither is the bug.
 */
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
