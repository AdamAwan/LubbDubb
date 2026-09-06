import { exec } from 'node:child_process';
import { parseHealthReport, unreadable, type EnvironmentHealthReport } from './health.js';

// → docs/spec/24-environments.md

export interface EnvironmentHealthProber {
  check(environment: string, command: string): Promise<EnvironmentHealthReport>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class CommandEnvironmentHealthProber implements EnvironmentHealthProber {
  constructor(
    private readonly repoRoot: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  check(environment: string, command: string): Promise<EnvironmentHealthReport> {
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
          const report = parseHealthReport(stdout);
          if (err === null || report.detail === null) return resolve(report);
          resolve(unreadable(failure(err as ExecFailure, stderr)));
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

function failure(err: ExecFailure, stderr: string): string {
  if (err.killed === true || (err.signal !== null && err.signal !== undefined))
    return `the health check was killed after ${err.signal ?? 'timeout'}`;
  const why = firstLine(stderr);
  return `the health check exited ${String(err.code ?? 'unknown')}: ${why ?? err.message}`;
}

function firstLine(text: string): string | null {
  const line = text.split('\n').find((l) => l.trim() !== '');
  return line === undefined ? null : line.trim().slice(0, 200);
}
