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
  /**
   * Which of `commits` every one of `heads` already holds — the question "has this
   * landing got to an environment sitting at these commits".
   *
   * **Every**, not any: an environment answering with several commits is several
   * services at several versions, and the laggard governs. A landing one of them
   * has and another does not is *not* there.
   *
   * Three answers per commit, for {@link EnvironmentReachStatus}'s reason: `true`
   * it is in, `false` it is not, and **`null` the clone cannot say** — an object
   * this checkout has not fetched, a head that resolves to nothing, or a git that
   * failed. Never `false` for a question that was not answered.
   *
   * Batched because the alternative is a process spawn per landing per environment
   * per pulse: the cost of the whole subsystem lands here.
   * → `docs/spec/24-environments.md#asking-the-clone`
   */
  contains(commits: string[], heads: string[]): Promise<Map<string, boolean | null>>;
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

  async contains(commits: string[], heads: string[]): Promise<Map<string, boolean | null>> {
    const out = new Map<string, boolean | null>(commits.map((c) => [c, null]));
    // An environment that named no commit is one nothing is known about. Reading
    // an empty head list as "contains everything" is the one way this can be
    // wrong at scale, and it reports the whole fleet as shipped.
    if (commits.length === 0 || heads.length === 0) return out;

    // The objects this clone actually holds. A landing merged while the harness
    // was down and never fetched since is not `absent` — it is unanswered.
    const present = await this.presentCommits(commits);
    if (present.size === 0) return out;
    const asking = [...present.values()];
    for (const key of present.keys()) out.set(key, true);

    for (const head of heads) {
      const missing = await this.notReachableFrom(asking, head);
      // A head that would not resolve takes the whole environment down to
      // unknown rather than leaving the answers half-made from the heads that did.
      if (missing === null) return new Map(commits.map((c) => [c, null]));
      for (const [key, sha] of present) if (missing.has(sha)) out.set(key, false);
    }
    return out;
  }

  /**
   * The subset of these commits the clone holds, as `given -> resolved sha`.
   *
   * `--no-walk` prints the arguments themselves rather than their history, and
   * `--ignore-missing` drops the ones this checkout never fetched instead of
   * failing the whole call over one of them. The pair is only sound *without*
   * an exclusion — git drops `--no-walk` the moment a range is present, which is
   * why the reachability question below is a second call rather than one clever one.
   */
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

  /**
   * Which of these commits are **not** in the head's history, or null when the
   * question could not be put.
   *
   * `rev-list <commits> --not <head>` walks from each commit back to its merge
   * base with the head, so it returns instantly for the commits the head already
   * has — the steady state — and pays only for how far ahead of the environment
   * the branch has run. The walk emits ancestors as well as the commits asked
   * about, hence the intersection at the call site.
   */
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
      return false; // a ref that names nothing isn't a failure, it's the answer
    }
  }
}
