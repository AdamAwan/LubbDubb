import type { Store } from '../store/store.js';
import type { ValidationVerdict } from '../types.js';
import { outstandingChecks, validationVerdict } from './verdict.js';

// → docs/spec/20-validation.md

export interface GoalValidation {
  verdict: ValidationVerdict;
  outstanding: string[];
}

export function goalValidation(store: Store, originRef: string): GoalValidation | null {
  const checks = store.listValidationChecks(originRef);
  if (checks.length === 0) return null;
  return { verdict: validationVerdict(checks), outstanding: outstandingChecks(checks) };
}
