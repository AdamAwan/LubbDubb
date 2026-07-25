import type { PullRequest } from './types.js';

export interface PrHealth {
  /** True when the PR can't progress on its own and needs work or attention. */
  blocked: boolean;
  /** Human-readable reasons, most actionable first. Empty when healthy. */
  reasons: string[];
}

/**
 * Fold a PR's signals into one health verdict for the cockpit: *why* is this PR
 * stuck? Pure and deterministic — the snapshot computes it per PR and the UI
 * renders `reasons`. A merged PR is done, so it is never blocked.
 */
export function prHealth(pr: PullRequest): PrHealth {
  const reasons: string[] = [];
  if (pr.merged) return { blocked: false, reasons };

  if (pr.ciStatus === 'failing') reasons.push('CI failing');

  if (isConflicted(pr)) reasons.push('merge conflicts');
  else if (pr.mergeableState === 'behind') reasons.push('behind base branch');
  else if (pr.mergeableState === 'blocked') reasons.push('merge blocked (required checks/reviews)');

  const open = pr.unresolvedComments.filter((c) => !c.handled).length;
  if (open > 0) reasons.push(`${open} unresolved comment${open === 1 ? '' : 's'}`);

  return { blocked: reasons.length > 0, reasons };
}

/**
 * A real merge conflict: GitHub says 'dirty', or — when it hasn't reported a
 * state — the tri-state `mergeable` is a firm false. Merged PRs are never conflicted.
 */
export function isConflicted(pr: PullRequest): boolean {
  if (pr.merged) return false;
  if (pr.mergeableState === 'dirty') return true;
  const unknownState = pr.mergeableState === undefined || pr.mergeableState === 'unknown';
  return unknownState && pr.mergeable === false;
}

/** The PR needs its base branch merged in: a conflict to resolve, or simply behind. */
export function needsBaseUpdate(pr: PullRequest): boolean {
  if (pr.merged) return false;
  return isConflicted(pr) || pr.mergeableState === 'behind';
}

/**
 * A PR that targets something other than the integration branch — i.e. it is
 * stacked on another in-flight branch.
 *
 * The merge rule fires on green + approved + mergeable, which on a stack would
 * merge part 2 **into part 1's branch** mid-flight rather than into the default
 * branch: the change lands nowhere real, part 1's review now contains part 2's
 * code, and the stack is scrambled. Stacked children instead wait for the provider
 * to retarget them when their parent merges, at which point their base *is* the
 * default branch and this predicate stops holding them.
 *
 * A PR whose base the provider didn't report is not treated as stacked — unknown
 * must not silently stop merging PRs that merged fine before.
 */
export function isStackedPr(pr: PullRequest, defaultBranch: string): boolean {
  return pr.baseBranch !== undefined && pr.baseBranch !== defaultBranch;
}

/**
 * The operator's "leave this PR alone" tag: true when the PR carries the
 * configured exclusion label. Pure and provider-agnostic — reads `PullRequest.labels`,
 * so it gates the fake/github/azure providers identically. An empty `label` (feature
 * off) or a PR with no labels is never excluded.
 */
export function isPrExcluded(pr: PullRequest, label: string): boolean {
  if (!label) return false;
  return (pr.labels ?? []).includes(label);
}
