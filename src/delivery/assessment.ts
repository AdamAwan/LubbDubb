import type { TaskSummary } from '../types.js';
import { issueOriginRole } from '../issueOrigins.js';

// → docs/spec/24-environments.md

export function assessOrigin(issueNumber: number): string {
  return `issue:${issueNumber}:assess`;
}

export function assessIssueNumber(ref: string): number | null {
  const m = /^issue:(\d+):assess$/.exec(ref);
  return m === null ? null : Number(m[1]);
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
