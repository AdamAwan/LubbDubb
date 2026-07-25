import type { BranchDivergence, BranchPresence, GitObserver } from './gitObserver.js';

/**
 * A scripted {@link GitObserver} for tests — same shape as {@link FakePtyBackend}
 * and the fake `GitHubApi`: declare the branch reality you want, then assert on
 * `calls`. Anything not declared reads as "branch is nowhere", so a test only
 * states the facts it cares about.
 */
export class FakeGitObserver implements GitObserver {
  /** Every question asked, in order, e.g. `presence:issue/12/schema`. For assertions. */
  readonly calls: string[] = [];
  private readonly presences = new Map<string, BranchPresence>();
  private readonly divergences = new Map<string, BranchDivergence>();

  /** Declare where a branch exists. Unspecified sides default to absent. */
  setPresence(branch: string, presence: Partial<BranchPresence>): this {
    this.presences.set(branch, { local: presence.local ?? false, remote: presence.remote ?? false });
    return this;
  }

  /** Declare a branch's divergence from a base. Undeclared pairs resolve to null. */
  setDivergence(branch: string, base: string, divergence: BranchDivergence): this {
    this.divergences.set(key(branch, base), divergence);
    return this;
  }

  async presence(branch: string): Promise<BranchPresence> {
    this.calls.push(`presence:${branch}`);
    return this.presences.get(branch) ?? { local: false, remote: false };
  }

  async divergence(branch: string, base: string): Promise<BranchDivergence | null> {
    this.calls.push(`divergence:${key(branch, base)}`);
    return this.divergences.get(key(branch, base)) ?? null;
  }

  async hasCommitsBeyond(branch: string, base: string): Promise<boolean> {
    const d = await this.divergence(branch, base);
    return d !== null && d.ahead > 0;
  }
}

function key(branch: string, base: string): string {
  return `${branch}...${base}`;
}
