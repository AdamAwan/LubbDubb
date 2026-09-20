import type { GoalPause, Issue } from './types.js';
import { issueOriginNumber, issueOriginRef } from './issueOrigins.js';
import { cascadeToChildren } from './issueRelations.js';

// → docs/spec/06-issue-pickup.md

export function goalPauseOrigin(issueNumber: number): string {
  return issueOriginRef('root', issueNumber);
}

export function pausedIssueNumbers(
  pauses: readonly GoalPause[],
  issues: readonly Issue[],
  containerTypes: readonly string[] | undefined,
): ReadonlySet<number> {
  return cascadeToChildren(markedNumbers(pauses), issues, containerTypes);
}

/** The issue numbers a list of standing marks names, dropping any whose origin is not a goal root. */
export function markedNumbers(marks: readonly { originRef: string }[]): number[] {
  const out: number[] = [];
  for (const mark of marks) {
    const number = issueOriginNumber('root', mark.originRef);
    if (number !== null) out.push(number);
  }
  return out;
}
