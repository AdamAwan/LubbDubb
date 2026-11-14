import { ERRORS_COMMAND_TIMEOUT_MS, runErrorsCommand } from './command.js';
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

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export class CommandAppErrorReader implements AppErrorReader {
  constructor(
    private readonly repoRoot: string,
    private readonly timeoutMs: number = ERRORS_COMMAND_TIMEOUT_MS,
  ) {}

  async list(request: AppErrorReadRequest): Promise<AppErrorReport> {
    const out = await runErrorsCommand({
      label: 'the errors command',
      command: request.command,
      env: { LUBBDUBB_ENVIRONMENT: request.environment, LUBBDUBB_ERRORS_SINCE: request.since },
      repoRoot: this.repoRoot,
      timeoutMs: this.timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    if (!out.ok) return unreadableErrors(out.failure);
    if (out.overflowed) return unreadableErrors('the errors command printed more than 16 MiB and was stopped');
    return parseAppErrorReport(out.stdout);
  }
}
