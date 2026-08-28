import { exec } from 'node:child_process';

/**
 * Asks something **outside the harness** whether a pull request has already been
 * reviewed.
 *
 * The gap it closes: `pr_reviews` answers "has the *fleet* read this", which is
 * the only question the harness can answer on its own — and on a team that
 * already has a reviewer, that is the wrong question. An Azure branch policy with
 * a required approver, a review bot, another org's gate: each of those is a read
 * that happened, and the fleet spending an agent on the same diff is a second
 * opinion nobody asked for and a merge held for a review that is already done.
 *
 * **A command, because there is no generic form** — {@link
 * EnvironmentHealthProber}'s reason exactly. "Already reviewed" is a policy
 * evaluation on one deployment, a label on another, and on a third a script that
 * asks two systems. So the harness ships no opinion and runs the operator's
 * command, with the pull request's number in the environment.
 *
 * **The verdict is three-valued, and `unknown` must never fold into `reviewed`.**
 * A command that is missing, times out or dies is indistinguishable from one that
 * says "no" *by exit code alone* — but they are not the same fact, and folding
 * either into "already reviewed" would silently switch the whole fleet review off
 * on exactly the deployments whose gate broke. So `unknown` acts as `not
 * reviewed`: the fleet reads the pull request, which is the fail-open direction
 * the triage and the appraiser already take, and the failure is recorded rather
 * than swallowed.
 * → `docs/spec/07-pull-requests.md#a-review-that-happened-somewhere-else`
 */

/**
 * What the command said, on the three terms above.
 *
 * `reviewed` is the only one that stands a pull request down, and the only one
 * that is recorded — see `PrReviewExternalStore`. The other two are re-asked next
 * pulse, because a gate that has not passed yet may pass later.
 */
export type ReviewedElsewhere = 'reviewed' | 'not-reviewed' | 'unknown';

/** What could not be said, for the error log. Null on either verdict that answered. */
export interface ReviewedElsewhereReport {
  verdict: ReviewedElsewhere;
  detail: string | null;
}

export interface ReviewProber {
  /** Ask about one pull request. Never throws: a failure is the `unknown` verdict. */
  check(prNumber: number, command: string): Promise<ReviewedElsewhereReport>;
}

/** How long the command may run before it is killed. The kill answers nothing. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The real one: the operator's command, in a shell, in the repo root, with
 * `LUBBDUBB_PR` set to the pull request's number — the one thing the command
 * needs and, as with the environment probes, nothing else passed in, so what a
 * script may depend on is a short list an operator can hold in their head.
 *
 * **The exit code is the answer**, which is the whole point of the shape: the
 * thing an operator reaches for here is a pipeline of tools that already exit 0
 * for yes — `az repos pr policy list … | grep -q approved`, a `gh` query, a
 * `curl -f`. A stdout contract would mean writing a wrapper around every one of
 * them, and a wrapper is where the mistakes go.
 *
 * A clean non-zero exit is a real **no**. Only a kill or a shell that never ran
 * the command is `unknown`, and the two are told apart by how `exec` reports it: a
 * timeout arrives as a signal, and it is the case most likely to be mistaken for
 * an answer, because a check that hung is a check that said nothing.
 */
export class CommandReviewProber implements ReviewProber {
  constructor(
    private readonly repoRoot: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  check(prNumber: number, command: string): Promise<ReviewedElsewhereReport> {
    return new Promise((resolve) => {
      exec(
        command,
        {
          cwd: this.repoRoot,
          timeout: this.timeoutMs,
          windowsHide: true,
          env: { ...process.env, LUBBDUBB_PR: String(prNumber) },
        },
        (err, _stdout, stderr) => {
          if (err === null) return resolve({ verdict: 'reviewed', detail: null });
          const failure = err as ExecFailure;
          // Killed, or the shell could not run it at all. Either way nothing was
          // said, and saying "already reviewed" for it would switch the fleet
          // review off on the deployments whose gate broke.
          if (failure.killed === true || (failure.signal !== null && failure.signal !== undefined)) {
            return resolve({
              verdict: 'unknown',
              detail: `the check was killed after ${failure.signal ?? 'timeout'}`,
            });
          }
          if (failure.code === undefined || typeof failure.code === 'string') {
            return resolve({
              verdict: 'unknown',
              detail: `the check could not be run: ${firstLine(stderr) ?? failure.message}`,
            });
          }
          // A clean non-zero exit is the command answering "no". `grep -q` with no
          // match is exit 1, which is the most common shape of that answer.
          return resolve({ verdict: 'not-reviewed', detail: null });
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

function firstLine(text: string): string | null {
  const line = text.split('\n').find((l) => l.trim() !== '');
  return line === undefined ? null : line.trim().slice(0, 200);
}
