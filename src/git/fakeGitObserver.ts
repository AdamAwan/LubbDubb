import type { BranchDivergence, BranchPresence, GitObserver } from './gitObserver.js';

// → docs/spec/09-execution.md

export class FakeGitObserver implements GitObserver {
  readonly calls: string[] = [];
  private readonly presences = new Map<string, BranchPresence>();
  private readonly divergences = new Map<string, BranchDivergence>();
  private readonly containment = new Map<string, boolean>();
  private readonly diffs = new Map<string, string>();

  setPresence(branch: string, presence: Partial<BranchPresence>): this {
    this.presences.set(branch, { local: presence.local ?? false, remote: presence.remote ?? false });
    return this;
  }

  setDivergence(branch: string, base: string, divergence: BranchDivergence): this {
    this.divergences.set(key(branch, base), divergence);
    return this;
  }

  setContains(head: string, commit: string, held: boolean): this {
    this.containment.set(`${head} ${commit}`, held);
    return this;
  }

  setDiff(base: string, head: string, diff: string): this {
    this.diffs.set(key(head, base), diff);
    return this;
  }

  async diff(base: string, head: string): Promise<string | null> {
    this.calls.push(`diff:${key(head, base)}`);
    return this.diffs.get(key(head, base)) ?? null;
  }

  async contains(commits: string[], heads: string[]): Promise<Map<string, boolean | null>> {
    this.calls.push(`contains:${heads.join(',')}:${commits.join(',')}`);
    const out = new Map<string, boolean | null>();
    for (const commit of commits) {
      const said = heads.map((head) => this.containment.get(`${head} ${commit}`));
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
