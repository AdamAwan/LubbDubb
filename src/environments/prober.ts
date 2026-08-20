import { exec } from 'node:child_process';
import type { EnvironmentReachStatus } from '../types.js';

/** A probe's answer, and why when it could not give one. */
export interface EnvironmentVerdict {
  status: EnvironmentReachStatus;
  detail: string | null;
}

/**
 * Asks one environment whether it has one commit.
 *
 * A seam because the answer has no generic form: an environment is a git ref on one
 * deployment, an HTTP endpoint reporting its own build on another, and on a third a
 * question about several services at once that no single SHA describes. So the
 * harness ships no opinion and runs the operator's command.
 * → `docs/spec/24-environments.md#the-probe`
 */
export interface EnvironmentProber {
  reached(environment: string, command: string, sha: string): Promise<EnvironmentVerdict>;
}

/** How long a probe may run before it is killed and reported `unknown`. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The real prober: the operator's command, in a shell, in the repo root.
 *
 * **The commit is passed in the environment, never interpolated into the command.**
 * A `{commit}` placeholder is the prompt-template mistake in another costume — an
 * operator's command that never learned about the token silently probes nothing and
 * answers about whatever the bare command means, which is a confident wrong answer
 * rather than an error. `LUBBDUBB_COMMIT` has no fallback to get wrong: a command
 * that ignores it is a command the operator wrote to ignore it.
 *
 * The exit code is the contract, and it has three answers, not two:
 *
 * - `0` — the commit is there. Unambiguous on every platform: a shell that could
 *   not start the command never exits 0.
 * - `1` **with nothing on stderr** — it is not there.
 * - anything else, a signal, a timeout, or a `1` that came with a complaint —
 *   **`unknown`**, with the reason kept.
 *
 * Folding the third case into "not there" is the failure this whole type is shaped
 * around: an expired credential, a missing binary and a genuine not-yet-deployed all
 * exit non-zero, and only one of them is about deployment. Read as `absent` they are
 * indistinguishable on the glass, and the cockpit states, in the operator's words,
 * that the work has not shipped — for a reason that has nothing to do with shipping.
 *
 * **The stderr clause is why `1` alone is not enough.** `cmd.exe` exits **1** for a
 * command it cannot find — the same code `git merge-base --is-ancestor` uses for a
 * clean no — so on Windows the exit code by itself cannot tell a missing binary from
 * a commit that has not shipped. What separates them is that the failure explains
 * itself and the answer does not. A probe that legitimately answers "no" while
 * warning about something is read as `unknown` and asked again, which is the safe
 * direction and is fixed by redirecting the warning.
 * → `docs/spec/24-environments.md#the-three-verdicts`
 */
export class CommandEnvironmentProber implements EnvironmentProber {
  constructor(
    private readonly repoRoot: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  reached(environment: string, command: string, sha: string): Promise<EnvironmentVerdict> {
    return new Promise((resolve) => {
      exec(
        command,
        {
          cwd: this.repoRoot,
          timeout: this.timeoutMs,
          windowsHide: true,
          env: { ...process.env, LUBBDUBB_COMMIT: sha, LUBBDUBB_ENVIRONMENT: environment },
        },
        (err, _stdout, stderr) => {
          if (err === null) return resolve({ status: 'reached', detail: null });
          resolve(classify(err as ExecFailure, stderr));
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

function classify(err: ExecFailure, stderr: string): EnvironmentVerdict {
  // A timeout kills the child, so it arrives as a signal rather than an exit code —
  // and it is the case most likely to be mistaken for "no": a probe that hung is a
  // probe that said nothing.
  if (err.killed === true || (err.signal !== null && err.signal !== undefined))
    return { status: 'unknown', detail: `probe killed after ${err.signal ?? 'timeout'}` };
  const why = firstLine(stderr);
  // A bare 1 is the only "no" there is, and only when the command had nothing to
  // say. See the class comment: on Windows a missing binary exits 1 too, and the
  // complaint it prints is the whole of what distinguishes the two.
  if (err.code === 1 && why === null) return { status: 'absent', detail: null };
  return { status: 'unknown', detail: `exit ${String(err.code ?? 'unknown')}: ${why ?? err.message}` };
}

function firstLine(text: string): string | null {
  const line = text.split('\n').find((l) => l.trim() !== '');
  return line === undefined ? null : line.trim().slice(0, 200);
}
