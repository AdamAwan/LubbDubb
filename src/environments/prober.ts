import { exec } from 'node:child_process';

/**
 * What an environment answered when asked where it is: the commits it named, or
 * null when it could not say.
 *
 * The two-valued shape is deliberate, and it is the whole simplification this
 * probe bought. The old contract asked "do you have this commit" and had to read
 * a *third* answer out of an exit code — which is where the Windows `cmd.exe`
 * problem lived, because a missing binary and a clean no both exit 1. An
 * environment naming its own commit has nothing to say no *about*: either it
 * answered or it did not, and whether a landing is in it is a question for the
 * clone. → `docs/spec/24-environments.md#the-probe`
 */
export interface EnvironmentHead {
  /** The commits this environment is at, or null when the probe could not answer. */
  commits: string[] | null;
  /** Why, for a null — the exit code, the signal, or the stderr's first line. */
  detail: string | null;
}

/**
 * Asks one environment where it is.
 *
 * A seam because the answer has no generic form: an environment is a git ref on
 * one deployment, a pipeline's last successful `sourceVersion` on another, and on
 * a third a question about several services at once. So the harness ships no
 * opinion and runs the operator's command.
 */
export interface EnvironmentProber {
  at(environment: string, command: string): Promise<EnvironmentHead>;
}

/** How long a probe may run before it is killed and reported unanswered. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The real prober: the operator's command, in a shell, in the repo root.
 *
 * **Nothing about a commit is passed in.** The command is asked where the
 * environment is, not whether it holds something — so there is no `LUBBDUBB_COMMIT`
 * to be ignored and no `{commit}` placeholder for an override to have never
 * learned about. That whole class of silently-answering-the-wrong-question is
 * gone with the parameter.
 *
 * **Exit 0 with at least one token is the only answer there is.** Anything else —
 * a non-zero exit, a signal, a timeout, or a command that printed nothing — is the
 * probe failing to answer, which every landing then reads as `unknown` rather than
 * as not-deployed. An expired credential, a missing binary and an environment
 * holding nothing are all indistinguishable here, and only the last is about
 * deployment: reported as `absent` they would state, in the operator's own words,
 * that the work has not shipped for a reason that has nothing to do with shipping.
 *
 * Output is split on whitespace and every token has to resolve to a commit later,
 * so a command that prints a sentence answers nothing rather than answering
 * loosely. Several tokens is several services, and the laggard governs
 * ({@link GitObserver.contains}).
 */
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
          // A silent success is the case worth naming: a pipeline query with no
          // successful run prints nothing and exits 0, which is the same output a
          // broken query gives. Unanswered is the direction that gets asked again.
          if (commits.length === 0)
            return resolve({ commits: null, detail: 'the probe named no commit — it exited 0 and printed nothing' });
          resolve({ commits, detail: null });
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

function failure(err: ExecFailure, stderr: string): EnvironmentHead {
  // A timeout kills the child, so it arrives as a signal rather than an exit code
  // — and it is the case most likely to be mistaken for an answer: a probe that
  // hung is a probe that said nothing.
  if (err.killed === true || (err.signal !== null && err.signal !== undefined))
    return { commits: null, detail: `probe killed after ${err.signal ?? 'timeout'}` };
  const why = firstLine(stderr);
  return { commits: null, detail: `exit ${String(err.code ?? 'unknown')}: ${why ?? err.message}` };
}

function firstLine(text: string): string | null {
  const line = text.split('\n').find((l) => l.trim() !== '');
  return line === undefined ? null : line.trim().slice(0, 200);
}
