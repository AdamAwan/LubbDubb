import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { runGit, resolveCommit } from '../git/gitCli.js';

/**
 * Creates git worktrees lazily — only when a code task needs one — keyed by
 * branch and reused if a worktree for that branch already exists. Desk tasks
 * never call this. Keeping worktrees per-branch means two tasks on the same
 * branch share a checkout instead of fighting over it.
 */
export class WorktreeManager {
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

    const dir = resolve(this.worktreeRoot, sanitize(branch));
    mkdirSync(this.worktreeRoot, { recursive: true });

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
    const { stdout } = await this.git(['worktree', 'list', '--porcelain']);
    const entries = parseWorktreeList(stdout);
    const match = entries.find((e) => e.branch === branch || e.branch === `refs/heads/${branch}`);
    if (match && existsSync(match.path)) return match.path;
    return null;
  }

  async remove(branch: string): Promise<void> {
    const dir = await this.findExisting(branch);
    if (!dir) return;
    await this.git(['worktree', 'remove', '--force', dir]);
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

function sanitize(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]/g, '-');
}
