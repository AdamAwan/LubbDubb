import { ERRORS_COMMAND_TIMEOUT_MS, runErrorsCommand } from './command.js';
import { readSince } from './groups.js';
import { errorsCommand } from './report.js';

// → docs/spec/39-app-errors.md#the-detail-query

export const FINGERPRINT_TOKEN = '{fingerprint}';

export const MAX_DETAIL_OUTPUT_CHARS = 32_000;

/** What is captured before the query is stopped: a few times the cap, so trimming still leaves a full cap. */
const MAX_OUTPUT_CHARS = 4 * MAX_DETAIL_OUTPUT_CHARS;

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

export function detailRequest(input: {
  environment: string;
  detail: string;
  fingerprint: string;
  firstSeen: string | null;
  now: number;
}): AppErrorDetailRequest {
  const since = readSince(input.firstSeen, input.now);
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
    private readonly timeoutMs: number = ERRORS_COMMAND_TIMEOUT_MS,
  ) {}

  async detail(request: AppErrorDetailRequest): Promise<AppErrorDetailOutput> {
    const out = await runErrorsCommand({
      label: 'the detail query',
      command: request.command,
      env: {
        LUBBDUBB_ENVIRONMENT: request.environment,
        LUBBDUBB_ERROR_FINGERPRINT: request.fingerprint,
        LUBBDUBB_ERRORS_SINCE: request.since,
      },
      repoRoot: this.repoRoot,
      timeoutMs: this.timeoutMs,
      maxBuffer: MAX_OUTPUT_CHARS,
    });
    if (!out.ok) return out;
    const capped = capDetailOutput(out.stdout);
    return capped.ok && out.overflowed ? { ...capped, truncated: true } : capped;
  }
}
