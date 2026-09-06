import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function tmpDir(prefix = 'lubbdubb-'): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

export function gitRepo(prefix = 'lubbdubb-repo-'): string {
  const dir = tmpDir(prefix);
  const git = (args: string[]): void => void execFileSync('git', args, { cwd: dir });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['commit', '-q', '--allow-empty', '-m', 'root']);
  return dir;
}
