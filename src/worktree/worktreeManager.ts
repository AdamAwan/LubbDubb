import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { runGit, resolveCommit } from '../git/gitCli.js';
import { branchDirName } from './branchDir.js';

/**
 * Git's *write* side, as the one seam the executor depends on. Its read side has
 * had {@link GitObserver} and a fake since plan reconciliation needed one; this
 * half — the half that mutates the repo — had neither, so every test that
 * dispatched a code agent cut a real branch in whatever checkout `repoRoot`
 * happened to name (`process.cwd()` by default) and never deleted it.
 *
 * Deliberately two methods: `ensure`/`remove` is the whole of what
 * {@link ActionExecutor} and the reap in `system.ts` ask for, and a seam wider
 * than its consumer is a fake with behaviour nobody checks.
 */
export interface Worktrees {
  /** Path to a worktree for `branch`, creating it if needed. */
  ensure(branch: string, base?: string): Promise<string>;
  /** Drop the worktree for `branch` if one exists; a no-op otherwise. */
  remove(branch: string): Promise<void>;
  /**
   * Drop the worktree *and* the local branch ref — the local half of the reap after
   * a pull request merges. A branch that does not exist locally is a no-op.
   */
  deleteBranch(branch: string): Promise<void>;
}

/**
 * Creates git worktrees lazily — only when a code task needs one — keyed by
 * branch and reused if a worktree for that branch already exists. Desk tasks
 * never call this. Keeping worktrees per-branch means two tasks on the same
 * branch share a checkout instead of fighting over it.
 */
export class WorktreeManager implements Worktrees {
  constructor(
    private readonly repoRoot: string,
    private readonly worktreeRoot: string,
  ) {}

  /**
   * Return the path to a worktree for `branch`, creating it if needed. A *new*
   * branch is cut from `base` (resolved by {@link resolveCommit}, so
   * `origin/<base>` wins over the local ref); omitting `base` forks it from the
   * repo root's HEAD, which is whatever that checkout happens to be sitting on.
   *
   * **Reuse comes first, and `base` is then ignored entirely** — an existing
   * worktree, or an existing local branch, is handed back as-is. That is
   * deliberate (you don't move an in-flight agent's branch out from under it),
   * but it means `ensure(branch, base)` does *not* guarantee the branch is based
   * on `base`; it only decides where a branch that didn't exist starts.
   *
   * A `base` that resolves to nothing throws rather than quietly falling back to
   * HEAD: silently picking an incidental base is the bug this parameter exists to
   * fix. The executor records the failure as a rejected dispatch.
   */
  async ensure(branch: string, base?: string): Promise<string> {
    const existing = await this.findExisting(branch);
    if (existing) return existing;

    const dir = resolve(this.worktreeRoot, branchDirName(branch));
    mkdirSync(this.worktreeRoot, { recursive: true });
    await this.reclaim(dir);

    if (await this.branchExists(branch)) {
      await this.git(['worktree', 'add', dir, branch]);
      return dir;
    }
    if (base === undefined) {
      await this.git(['worktree', 'add', '-b', branch, dir]);
      return dir;
    }
    const startPoint = await resolveCommit(this.repoRoot, base);
    if (!startPoint) {
      throw new Error(`Cannot create branch ${branch}: base '${base}' resolves to no commit in ${this.repoRoot}.`);
    }
    await this.git(['worktree', 'add', '-b', branch, dir, startPoint]);
    return dir;
  }

  /** Path of an existing worktree for the branch, or null. */
  async findExisting(branch: string): Promise<string | null> {
    const entries = await this.registered();
    const match = entries.find((e) => e.branch === branch || e.branch === `refs/heads/${branch}`);
    if (match && existsSync(match.path)) return match.path;
    return null;
  }

  async remove(branch: string): Promise<void> {
    const dir = await this.findExisting(branch);
    if (!dir) return;
    await this.git(['worktree', 'remove', '--force', dir]);
  }

  /**
   * Drop the worktree and then the branch ref itself, for a branch whose pull
   * request has merged.
   *
   * **`-D`, not `-d`.** `merge_pr` squashes, and a squash-merged branch has no
   * ancestry link to the base it landed in — so `-d`'s "is this merged" test says no
   * for every branch this is ever called on, and the reap would silently never
   * delete anything. The safety `-d` offers is already provided by the caller, which
   * only asks for branches the provider says are merged.
   *
   * A branch that is not there is a no-op rather than a failure: the reap's question
   * is whether the ref is gone, and both answers satisfy it.
   */
  async deleteBranch(branch: string): Promise<void> {
    await this.remove(branch);
    if (!(await this.branchExists(branch))) return;
    await this.git(['branch', '-D', branch]);
  }

  /**
   * Free a target path that a *dead* checkout is squatting on. An interrupted or
   * killed agent can leave its worktree de-registered-but-present — the
   * `.git/worktrees/<name>` admin entry gone, the folder still on disk — which
   * `findExisting` cannot see (it reads the porcelain list) and
   * `git worktree add` then refuses with `fatal: '<dir>' already exists`. Since
   * the path is deterministic, every retry hits the same wall: the branch is
   * wedged for good and the issue never gets an agent.
   *
   * `git worktree prune` does *not* cover it — prune is the mirror case, an
   * admin entry whose directory vanished — so it runs first only to clear that
   * cruft cheaply before the porcelain list is read.
   *
   * **Registered is untouchable.** The guard is the porcelain list, not the
   * presence of a `.git` file: a directory git still knows about is some agent's
   * live checkout, and yanking it mid-run is far worse than the collision. When
   * one stands here (two branches can sanitize onto one directory) the `add`
   * below fails loudly, which is the honest answer.
   *
   * Reclaiming discards whatever the dead orphan still held. That is acceptable:
   * with no admin entry there is no branch or commit behind those files and no
   * workflow that could recover them — they are unreachable either way.
   *
   * **A lock is transient; `force` does not cover one.** `force` suppresses "it
   * isn't there", which is the opposite failure — a directory some *other live
   * process* holds open still throws `EBUSY`, and on Windows merely being a running
   * process's cwd is enough to hold it. So the removal retries (see
   * {@link RMDIR_RETRIES}), and what it throws when the retries run out names the
   * cause rather than the errno: the operator's next move is to go find the process,
   * and `EBUSY: resource busy or locked` does not tell them that is what to do.
   */
  private async reclaim(dir: string): Promise<void> {
    await this.git(['worktree', 'prune']).catch(() => {});
    if (!existsSync(dir)) return;
    const entries = await this.registered();
    if (entries.some((e) => e.path === dir)) return;
    // git may still half-track it; the removal below is the real reclaim, so a
    // refusal here ("not a working tree") is expected rather than a failure.
    await this.git(['worktree', 'remove', '--force', dir]).catch(() => {});
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: RMDIR_RETRIES, retryDelay: RMDIR_RETRY_DELAY_MS });
    } catch (err) {
      throw new Error(reclaimFailure(dir, err as NodeJS.ErrnoException));
    }
  }

  /**
   * The live worktrees, paths resolved: git's porcelain output is
   * forward-slashed even on Windows, so an unresolved path would never compare
   * equal to the `resolve`d target `reclaim` guards on.
   */
  private async registered(): Promise<WorktreeEntry[]> {
    const { stdout } = await this.git(['worktree', 'list', '--porcelain']);
    return parseWorktreeList(stdout).map((e) => ({ ...e, path: resolve(e.path) }));
  }

  private async branchExists(branch: string): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  private git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return runGit(this.repoRoot, args);
  }
}

/**
 * How many times the reclaim's `rmSync` retries, and how long it waits between
 * attempts — roughly a second in total. Node retries internally on exactly the
 * errors a *transient* holder produces (`EBUSY`, `EMFILE`, `ENFILE`, `ENOTEMPTY`,
 * `EPERM`), which is the distinction being drawn: a file still closing loses its
 * grip inside a second, and a process that has the directory as its cwd never
 * does. Sized to tell those apart rather than to outwait the second one — a
 * dispatch that hung on for a minute would be worse than the honest failure below.
 */
const RMDIR_RETRIES = 5;
const RMDIR_RETRY_DELAY_MS = 200;

/**
 * What a reclaim that lost says, in the operator's terms.
 *
 * The errno alone (`EBUSY: resource busy or locked, rmdir '<dir>'`) is a true
 * statement of the syscall and a dead end as a report: it is the same text whether
 * a virus scanner had the folder open for a moment or a shell an agent left behind
 * two days ago is sitting in it, and only the second one is going to still be there
 * next cycle. Since the retries have already ruled the first out by the time this
 * is built, it can say the thing that is actually true and name the next move.
 */
function reclaimFailure(dir: string, err: NodeJS.ErrnoException): string {
  const held = err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'ENOTEMPTY';
  if (!held) return `Cannot reclaim the worktree directory ${dir}: ${err.message}`;
  return (
    `Cannot reclaim the worktree directory ${dir}: it is held open by another process (${err.code}), ` +
    `and was still held after ${RMDIR_RETRIES} retries over ` +
    `${(RMDIR_RETRIES * RMDIR_RETRY_DELAY_MS) / 1000}s. That is almost always a process an earlier agent ` +
    `started and left running — a shell, a watcher, a test runner — whose working directory is still ` +
    `inside it; on Windows being a live process's cwd is by itself enough to refuse the removal. ` +
    `Stop that process and the branch dispatches again on the next cycle; until then every dispatch ` +
    `onto it will fail here.`
  );
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
}

function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) entries.push({ path: current.path, branch: current.branch ?? null });
      current = { path: line.slice('worktree '.length).trim() };
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim();
    } else if (line.trim() === '') {
      if (current.path) entries.push({ path: current.path, branch: current.branch ?? null });
      current = {};
    }
  }
  if (current.path) entries.push({ path: current.path, branch: current.branch ?? null });
  return entries;
}
