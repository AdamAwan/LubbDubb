import { exec } from 'node:child_process';
import { firstLine } from '../primitives.js';

// → docs/spec/39-app-errors.md#seams

export const ERRORS_COMMAND_TIMEOUT_MS = 60_000;

/** What an `errors` command printed — `overflowed` when it printed past `maxBuffer` and was cut off there — or why it failed. */
export type ErrorsCommandOutput = { ok: true; stdout: string; overflowed: boolean } | { ok: false; failure: string };

export interface ErrorsCommand {
  /** How a failure names the command: `the errors command`, `the detail query`. */
  label: string;
  command: string;
  env: Record<string, string>;
  repoRoot: string;
  timeoutMs: number;
  maxBuffer: number;
}

export function runErrorsCommand(run: ErrorsCommand): Promise<ErrorsCommandOutput> {
  return new Promise((resolve) => {
    exec(
      run.command,
      {
        cwd: run.repoRoot,
        timeout: run.timeoutMs,
        maxBuffer: run.maxBuffer,
        windowsHide: true,
        env: { ...process.env, ...run.env },
      },
      (err, stdout, stderr) => {
        if (err === null) return resolve({ ok: true, stdout, overflowed: false });
        const failed = err as ExecFailure;
        if (failed.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ ok: true, stdout, overflowed: true });
        resolve({ ok: false, failure: failure(run.label, failed, stderr) });
      },
    );
  });
}

interface ExecFailure extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
}

function failure(label: string, err: ExecFailure, stderr: string): string {
  if (err.killed === true || (err.signal !== null && err.signal !== undefined))
    return `${label} was killed after ${err.signal ?? 'timeout'}`;
  const why = firstLine(stderr);
  return `${label} exited ${String(err.code ?? 'unknown')}: ${why ?? err.message}`;
}
