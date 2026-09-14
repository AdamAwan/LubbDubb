import { isOurPr } from './pr/prOwnership.js';
import { prState } from './pr/prHealth.js';
import type { PullRequest, TaskSummary } from './types.js';

// → docs/spec/09-execution.md

interface BranchReapInput {
  prNumber: number;
  branch: string;
}

export interface BranchReapContext {
  defaultBranch: string;
  prAuthorConfigured: boolean;
  tasks: TaskSummary[];
  reaped: ReadonlySet<number>;
}

export function reapableBranches(
  openPrs: PullRequest[],
  closedPrs: PullRequest[],
  ctx: BranchReapContext,
): BranchReapInput[] {
  const bases = new Set<string>([ctx.defaultBranch]);
  for (const pr of [...openPrs, ...closedPrs]) {
    if (prState(pr) === 'open' && pr.baseBranch !== undefined) bases.add(pr.baseBranch);
  }

  const out: BranchReapInput[] = [];
  for (const pr of closedPrs) {
    if (prState(pr) !== 'merged') continue;
    if (!isOurPr(pr, ctx.prAuthorConfigured)) continue;
    if (ctx.reaped.has(pr.number)) continue;
    if (bases.has(pr.branch)) continue;
    if (ctx.tasks.some((t) => t.branch === pr.branch && isActive(t.status))) continue;
    if (out.some((r) => r.branch === pr.branch)) continue;
    out.push({ prNumber: pr.number, branch: pr.branch });
  }
  return out;
}

function isActive(status: TaskSummary['status']): boolean {
  return status === 'queued' || status === 'running' || status === 'waiting';
}
