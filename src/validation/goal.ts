import type { Store } from '../store/store.js';
import type { ValidationVerdict } from '../types.js';
import { outstandingChecks, validationVerdict } from './verdict.js';

/** A goal's validation plan as everything that reads one needs it: the count, and the sentences. */
export interface GoalValidation {
  verdict: ValidationVerdict;
  outstanding: string[];
}

/**
 * One goal's validation verdict, or null when it has no checks.
 *
 * The single store round trip in front of {@link validationVerdict}, so the close-out
 * obligation, the two routes that guard closing a goal and the ticket comment all
 * reach the verdict the same way. Null is "nothing was declared", which is a third
 * reading and not a synonym for clear — a caller that flagged on it would flag
 * every deployment that has never written a validation plan.
 *
 * Read straight off the goal — the checks are keyed on it, so there is no plan to
 * look up and no plan-shaped way for this to disagree with what the sheet draws.
 */
export function goalValidation(store: Store, originRef: string): GoalValidation | null {
  const checks = store.listValidationChecks(originRef);
  if (checks.length === 0) return null;
  return { verdict: validationVerdict(checks), outstanding: outstandingChecks(checks) };
}
