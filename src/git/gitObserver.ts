import type { ErrorRecorder } from '../errorLog.js';
import { runGit, resolveCommit } from './gitCli.js';

// → docs/spec/09-execution.md

// A read-only probe must never open a socket: on a partial clone every one of these
// arguments can be an object this checkout has never fetched, and git would silently
// turn the question into a promisor fetch. → docs/spec/09-execution.md#a-git-that-never-exits
const READ_ONLY = { noLazyFetch: true } as const;

export interface BranchPresence {
  local: boolean;
  remote: boolean;
}

export interface BranchDivergence {
  ahead: number;
  behind: number;
}

export interface GitObserver {
  presence(branch: string): Promise<BranchPresence>;
  divergence(branch: string, base: string): Promise<BranchDivergence | null>;
  hasCommitsBeyond(branch: string, base: string): Promise<boolean>;
  contains(commits: string[], heads: string[]): Promise<Map<string, boolean | null>>;
}

export class GitCliObserver implements GitObserver {
  constructor(
    private readonly repoRoot: string,
    private readonly errors?: ErrorRecorder,
  ) {}

  async presence(branch: string): Promise<BranchPresence> {
    const [local, remote] = await Promise.all([
      this.refExists(`refs/heads/${branch}`),
      this.refExists(`refs/remotes/origin/${branch}`),
    ]);
    return { local, remote };
  }

  async divergence(branch: string, base: string): Promise<BranchDivergence | null> {
    const [branchSha, baseSha] = await Promise.all([
      resolveCommit(this.repoRoot, branch, READ_ONLY),
      resolveCommit(this.repoRoot, base, READ_ONLY),
    ]);
    if (!branchSha || !baseSha) return null;
    const { stdout } = await runGit(
      this.repoRoot,
      ['rev-list', '--left-right', '--count', `${baseSha}...${branchSha}`],
      READ_ONLY,
    );
    const [behind, ahead] = stdout.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return null;
    return { ahead: ahead!, behind: behind! };
  }

  async hasCommitsBeyond(branch: string, base: string): Promise<boolean> {
    const d = await this.divergence(branch, base);
    return d !== null && d.ahead > 0;
  }

  async contains(commits: string[], heads: string[]): Promise<Map<string, boolean | null>> {
    const out = new Map<string, boolean | null>(commits.map((c) => [c, null]));
    if (commits.length === 0 || heads.length === 0) return out;

    const present = await this.presentCommits(commits);
    if (present.size === 0) return out;
    const asking = [...present.values()];
    for (const key of present.keys()) out.set(key, true);

    for (const head of heads) {
      const missing = await this.notReachableFrom(asking, head);
      if (missing === null) return new Map(commits.map((c) => [c, null]));
      for (const [key, sha] of present) if (missing.has(sha)) out.set(key, false);
    }
    return out;
  }

  private async presentCommits(commits: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    try {
      const { stdout } = await runGit(
        this.repoRoot,
        ['rev-list', '--ignore-missing', '--no-walk', ...commits],
        READ_ONLY,
      );
      const held = new Set(
        stdout
          .split('\n')
          .map((l) => l.trim().toLowerCase())
          .filter((l) => l !== ''),
      );
      for (const commit of commits) if (held.has(commit.toLowerCase())) out.set(commit, commit.toLowerCase());
    } catch (err) {
      this.note(`asking which of ${commits.length} commit(s) this checkout holds`, err);
    }
    return out;
  }

  private async notReachableFrom(commits: string[], head: string): Promise<Set<string> | null> {
    const sha = await resolveCommit(this.repoRoot, head, READ_ONLY);
    if (sha === null) return null;
    try {
      const { stdout } = await runGit(
        this.repoRoot,
        ['rev-list', '--ignore-missing', ...commits, '--not', sha],
        READ_ONLY,
      );
      return new Set(
        stdout
          .split('\n')
          .map((l) => l.trim().toLowerCase())
          .filter((l) => l !== ''),
      );
    } catch (err) {
      this.note(`asking what ${head} reaches`, err);
      return null;
    }
  }

  private note(asking: string, err: unknown): void {
    this.errors?.record({
      source: 'cycle',
      message: `the clone at ${this.repoRoot} could not answer: ${asking}`,
      detail: (err as Error).message,
    });
  }

  private async refExists(ref: string): Promise<boolean> {
    try {
      const { stdout } = await runGit(this.repoRoot, ['rev-parse', '--verify', '--quiet', ref], READ_ONLY);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }
}
