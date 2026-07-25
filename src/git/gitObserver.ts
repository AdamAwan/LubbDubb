import { runGit, resolveCommit } from './gitCli.js';

/** Where a branch exists. Both false = the branch is nowhere yet. */
export interface BranchPresence {
  local: boolean;
  remote: boolean;
}

/** Commit counts between a branch and its base. */
export interface BranchDivergence {
  /** Commits the branch has that the base doesn't. */
  ahead: number;
  /** Commits the base has that the branch doesn't. */
  behind: number;
}

/**
 * Reads branch reality out of the local clone. It's the only source that sees a
 * branch *before* a PR exists, and it costs no API call, but it can't see merges:
 * `merge_pr` squashes, and a squash-merged branch has no ancestry link to its
 * base — merge stays a provider fact.
 *
 * Read-only and fetch-free: nothing here mutates or refreshes the remote-tracking
 * refs, so how often to `git fetch` is the caller's decision, not this seam's.
 *
 * Branch names resolve through {@link resolveCommit} — `origin/<name>` ahead of
 * the local ref — the same rule {@link WorktreeManager.ensure} uses for a base.
 */
export interface GitObserver {
  /** Does the branch exist, locally or on the remote? */
  presence(branch: string): Promise<BranchPresence>;
  /** How far the branch is ahead/behind its base, or null if either names nothing. */
  divergence(branch: string, base: string): Promise<BranchDivergence | null>;
  /**
   * Has the branch any commits beyond its base — i.e. `divergence().ahead > 0`,
   * named because it's the condition a stacked part waits on: a dependency's
   * branch existing is not enough, it has to carry work.
   */
  hasCommitsBeyond(branch: string, base: string): Promise<boolean>;
}

/** The real observer: `git` in the repo root, the same way {@link WorktreeManager} runs it. */
export class GitCliObserver implements GitObserver {
  constructor(private readonly repoRoot: string) {}

  async presence(branch: string): Promise<BranchPresence> {
    const [local, remote] = await Promise.all([
      this.refExists(`refs/heads/${branch}`),
      this.refExists(`refs/remotes/origin/${branch}`),
    ]);
    return { local, remote };
  }

  async divergence(branch: string, base: string): Promise<BranchDivergence | null> {
    const [branchSha, baseSha] = await Promise.all([
      resolveCommit(this.repoRoot, branch),
      resolveCommit(this.repoRoot, base),
    ]);
    if (!branchSha || !baseSha) return null;
    // `--left-right --count A...B` prints "<in A not B>\t<in B not A>", so with the
    // base on the left the columns land as behind, then ahead.
    const { stdout } = await runGit(this.repoRoot, [
      'rev-list',
      '--left-right',
      '--count',
      `${baseSha}...${branchSha}`,
    ]);
    const [behind, ahead] = stdout.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return null;
    return { ahead: ahead!, behind: behind! };
  }

  async hasCommitsBeyond(branch: string, base: string): Promise<boolean> {
    const d = await this.divergence(branch, base);
    return d !== null && d.ahead > 0;
  }

  private async refExists(ref: string): Promise<boolean> {
    try {
      const { stdout } = await runGit(this.repoRoot, ['rev-parse', '--verify', '--quiet', ref]);
      return stdout.trim().length > 0;
    } catch {
      return false; // a ref that names nothing isn't a failure, it's the answer
    }
  }
}
