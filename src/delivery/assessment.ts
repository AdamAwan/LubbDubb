import type { TaskSummary } from '../types.js';
import { issueOriginNumber, issueOriginRef, issueOriginRole } from '../issueOrigins.js';

// → docs/spec/24-environments.md

export function assessOrigin(issueNumber: number): string {
  return issueOriginRef('assess', issueNumber);
}

export function assessIssueNumber(ref: string): number | null {
  return issueOriginNumber('assess', ref);
}

export function assessBranch(issueNumber: number): string {
  return `assess/issue/${issueNumber}`;
}

export function hasPriorWork(issueNumber: number, tasks: TaskSummary[]): boolean {
  return tasks.some((t) => {
    const role = issueOriginRole(issueNumber, t.originRef);
    return role === 'work' || role === 'evidence';
  });
}
