import { issueForPr } from './prIssue.js';
import { isOurPr } from './prOwnership.js';
import { prState } from './prHealth.js';
import type { Issue, PullRequest } from './types.js';

// → docs/spec/07-pull-requests.md

export interface WorkItemLinkSeed {
  prNumber: number;
  workItemNumber: number;
}

interface PrWorkItemLinkContext {
  prAuthorConfigured: boolean;
  issues: Issue[];
  linked: ReadonlySet<number>;
}

export function prsToLinkWorkItem(prs: PullRequest[], ctx: PrWorkItemLinkContext): WorkItemLinkSeed[] {
  const out: WorkItemLinkSeed[] = [];
  for (const pr of prs) {
    if (prState(pr) !== 'open') continue;
    if (!isOurPr(pr, ctx.prAuthorConfigured)) continue;
    if (ctx.linked.has(pr.number)) continue;

    const issue = issueForPr(pr, ctx.issues);
    if (!issue) continue;
    if (issue.linkedPrNumber === pr.number) continue;

    out.push({ prNumber: pr.number, workItemNumber: issue.number });
  }
  return out;
}
