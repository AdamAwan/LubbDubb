import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runSerial } from './serialQueue.js';

// → docs/spec/09-execution.md

const exec = promisify(execFile);

export function runGit(repoRoot: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return exec('git', args, { cwd: repoRoot });
}

export function fetchRemote(repoRoot: string): Promise<void> {
  return runSerial(`fetch:${repoRoot}`, async () => {
    await runGit(repoRoot, ['fetch', '--prune', 'origin']);
  });
}

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
