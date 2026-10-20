import { exec } from 'node:child_process';
import { firstLine } from '../primitives.js';
import { parseAppErrorReport, unreadableErrors, type AppErrorReport } from './report.js';

// → docs/spec/39-app-errors.md

export interface AppErrorReadRequest {
  environment: string;
  /** The declared `errors.list`, with `{since}` already substituted. */
  command: string;
  since: string;
}

export interface AppErrorReader {
  list(request: AppErrorReadRequest): Promise<AppErrorReport>;
}

const DEFAULT_TIMEOUT_MS = 60_000;

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export class CommandAppErrorReader implements AppErrorReader {
  constructor(
    private readonly repoRoot: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  list(request: AppErrorReadRequest): Promise<AppErrorReport> {
    return new Promise((resolve) => {
      exec(
        request.command,
        {
          cwd: this.repoRoot,
          timeout: this.timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          env: { ...process.env, LUBBDUBB_ENVIRONMENT: request.environment, LUBBDUBB_ERRORS_SINCE: request.since },
        },
        (err, stdout, stderr) => {
          if (err !== null) return resolve(unreadableErrors(failure(err as ExecFailure, stderr)));
          resolve(parseAppErrorReport(stdout));
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
    return `the errors command was killed after ${err.signal ?? 'timeout'}`;
  const why = firstLine(stderr);
  return `the errors command exited ${String(err.code ?? 'unknown')}: ${why ?? err.message}`;
}
