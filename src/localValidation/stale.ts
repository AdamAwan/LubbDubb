import type { LocalRun, LocalValidation } from '../types.js';

/**
 * Whether the environment a validation was pinned to is still the one that is up —
 * and if not, what happened to it, in words a person reads.
 *
 * **One predicate, three readers**, and that is the point of the module. The rule
 * asks it before dispatching, `local_validation_report` asks it before accepting a
 * reading, and `LocalValidationDesk.sweep` asks it before abandoning a row. Three
 * copies of "is this still the same environment" would be free to disagree, and the
 * disagreement that matters is the quiet one: a report accepted against a checkout
 * that has moved is a reading of code nobody asked about, filed under the goal as
 * though somebody had run the plan.
 *
 * Four things count as a different environment, and each of them really is one:
 *
 * - **Nothing is live.** The run was stopped, or it failed.
 * - **A different run.** A swap ends the old row and writes a new one, so the id
 *   changes even where the goal has not — an operator who stopped and restarted the
 *   same goal has a different environment in front of them, with whatever the
 *   restart picked up.
 * - **A different commit.** A refresh moves the checkout under a running server, so
 *   the id stands and the code does not. This is the arm a plain "is a run live"
 *   check would miss, and the one that produces the most confident wrong answer.
 * - **It is stopping.** A teardown in flight is an environment on its way out; a
 *   step run against it now is a step run against something half gone.
 *
 * Null means the pin holds. Anything else is the sentence to record or refuse with.
 */
export function validationRunStale(row: LocalValidation, live: LocalRun | null): string | null {
  if (live === null) return 'the local environment was stopped';
  if (live.id !== row.runId)
    return live.originRef === row.originRef
      ? 'the local environment was restarted, so this reading would be of a different run'
      : `the local environment was swapped to ${live.originRef}`;
  if (live.status === 'stopping') return 'the local environment is being taken down';
  // A null on either side is "nobody wrote it down" rather than "they match", and
  // the safe direction here is the one that refuses: a row or a run from before the
  // commit was recorded cannot vouch for what is checked out, and a validation is
  // the one thing that must not report on a checkout it cannot identify.
  if (row.commit === null || live.commit === null)
    return 'which commit the local environment stands at was never recorded, so this reading cannot be pinned to it';
  if (live.commit !== row.commit)
    return `the local environment was refreshed onto ${live.commit.slice(0, 7)}, and this was planned against ${row.commit.slice(0, 7)}`;
  return null;
}

/** The two statuses that mean nobody has answered yet — what a sweep and a second request read. */
export function localValidationIsOpen(row: LocalValidation): boolean {
  return row.status === 'pending' || row.status === 'dispatched';
}
