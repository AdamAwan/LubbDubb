import { exec } from 'node:child_process';
import { idProjection, parseWatchResult, unanswered, type WatchQueryKind, type WatchResult } from './watchResult.js';

/** One question, put to one environment. */
export interface EnvironmentObservationRequest {
  /** The environment's name, as `LUBBDUBB_ENVIRONMENT`. */
  environment: string;
  /** The operator's `observe` command for that environment. */
  command: string;
  /** The check's id — as `LUBBDUBB_WATCH_ID`, and as the echo the result must carry back. */
  checkId: string;
  /** The declared query. Handed over in `LUBBDUBB_WATCH_QUERY`, never interpolated into the command. */
  query: string;
  kind: WatchQueryKind;
}

/**
 * Asks one environment a declared question.
 *
 * A seam beside {@link EnvironmentProber} and for its reason: telemetry has no
 * generic form. Application Insights is one answer; the harness holds no opinion,
 * ships no SDK, and runs the operator's command.
 * → `docs/spec/29-post-deploy-watch.md#asking-the-environment`
 */
export interface EnvironmentObserver {
  observe(request: EnvironmentObservationRequest): Promise<WatchResult>;
}

/** How long a reading may run before it is killed. The kill answers nothing. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The real observer: the operator's `observe` command, in a shell, in the repo
 * root — exactly as {@link CommandEnvironmentProber} runs `at`.
 *
 * **The query is passed by environment variable and never interpolated into the
 * command string.** Two things ride on that, and both are load-bearing: an
 * agent-authored query reaches the shell as a variable's *value* rather than as
 * syntax, and a placeholder an operator's command never learned about cannot be
 * dropped, because there is no placeholder.
 *
 * **The result is refused unless it carries the check's id back.** The projection
 * goes out with the query ({@link idProjection}); a wrapper script that ignores
 * the variable and runs something hardcoded therefore fails loudly on its first
 * reading, where a dropped parameter would have answered confidently and wrongly
 * forever. That guard lives here rather than in a caller so no caller can be
 * written that skips it.
 */
export class CommandEnvironmentObserver implements EnvironmentObserver {
  constructor(
    private readonly repoRoot: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  observe(request: EnvironmentObservationRequest): Promise<WatchResult> {
    return new Promise((resolve) => {
      exec(
        request.command,
        {
          cwd: this.repoRoot,
          timeout: this.timeoutMs,
          windowsHide: true,
          env: {
            ...process.env,
            LUBBDUBB_ENVIRONMENT: request.environment,
            LUBBDUBB_WATCH_ID: request.checkId,
            LUBBDUBB_WATCH_QUERY: idProjection(request.query, request.checkId),
          },
        },
        (err, stdout, stderr) => {
          if (err !== null) return resolve(failure(err as ExecFailure, stderr));
          resolve(parseWatchResult(stdout, request.checkId, request.kind));
        },
      );
    });
  }
}

/** What `exec` reports a failure as — a code, or a signal when it was killed. */
interface ExecFailure extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
}

function failure(err: ExecFailure, stderr: string): WatchResult {
  // A timeout kills the child, so it arrives as a signal rather than an exit code
  // — and it is the case most likely to be mistaken for an answer: an observation
  // that hung is an observation that said nothing.
  if (err.killed === true || (err.signal !== null && err.signal !== undefined))
    return unanswered(`the observation was killed after ${err.signal ?? 'timeout'}`);
  const why = firstLine(stderr);
  return unanswered(`the observation exited ${String(err.code ?? 'unknown')}: ${why ?? err.message}`);
}

function firstLine(text: string): string | null {
  const line = text.split('\n').find((l) => l.trim() !== '');
  return line === undefined ? null : line.trim().slice(0, 200);
}
