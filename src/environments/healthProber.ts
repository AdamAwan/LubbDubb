import { exec } from 'node:child_process';
import { parseHealthReport, unreadable, type EnvironmentHealthReport } from './health.js';

/**
 * Asks one environment whether it is **well**.
 *
 * A seam beside {@link EnvironmentProber} and {@link EnvironmentObserver}, for
 * their reason: health has no generic form. It is a pipeline's last result on one
 * deployment, a `/healthz` on another, and on a third a script that checks six
 * services and a search index. So the harness ships no opinion and runs the
 * operator's command.
 * → `docs/spec/24-environments.md#is-the-environment-well`
 */
export interface EnvironmentHealthProber {
  check(environment: string, command: string): Promise<EnvironmentHealthReport>;
}

/** How long a health check may run before it is killed. The kill answers nothing. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The real one: the operator's command, in a shell, in the repo root, with
 * `LUBBDUBB_ENVIRONMENT` set — exactly as {@link CommandEnvironmentProber} runs
 * `at`, and with nothing else passed in for that command's reason.
 *
 * **The report is read from stdout whatever the exit code**, and that is the one
 * place this differs from its two neighbours. A health script that says
 * `NotHealthy` and exits 1 is the shape half the world already writes — `set -e`,
 * a `curl -f`, a pipeline task's own convention — and refusing it would turn every
 * real outage into `unknown` on exactly the deployments whose script works. The
 * exit code is consulted only when stdout said nothing the harness could read, and
 * then it is the better account of the silence: `exit 127: command not found`
 * rather than "did not answer with JSON".
 */
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
          // `detail` is non-null only for the parse's own refusals, so a check that
          // declared `unknown` itself keeps its own account and its own reasons —
          // it answered, and what it answered was that it could not tell.
          if (err === null || report.detail === null) return resolve(report);
          resolve(unreadable(failure(err as ExecFailure, stderr)));
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

function failure(err: ExecFailure, stderr: string): string {
  // A timeout kills the child, so it arrives as a signal rather than an exit code
  // — and it is the case most likely to be mistaken for an answer: a check that
  // hung is a check that said nothing.
  if (err.killed === true || (err.signal !== null && err.signal !== undefined))
    return `the health check was killed after ${err.signal ?? 'timeout'}`;
  const why = firstLine(stderr);
  return `the health check exited ${String(err.code ?? 'unknown')}: ${why ?? err.message}`;
}

function firstLine(text: string): string | null {
  const line = text.split('\n').find((l) => l.trim() !== '');
  return line === undefined ? null : line.trim().slice(0, 200);
}
