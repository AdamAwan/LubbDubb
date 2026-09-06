import { isWatched } from './watchLabels.js';
import type { CiCheck, PrState, PullRequest } from './types.js';

// → docs/spec/07-pull-requests.md

export function prState(pr: PullRequest): PrState {
  if (pr.state) return pr.state;
  return pr.merged ? 'merged' : 'open';
}

export interface PrHealth {
  blocked: boolean;
  reasons: string[];
}

export function prHealth(pr: PullRequest, openPrs: PullRequest[] = []): PrHealth {
  const reasons: string[] = [];
  if (pr.merged) return { blocked: false, reasons };

  if (pr.ciStatus === 'failing') {
    const from = inheritedCiFailure(pr, openPrs);
    reasons.push(from ? `CI failing on base PR #${from.number}` : `CI failing${failingCheckSuffix(pr)}`);
  }

  if (isConflicted(pr)) reasons.push('merge conflicts');
  else if (pr.mergeableState === 'behind') reasons.push('behind base branch');
  else if (pr.mergeableState === 'blocked') reasons.push('merge blocked (required checks/reviews)');

  const open = pr.unresolvedComments.filter((c) => !c.handled).length;
  if (open > 0) reasons.push(`${open} unresolved comment${open === 1 ? '' : 's'}`);

  return { blocked: reasons.length > 0, reasons };
}

function failingCheckSuffix(pr: PullRequest): string {
  const failing = (pr.ciChecks ?? [])
    .filter((c) => c.status === 'failing' && !c.advisory && c.blocking !== false)
    .map((c) => c.name);
  if (failing.length === 0) return '';
  const shown = failing.slice(0, MAX_NAMED_CHECKS);
  const rest = failing.length - shown.length;
  return `: ${shown.join(', ')}${rest > 0 ? ` +${rest} more` : ''}`;
}

const MAX_NAMED_CHECKS = 3;

export function isConflicted(pr: PullRequest): boolean {
  if (pr.merged) return false;
  if (pr.mergeableState === 'dirty') return true;
  const unknownState = pr.mergeableState === undefined || pr.mergeableState === 'unknown';
  return unknownState && pr.mergeable === false;
}

export function needsBaseUpdate(pr: PullRequest): boolean {
  if (pr.merged) return false;
  return isConflicted(pr) || pr.mergeableState === 'behind';
}

export function isStackedPr(pr: PullRequest, defaultBranch: string): boolean {
  return pr.baseBranch !== undefined && pr.baseBranch !== defaultBranch;
}

export function basePrOf(pr: PullRequest, openPrs: PullRequest[]): PullRequest | null {
  if (pr.baseBranch === undefined) return null;
  return openPrs.find((c) => !c.merged && c.number !== pr.number && c.branch === pr.baseBranch) ?? null;
}

export function ciNeedsAttention(pr: PullRequest): boolean {
  const checks = pr.ciChecks;
  if (checks === undefined || checks.length === 0) return !pr.ciChecksWithheld && pr.ciStatus === 'failing';
  return checks.some((c) => c.status === 'failing' && !c.advisory);
}

export function inheritedCiFailure(pr: PullRequest, openPrs: PullRequest[]): PullRequest | null {
  if (!ciNeedsAttention(pr)) return null;
  const seen = new Set<number>([pr.number]);
  let current = pr;
  for (;;) {
    const base = basePrOf(current, openPrs);
    if (!base || seen.has(base.number)) return null;
    seen.add(base.number);
    if (ciNeedsAttention(base)) return base;
    current = base;
  }
}

export function isPrWatched(pr: PullRequest, watchLabel: string): boolean {
  return isWatched(pr.labels, watchLabel);
}

export function awaitingReview(pr: PullRequest, staffed: boolean): boolean {
  return (
    prState(pr) === 'open' &&
    !staffed &&
    pr.approved !== true &&
    pr.ciStatus !== 'failing' &&
    !pr.unresolvedComments.some((c) => !c.handled)
  );
}

export function recoveredOnSameCommit(before: PullRequest | undefined, now: PullRequest): CiCheck[] {
  if (!before || !before.headSha || !now.headSha || before.headSha !== now.headSha) return [];
  const was = new Map((before.ciChecks ?? []).map((c) => [c.name, c]));
  return (now.ciChecks ?? []).filter(
    (check) => !check.advisory && check.status === 'passing' && was.get(check.name)?.status === 'failing',
  );
}

export function newlyFailingChecks(before: PullRequest | undefined, now: PullRequest): CiCheck[] {
  if (!before) return [];
  const was = new Map((before.ciChecks ?? []).map((c) => [c.name, c]));
  return (now.ciChecks ?? []).filter((check) => {
    const previously = was.get(check.name);
    return !check.advisory && check.status === 'failing' && previously !== undefined && previously.status !== 'failing';
  });
}
