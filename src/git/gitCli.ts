import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runSerial } from './serialQueue.js';

// → docs/spec/09-execution.md

const exec = promisify(execFile);

const GIT_TIMEOUT_MS = 120_000;
const GIT_SLOW_TIMEOUT_MS = 15 * 60_000;

const SLOW_SUBCOMMANDS = new Set([
  'checkout',
  'clean',
  'clone',
  'fetch',
  'gc',
  'pull',
  'push',
  'reset',
  'stash',
  'submodule',
  'switch',
  'worktree',
  'ls-remote',
]);

function timeoutFor(args: string[]): number {
  const subcommand = args.find((arg) => !arg.startsWith('-'));
  return subcommand !== undefined && SLOW_SUBCOMMANDS.has(subcommand) ? GIT_SLOW_TIMEOUT_MS : GIT_TIMEOUT_MS;
}

interface GitRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function runGit(
  repoRoot: string,
  args: string[],
  opts: GitRunOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const timeout = opts.timeoutMs ?? timeoutFor(args);
  try {
    return await exec('git', args, { cwd: repoRoot, timeout, killSignal: 'SIGKILL', signal: opts.signal });
  } catch (err) {
    const killed = err as { killed?: boolean; signal?: string | null };
    if (killed.killed === true && killed.signal === 'SIGKILL' && opts.signal?.aborted !== true)
      throw new Error(`git ${args.join(' ')} did not exit within ${timeout}ms in ${repoRoot}; it was killed`);
    throw err;
  }
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
