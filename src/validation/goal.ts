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
 * Keyed through the plan rather than against the origin directly, because a plan
 * *is* the per-goal record the checks hang off.
 */
export function goalValidation(store: Store, originRef: string): GoalValidation | null {
  const plan = store.getPlanByOrigin(originRef);
  if (!plan) return null;
  const checks = store.listValidationChecks(plan.id);
  if (checks.length === 0) return null;
  return { verdict: validationVerdict(checks), outstanding: outstandingChecks(checks) };
}
