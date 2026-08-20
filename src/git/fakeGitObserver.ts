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
  /** `<head> <commit>` -> what the clone says. Unscripted reads as "the clone cannot say". */
  private readonly containment = new Map<string, boolean>();

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

  /**
   * Declare that a head holds (or does not hold) a commit. Undeclared pairs
   * answer `null` — the honest default, since a clone that was never told about
   * an object has not been asked about it.
   */
  setContains(head: string, commit: string, held: boolean): this {
    this.containment.set(`${head} ${commit}`, held);
    return this;
  }

  async contains(commits: string[], heads: string[]): Promise<Map<string, boolean | null>> {
    this.calls.push(`contains:${heads.join(',')}:${commits.join(',')}`);
    const out = new Map<string, boolean | null>();
    for (const commit of commits) {
      const said = heads.map((head) => this.containment.get(`${head} ${commit}`));
      // Every head, as the real one folds it: one that has not heard of the
      // commit takes the answer to unknown, and one saying no settles it.
      if (heads.length === 0 || said.some((v) => v === undefined)) out.set(commit, null);
      else
        out.set(
          commit,
          said.every((v) => v === true),
        );
    }
    return out;
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
