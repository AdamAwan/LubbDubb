import type { ValidationCheck, ValidationVerdict } from '../types.js';

/**
 * Whether a goal's validation plan is settled. Pure, and the one answer — the
 * sheet, the goal row, the close-out obligation and the ticket comment all read
 * it, so none of them can have an opinion of its own about what "clear" means.
 *
 * **`unrun` is weighted like `failed`, and that is the point.** A failed check is
 * loud already; with every check the operator's by default, the realistic failure
 * is the set nobody got to. Counting silence as a finding is the same refusal
 * `undeclared` makes about a conclusion nobody declared: a verdict nobody cast is
 * not a verdict.
 *
 * **`deferred` counts as not clear, and that is the guard.** Deferral takes a
 * check out of today's work; letting it also take the check out of the count
 * would make it the quiet exit that `unrun` is loud about. Only `waived` — said
 * out loud, with a reason, as a decision not to check — clears.
 *
 * A plan with no checks is `clear` with a total of zero. That is not a
 * dispensation: nothing was declared, so nothing is outstanding, and every
 * deployment that has not written a validation plan behaves exactly as it did.
 */
export function validationVerdict(checks: readonly ValidationCheck[]): ValidationVerdict {
  // Live only. A superseded check is kept for its record, and counting a result
  // nobody is being asked for any more would flag a goal over a check its own
  // plan withdrew.
  const live = liveChecks(checks);
  const count = (state: ValidationCheck['state']): number => live.filter((c) => c.state === state).length;
  const passed = count('passed');
  const waived = count('waived');
  return {
    state: passed + waived === live.length ? 'clear' : 'flagged',
    total: live.length,
    passed,
    failed: count('failed'),
    unrun: count('unrun'),
    deferred: count('deferred'),
    waived,
  };
}

/** The checks a plan is still asking for — everything an amendment has not withdrawn. */
export function liveChecks(checks: readonly ValidationCheck[]): ValidationCheck[] {
  return checks.filter((c) => c.supersededReason === null);
}

/**
 * What a flagged goal owes, one line per outstanding check, for the close-out
 * obligation and the ticket comment.
 *
 * Reasons are carried through rather than summarised: "deferred — the test
 * environment is rebuilt on Thursday" is the sentence that stops a reader
 * treating the flag as noise, and a bare count is exactly what would.
 */
export function outstandingChecks(checks: readonly ValidationCheck[]): string[] {
  return liveChecks(checks)
    .filter((c) => c.state !== 'passed' && c.state !== 'waived')
    .map((c) => {
      const why = c.resultNote === null ? '' : ` — ${c.resultNote}`;
      return `${c.letter}. **${c.title}** — ${c.state}${why}${amendmentCost(c)}${whoOwesIt(c)}`;
    });
}

/**
 * Whether this check is waiting on the fleet or has come back from it, said on
 * the same line for {@link amendmentCost}'s reason: this is read by somebody
 * about to close a goal, and a bare `unrun` is the same word for "nobody has
 * got to it", "an agent is about to" and "an agent tried and could not".
 *
 * The hand-back is the sharper of the two, and it is why the note is quoted
 * rather than summarised: it is usually the one sentence that says what a person
 * would have to do that an agent could not.
 *
 * In flight is read *before* the note, and that ordering is what lets the note
 * survive a re-hand-over: the next dispatch is briefed with it
 * ([20](../../docs/spec/20-validation.md)), so the row must be able to carry a
 * reason for a check that is with the fleet again without describing the wrong
 * attempt. What stops the note being drawn is the check being in flight; what
 * clears it is the next reading.
 */
function whoOwesIt(check: ValidationCheck): string {
  if (check.actor === 'fleet') return ' (handed to the fleet)';
  // `handbackReason` already opens with who gave it up — "An agent" or "A desktop
  // session" — and the two mean different things to the person reading the row,
  // so naming the fleet here would relabel half of them as the other.
  if (check.handbackNote !== null) return ` (handed back — ${check.handbackNote})`;
  return '';
}

/**
 * What an amendment cost this check, said on the line rather than left to the
 * cockpit.
 *
 * Only when a reading was actually withdrawn — an amendment to a check nobody had
 * run took nothing away, and a goal is not owed a sentence about it. This is where
 * "the plan changed under you" reaches somebody who is not at the cockpit: the
 * close-out obligation and the ticket comment are read by a person about to close
 * a goal, and "unrun" alone would look like a check they simply never got to.
 */
function amendmentCost(check: ValidationCheck): string {
  const withdrawn = check.revision?.state;
  return withdrawn == null ? '' : ` (amended since you recorded **${withdrawn}** — the wording changed)`;
}
