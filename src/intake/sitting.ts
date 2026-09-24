import { issueOriginRef } from '../issueOrigins.js';
import type { GoalCriteriaVersion, Plan } from '../types.js';

// → docs/spec/08-planning.md#the-intake-sitting-stands-in-front-of-the-planner

/**
 * The goals whose intake sitting has closed, keyed by root origin — or null where
 * the reveal gate is off, which holds nothing at all.
 */
export type ClosedSittings = ReadonlySet<string> | null;

/** What the pulse hands the dispatcher: the closed sittings, and each goal's current criteria. */
export interface GoalIntake {
  closedSittings: ClosedSittings;
  criteria: GoalCriteriaVersion[];
}

export const SITTING_REASON = 'awaiting your prediction and criteria';

/**
 * Whether the goal's planner waits on its sitting. Only a goal with no plan row: a
 * replan is not a first sight of the goal, and one planned before its sitting meets
 * the reveal gate instead.
 */
export function sittingHolds(closed: ClosedSittings | undefined, issueNumber: number, plan: Plan | null): boolean {
  if (closed === null || closed === undefined) return false;
  if (plan !== null) return false;
  return !closed.has(issueOriginRef('root', issueNumber));
}
