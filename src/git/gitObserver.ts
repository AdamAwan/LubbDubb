import { runGit, resolveCommit } from './gitCli.js';

// → docs/spec/09-execution.md

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
  diff(base: string, head: string): Promise<string | null>;
}

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

  async diff(base: string, head: string): Promise<string | null> {
    const [baseSha, headSha] = await Promise.all([
      resolveCommit(this.repoRoot, base),
      resolveCommit(this.repoRoot, head),
    ]);
    if (!baseSha || !headSha) return null;
    try {
      const { stdout } = await runGit(this.repoRoot, [
        'diff',
        '--no-color',
        '--no-ext-diff',
        '-M',
        `${baseSha}...${headSha}`,
      ]);
      return stdout;
    } catch {
      return null;
    }
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
      const { stdout } = await runGit(this.repoRoot, ['rev-list', '--ignore-missing', '--no-walk', ...commits]);
      const held = new Set(
        stdout
          .split('\n')
          .map((l) => l.trim().toLowerCase())
          .filter((l) => l !== ''),
      );
      for (const commit of commits) if (held.has(commit.toLowerCase())) out.set(commit, commit.toLowerCase());
    } catch {
      /* a git that would not run answers about nothing — every commit stays unknown */
    }
    return out;
  }

  private async notReachableFrom(commits: string[], head: string): Promise<Set<string> | null> {
    const sha = await resolveCommit(this.repoRoot, head);
    if (sha === null) return null;
    try {
      const { stdout } = await runGit(this.repoRoot, ['rev-list', '--ignore-missing', ...commits, '--not', sha]);
      return new Set(
        stdout
          .split('\n')
          .map((l) => l.trim().toLowerCase())
          .filter((l) => l !== ''),
      );
    } catch {
      return null;
    }
  }

  private async refExists(ref: string): Promise<boolean> {
    try {
      const { stdout } = await runGit(this.repoRoot, ['rev-parse', '--verify', '--quiet', ref]);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }
}
