import type { GoalPause, Issue } from './types.js';
import { watchCascadeTargets } from './issueRelations.js';

// → docs/spec/06-issue-pickup.md

export function goalPauseOrigin(issueNumber: number): string {
  return `issue:${issueNumber}`;
}

export function pausedIssueNumbers(
  pauses: readonly GoalPause[],
  issues: readonly Issue[],
  containerTypes: readonly string[] | undefined,
): ReadonlySet<number> {
  const out = new Set<number>();
  if (pauses.length === 0) return out;
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  for (const pause of pauses) {
    const match = /^issue:(\d+)$/.exec(pause.originRef);
    if (match === null) continue;
    const number = Number(match[1]);
    const issue = byNumber.get(number);
    if (issue === undefined) {
      out.add(number);
      continue;
    }
    for (const target of watchCascadeTargets(issue, issues, containerTypes)) out.add(target);
  }
  return out;
}
