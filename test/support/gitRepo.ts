import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const git = (args: string[]): void => void execFileSync('git', args, { cwd: dir });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['commit', '-q', '--allow-empty', '-m', 'root']);
  return dir;
}
