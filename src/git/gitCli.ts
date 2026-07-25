import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * The one place git is shelled out to against a repo root. Shared by
 * {@link WorktreeManager} and {@link GitCliObserver} so "which repo does this run
 * against" has a single answer rather than a copy per consumer.
 */
export function runGit(repoRoot: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return exec('git', args, { cwd: repoRoot });
}

/**
 * Refresh the remote-tracking refs. The {@link GitObserver} is deliberately
 * fetch-free, so this is the caller's half of that split: plan reconciliation runs
 * it on the pulse (floored by `planning.gitFetchIntervalMs`) because otherwise the
 * observer never sees a branch pushed from anywhere but this machine.
 *
 * `--prune` so a deleted remote branch stops reading as present. Failure is the
 * caller's to record — a repo with no `origin` is a legitimate configuration.
 */
export async function fetchRemote(repoRoot: string): Promise<void> {
  await runGit(repoRoot, ['fetch', '--prune', 'origin']);
}

/**
 * Resolve a branch name (or any commit-ish) to a commit SHA, or null if it names
 * nothing. **`origin/` wins over the local ref**: the harness's clone is a server
 * -side one whose `refs/heads/main` is frozen at clone time — nothing ever checks
 * main out — while the remote-tracking ref moves whenever an agent fetches, so
 * the remote is the fresher answer to "where does this branch actually point".
 * Falls through to the raw revision last, which is what resolves an explicit
 * `origin/x`, a tag or a SHA.
 *
 * Callers get a SHA rather than a ref name deliberately: handing
 * `git worktree add -b` a remote-tracking ref would set the new branch's upstream
 * to it, so a later bare `git push` would aim at the *base*.
 */
export async function resolveCommit(repoRoot: string, ref: string): Promise<string | null> {
  for (const candidate of [`refs/remotes/origin/${ref}`, `refs/heads/${ref}`, `${ref}^{commit}`]) {
    try {
      const { stdout } = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', candidate]);
      const sha = stdout.trim();
      if (sha) return sha;
    } catch {
      /* candidate names nothing — try the next */
    }
  }
  return null;
}
