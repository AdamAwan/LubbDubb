import { exec } from 'node:child_process';
import { firstLine } from '../primitives.js';
import { MAX_LOOKBACK_MS } from './groups.js';
import { errorsCommand } from './report.js';

// → docs/spec/39-app-errors.md#the-detail-query

export const FINGERPRINT_TOKEN = '{fingerprint}';

export const MAX_DETAIL_OUTPUT_CHARS = 32_000;

const DEFAULT_TIMEOUT_MS = 60_000;

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface AppErrorDetailRequest {
  environment: string;
  /** The declared `errors.detail`, with `{since}` substituted and nothing else: the fingerprint rides only in the env. */
  command: string;
  fingerprint: string;
  since: string;
}

/** What the detail query printed, capped; or why it printed nothing usable. */
export type AppErrorDetailOutput = { ok: true; text: string; truncated: boolean } | { ok: false; failure: string };

export interface AppErrorDetailRunner {
  detail(request: AppErrorDetailRequest): Promise<AppErrorDetailOutput>;
}

/** The group's first sighting, never more than the fourteen days a list read reaches back. */
function detailSince(firstSeen: string | null, now: number): string {
  const floor = now - MAX_LOOKBACK_MS;
  const seen = firstSeen === null ? NaN : Date.parse(firstSeen);
  return new Date(Number.isNaN(seen) ? floor : Math.max(seen, floor)).toISOString();
}

export function detailRequest(input: {
  environment: string;
  detail: string;
  fingerprint: string;
  firstSeen: string | null;
  now: number;
}): AppErrorDetailRequest {
  const since = detailSince(input.firstSeen, input.now);
  return {
    environment: input.environment,
    command: errorsCommand(input.detail, since),
    fingerprint: input.fingerprint,
    since,
  };
}

export function capDetailOutput(stdout: string): AppErrorDetailOutput {
  const text = stdout.trim();
  if (text === '') return { ok: false, failure: 'the detail query exited 0 and printed nothing' };
  if (text.length <= MAX_DETAIL_OUTPUT_CHARS) return { ok: true, text, truncated: false };
  return { ok: true, text: text.slice(0, MAX_DETAIL_OUTPUT_CHARS), truncated: true };
}

export class CommandAppErrorDetailRunner implements AppErrorDetailRunner {
  constructor(
    private readonly repoRoot: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  detail(request: AppErrorDetailRequest): Promise<AppErrorDetailOutput> {
    return new Promise((resolve) => {
      exec(
        request.command,
        {
          cwd: this.repoRoot,
          timeout: this.timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          env: {
            ...process.env,
            LUBBDUBB_ENVIRONMENT: request.environment,
            LUBBDUBB_ERROR_FINGERPRINT: request.fingerprint,
            LUBBDUBB_ERRORS_SINCE: request.since,
          },
        },
        (err, stdout, stderr) => {
          if (err !== null) return resolve({ ok: false, failure: failure(err as ExecFailure, stderr) });
          resolve(capDetailOutput(stdout));
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
    return `the detail query was killed after ${err.signal ?? 'timeout'}`;
  const why = firstLine(stderr);
  return `the detail query exited ${String(err.code ?? 'unknown')}: ${why ?? err.message}`;
}
