import { createHash } from 'node:crypto';
import type { Issue, IssueAppraisal, TaskSummary } from '../types.js';
import { hasPriorWork } from '../delivery/assessment.js';
import { issueOriginRef } from '../issueOrigins.js';

// → docs/spec/06-issue-pickup.md

export function appraisalOrigin(issueNumber: number): string {
  return issueOriginRef('appraisal', issueNumber);
}

export function appraisalBranch(issueNumber: number): string {
  return `appraisal/issue/${issueNumber}`;
}

export function goalFingerprint(title: string | null, body: string | null): string {
  return createHash('sha256')
    .update(`${title ?? ''}\u0000${body ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}

export function appraisalHold(appraisal: IssueAppraisal | null, issue: Issue): string | null {
  if (!appraisal) return null;
  if (appraisal.goalRef !== goalFingerprint(issue.title, issue.body)) return null;

  if (appraisal.verdict === 'unclear') return unclearHold(appraisal);
  if (appraisal.proposedProfile !== null && appraisal.profileAnsweredAt === null)
    return `the goal appraisal proposes running this on "${appraisal.proposedProfile}"`;
  return null;
}

function unclearHold(appraisal: IssueAppraisal): string {
  const by = appraisal.by === 'operator' ? 'you' : 'the goal appraisal';
  return `${by} could not act on this goal`;
}

export function hasWorkStarted(issueNumber: number, tasks: TaskSummary[]): boolean {
  return hasPriorWork(issueNumber, tasks);
}

export function isAppraised(appraisal: IssueAppraisal | null, issue: Issue): boolean {
  return appraisal !== null && appraisal.goalRef === goalFingerprint(issue.title, issue.body);
}
