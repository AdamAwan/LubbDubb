import type { Issue, PlanPart, PullRequest } from '../types.js';
import { issueBranch } from '../dispatcher/issuePickup.js';
import { liveParts, partBranch, partSettled } from './parts.js';

// → docs/spec/08-planning.md

function isMoving(part: PlanPart): boolean {
  return part.status === 'ready' || part.status === 'dispatched' || part.status === 'in_review';
}

export function planIsWedged(parts: PlanPart[]): boolean {
  const live = liveParts(parts);
  if (live.length === 0) return false;
  if (!live.some((p) => p.status === 'blocked')) return false;
  if (live.some(isMoving)) return false;
  return live.some((p) => !partSettled(p) && (p.status !== 'blocked' || p.blockedBy !== 'declined'));
}

export function wedgeReasons(parts: PlanPart[]): string[] {
  const seen = new Set<string>();
  for (const part of liveParts(parts)) if (part.blockedReason) seen.add(part.blockedReason);
  return [...seen];
}

export function unclaimedIssuePrs(issue: Issue, parts: PlanPart[], openPrs: PullRequest[]): PullRequest[] {
  const flat = issueBranch(issue.number);
  const live = liveParts(parts);
  const claimed = (pr: PullRequest): boolean =>
    live.some((p) => p.prNumber === pr.number || pr.branch === (p.branch ?? partBranch(issue.number, p.slug)));
  return openPrs.filter(
    (pr) => !pr.merged && !claimed(pr) && (pr.branch === flat || pr.number === issue.linkedPrNumber),
  );
}

export function wedgedPlanPrompt(issueNumber: number, issue: Issue, parts: PlanPart[], openPrs: PullRequest[]): string {
  const live = liveParts(parts);
  const outstanding = live.filter((p) => !partSettled(p));
  const blocked = outstanding.filter((p) => p.status === 'blocked');
  const clearable = blocked.some((p) => p.blockedBy !== 'declined');
  const stranded = outstanding.filter((p) => p.status !== 'blocked');
  const prs = unclaimedIssuePrs(issue, parts, openPrs).map(
    (pr) =>
      `\n\nPR #${pr.number} ("${pr.title}") is open on ${pr.branch} and belongs to no part of this plan. While it ` +
      `is open the branch cannot be deleted, so it has to be merged or abandoned first — and nothing here knows ` +
      `which part, if any, it satisfies.`,
  );
  const shape =
    stranded.length === 0
      ? `every one of its parts is blocked`
      : `${blocked.length} of its ${outstanding.length} unfinished parts ` +
        `${blocked.length === 1 ? 'is' : 'are'} blocked and nothing else is moving`;
  const wayOut = clearable
    ? `\n\nTwo ways out, and the harness will not choose between them: clear what is blocking the parts and they ` +
      `start on the next pulse, or Replan from the plan sheet and let a planner cut the work somewhere the branch ` +
      `is free.`
    : `\n\nThere is no branch to clear here — the block is a step you declined, and declining it was a decision, ` +
      `not a fault. The way out is Replan from the plan sheet, cutting the work so nothing depends on the step ` +
      `you refused, or abandoning the decomposition to work the issue whole.`;
  return (
    `The approved ${live.length}-part plan for issue #${issueNumber} ("${issue.title}") is not running: ${shape}, ` +
    `so no agent has been dispatched and none will be.` +
    wedgeReasons(parts)
      .map((r) => ` ${r}`)
      .join('') +
    prs.join('') +
    wayOut
  );
}
