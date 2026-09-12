import { issueOriginId, issueOriginRef } from '../issueOrigins.js';
import type { PullRequest } from '../types.js';

// → docs/spec/07-pull-requests.md#how-wide-a-pull-request-is

interface PrBreadth {
  files: number;
  over: boolean;
}

export function prBreadth(pr: PullRequest, budget: number): PrBreadth | null {
  if (budget <= 0) return null;
  if (pr.changedFiles === undefined) return null;
  return { files: pr.changedFiles, over: pr.changedFiles > budget };
}

export function splitOrigin(issueNumber: number, prNumber: number): string {
  return issueOriginRef('split', issueNumber, prNumber);
}

export function splitBranch(prNumber: number): string {
  return `split/pr/${prNumber}`;
}

export function splitTargetPr(originRef: string | null): number | null {
  const split = issueOriginId('split', originRef);
  return split === null ? null : Number(split.id);
}

export function budgetNote(budget: number): string {
  if (budget <= 0) return '';
  return (
    `\n\nHow wide this should be: a pull request past **${budget} changed files** is where this fleet stops and ` +
    `asks whether it is one piece of work or several. That is a prompt to look, never a limit to obey — a ` +
    `rename across forty files is one concept and belongs in one pull request, and twelve files spanning a ` +
    `schema change, a new endpoint and a refactor is three. If what you are building is going to run past ` +
    `that and you can see the seam, say so now rather than after the diff exists.`
  );
}
