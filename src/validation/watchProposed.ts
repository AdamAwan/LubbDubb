import type { GoalWatch } from '../types.js';

// → docs/spec/29-post-deploy-watch.md#the-operator-accepts-the-set

/** A check in the assessor's set the operator has not accepted yet — the only kind that is not live. */
export function isProposed(check: Pick<GoalWatch, 'live'>): boolean {
  return !check.live;
}
