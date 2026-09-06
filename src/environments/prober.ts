import { exec } from 'node:child_process';

// → docs/spec/24-environments.md

export interface EnvironmentHead {
  commits: string[] | null;
  detail: string | null;
}

export interface EnvironmentProber {
  at(environment: string, command: string): Promise<EnvironmentHead>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class CommandEnvironmentProber implements EnvironmentProber {
  constructor(
    private readonly repoRoot: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  at(environment: string, command: string): Promise<EnvironmentHead> {
    return new Promise((resolve) => {
      exec(
        command,
        {
          cwd: this.repoRoot,
          timeout: this.timeoutMs,
          windowsHide: true,
          env: { ...process.env, LUBBDUBB_ENVIRONMENT: environment },
        },
        (err, stdout, stderr) => {
          if (err !== null) return resolve(failure(err as ExecFailure, stderr));
          const commits = stdout.split(/\s+/).filter((t) => t !== '');
          if (commits.length === 0)
            return resolve({ commits: null, detail: 'the probe named no commit — it exited 0 and printed nothing' });
          resolve({ commits, detail: null });
        },
      );
    });
  }
}

interface ExecFailure extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
}

function failure(err: ExecFailure, stderr: string): EnvironmentHead {
  if (err.killed === true || (err.signal !== null && err.signal !== undefined))
    return { commits: null, detail: `probe killed after ${err.signal ?? 'timeout'}` };
  const why = firstLine(stderr);
  return { commits: null, detail: `exit ${String(err.code ?? 'unknown')}: ${why ?? err.message}` };
}

function firstLine(text: string): string | null {
  const line = text.split('\n').find((l) => l.trim() !== '');
  return line === undefined ? null : line.trim().slice(0, 200);
}
