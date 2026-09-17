import { spawn } from 'node:child_process';
import { killProcessTree } from '../agents/processTree.js';
import { runSerial } from './serialQueue.js';

// → docs/spec/09-execution.md

const GIT_TIMEOUT_MS = 120_000;
const GIT_SLOW_TIMEOUT_MS = 15 * 60_000;
// What `execFile` capped each stream at before this ran on `spawn`; kept so no
// caller's output limit moved with the deadline fix.
const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;

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
  noLazyFetch?: boolean;
}

export async function runGit(
  repoRoot: string,
  args: string[],
  opts: GitRunOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const timeout = opts.timeoutMs ?? timeoutFor(args);
  const env = opts.noLazyFetch === true ? { ...process.env, GIT_NO_LAZY_FETCH: '1' } : process.env;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn('git', args, {
      cwd: repoRoot,
      env,
      windowsHide: true,
      // Its own process group, so `end` below signals the subtree rather than this
      // process's. `execFile` drops this option, which is why this is `spawn`.
      detached: process.platform !== 'win32',
    });

    const out: Buffer[] = [];
    const errOut: Buffer[] = [];

    // `reap` is what the deadline is worth: a git the harness gives up on has already
    // handed its stdio to whatever it spawned, so signalling the child alone leaves the
    // subtree running and this promise unsettled — which is the hang the deadline exists
    // to end. The group outlives its leader, so this reaps whether or not git itself is
    // still up.
    const end = (fail: Error | null, reap = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (reap && child.pid !== undefined) {
        killProcessTree(child.pid);
        child.kill('SIGKILL');
      }
      if (fail === null) {
        resolve({ stdout: text(out), stderr: text(errOut) });
        return;
      }
      reject(Object.assign(fail, { stdout: text(out), stderr: text(errOut) }));
    };

    const onAbort = (): void => {
      end(Object.assign(new Error(`git ${args.join(' ')} was aborted`), { name: 'AbortError' }), true);
    };

    const timer = setTimeout(() => {
      end(new Error(`git ${args.join(' ')} did not exit within ${timeout}ms in ${repoRoot}; it was killed`), true);
    }, timeout);
    timer.unref();

    if (opts.signal?.aborted === true) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const collect = (into: Buffer[]) => {
      let bytes = 0;
      return (chunk: Buffer): void => {
        bytes += chunk.length;
        if (bytes > GIT_MAX_OUTPUT_BYTES) {
          end(new Error(`git ${args.join(' ')} wrote more than ${GIT_MAX_OUTPUT_BYTES} bytes in ${repoRoot}`), true);
          return;
        }
        into.push(chunk);
      };
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(errOut));

    child.on('error', (err) => end(err));
    child.on('close', (code, signal) => {
      if (code === 0) {
        end(null);
        return;
      }
      const said = text(errOut).trim();
      const how = signal === null ? `exited ${code}` : `was killed by ${signal}`;
      end(
        Object.assign(new Error(`git ${args.join(' ')} ${how}${said === '' ? '' : `: ${firstLines(said)}`}`), {
          code: signal === null ? code : signal,
        }),
      );
    });
  });
}

function text(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString('utf8');
}

function firstLines(said: string): string {
  return said.split('\n').slice(0, 3).join('\n');
}

export function fetchRemote(repoRoot: string): Promise<void> {
  return runSerial(`fetch:${repoRoot}`, async () => {
    await runGit(repoRoot, ['fetch', '--prune', 'origin']);
  });
}

export async function resolveCommit(repoRoot: string, ref: string, opts: GitRunOptions = {}): Promise<string | null> {
  for (const candidate of [`refs/remotes/origin/${ref}`, `refs/heads/${ref}`, `${ref}^{commit}`]) {
    try {
      const { stdout } = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', candidate], opts);
      const sha = stdout.trim();
      if (sha) return sha;
    } catch {
      /* candidate names nothing — try the next */
    }
  }
  return null;
}
