import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A throwaway directory under the system temp root, in the **long** form of its path.
 *
 * The `realpathSync.native` is the whole method, and it is not tidiness. On Windows
 * `tmpdir()` hands back the 8.3 short form (`C:\Users\ABCDEF~1\…`) while git reports
 * every path in `worktree list --porcelain` in its long form, and `resolve` expands
 * neither into the other — so a `repoRoot` or a `worktreeRoot` built from `tmpdir()`
 * raw makes **every** path identity the worktree manager makes against git's own
 * answers miss.
 *
 * Each of those misses has a plausible innocent reading, which is why it went
 * unnoticed: a path that is not the repo root, a worktree the pool does not own. So
 * the suite ran against a manager that could not recognise its own repository, and
 * `deleteBranch`'s repo-root guard — the one keeping the reap from detaching an
 * operator's checkout — failed *open* under test, doing the exact thing it exists to
 * prevent. Nothing asserted on it, so nothing was red.
 *
 * Use this anywhere a test hands the harness a temp path git will later have an
 * opinion about; `join(tmpdir(), …)` on its own is the bug.
 */
export function tmpDir(prefix = 'lubbdubb-'): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

/**
 * A throwaway git repo with one commit, for the tests whose subject really is git —
 * reuse-first `ensure`, ref collisions, `hasCommitsBeyond`. Everything else should
 * inject `FakeWorktreeManager` instead of pointing `repoRoot` at a repository at all.
 *
 * `main` is named explicitly: agent branches are cut from `config.defaultBranch`
 * ("main"), while a bare `git init` takes whatever the host's `init.defaultBranch`
 * says — which on a developer's machine is not reliably the same thing.
 */
export function gitRepo(prefix = 'lubbdubb-repo-'): string {
  const dir = tmpDir(prefix);
  const git = (args: string[]): void => void execFileSync('git', args, { cwd: dir });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['commit', '-q', '--allow-empty', '-m', 'root']);
  return dir;
}
