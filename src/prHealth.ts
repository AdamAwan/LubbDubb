import { isWatched } from './watchLabels.js';
import type { CiCheck, PrState, PullRequest } from './types.js';

/**
 * A PR's open/merged/closed state, tolerant of both shapes that reach us: an explicit
 * `state`, and the bare `merged` flag. Never invents `closed` — "closed unmerged" must
 * be observed, never inferred from a disappearance.
 */
export function prState(pr: PullRequest): PrState {
  if (pr.state) return pr.state;
  return pr.merged ? 'merged' : 'open';
}

export interface PrHealth {
  /** True when the PR can't progress on its own and needs work or attention. */
  blocked: boolean;
  /** Human-readable reasons, most actionable first. Empty when healthy. */
  reasons: string[];
}

/**
 * Fold a PR's signals into one health verdict for the cockpit: why is this PR stuck?
 * Pure and deterministic; a merged PR is never blocked. `openPrs` is optional stack
 * context — given it, a failure inherited from the PR below is named as such
 * ({@link inheritedCiFailure}); omitted, the verdict reads the PR alone.
 */
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

/**
 * Name the failing checks after "CI failing". Raw names, no policy verdict: this is the
 * merge question, so non-blocking and advisory checks are excluded but muted ones are
 * not — muting does not stop the provider holding the PR. Capped at
 * {@link MAX_NAMED_CHECKS}.
 */
function failingCheckSuffix(pr: PullRequest): string {
  const failing = (pr.ciChecks ?? [])
    .filter((c) => c.status === 'failing' && !c.advisory && c.blocking !== false)
    .map((c) => c.name);
  if (failing.length === 0) return '';
  const shown = failing.slice(0, MAX_NAMED_CHECKS);
  const rest = failing.length - shown.length;
  return `: ${shown.join(', ')}${rest > 0 ? ` +${rest} more` : ''}`;
}

/** How many failing check names a health reason names before summarising the rest. */
const MAX_NAMED_CHECKS = 3;

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
 * A PR that targets something other than the integration branch — stacked on another
 * in-flight branch, and so held back from the merge rule until the provider retargets
 * it. An unreported base is not stacked: unknown must not silently stop merges.
 */
export function isStackedPr(pr: PullRequest, defaultBranch: string): boolean {
  return pr.baseBranch !== undefined && pr.baseBranch !== defaultBranch;
}

/**
 * The open PR this one is stacked on: the one whose head branch is this PR's base.
 * Resolved from the world, not the plan graph, so a hand-made stack reads the same. A
 * merged PR is never a base — its commits are in the integration branch.
 */
export function basePrOf(pr: PullRequest, openPrs: PullRequest[]): PullRequest | null {
  if (pr.baseBranch === undefined) return null;
  return openPrs.find((c) => !c.merged && c.number !== pr.number && c.branch === pr.baseBranch) ?? null;
}

/**
 * Is there a CI failure here the harness should put an agent on? Not
 * `ciStatus === 'failing'`, which is the merge question — a non-blocking red check is
 * still worth fixing. The aggregate is a fallback, never a second vote: once per-check
 * detail exists it settles the question alone. Advisory checks are excluded, as in
 * `classifyCiFailures`.
 */
export function ciNeedsAttention(pr: PullRequest): boolean {
  const checks = pr.ciChecks;
  // Empty because the provider had nothing to say falls back to the aggregate; empty
  // because the operator said `off` (withheld) does not.
  if (checks === undefined || checks.length === 0) return !pr.ciChecksWithheld && pr.ciStatus === 'failing';
  return checks.some((c) => c.status === 'failing' && !c.advisory);
}

/**
 * The PR below this one whose red CI this PR is inheriting, or null when its own.
 * Suppressing the CI rule on the inheriting PR stops one red base putting an agent on
 * every PR above it. Walks the whole chain, cycle-guarded, reading
 * {@link ciNeedsAttention} rather than the aggregate.
 */
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

/**
 * Is this pull request opted in? True when it carries the configured watch tag; an empty
 * `watchLabel` means every PR is watched. PRs are opt-in — removing the tag takes a PR
 * off the fleet permanently, because nothing writes it back.
 */
export function isPrWatched(pr: PullRequest, watchLabel: string): boolean {
  return isWatched(pr.labels, watchLabel);
}

/**
 * Could a reviewer act on this PR right now, and have they not? The clock behind
 * `PrAttention.reviewWaitingSince`, folded once per pulse. Deliberately a superset of
 * `prAttention`'s "waiting on review" arm; that arm, not this clock, decides whether an
 * age is displayed.
 */
export function awaitingReview(pr: PullRequest, staffed: boolean): boolean {
  return (
    prState(pr) === 'open' &&
    !staffed &&
    pr.approved !== true &&
    pr.ciStatus !== 'failing' &&
    !pr.unresolvedComments.some((c) => !c.handled)
  );
}

/**
 * The checks that went red and then green **without the commit changing** — the flake
 * reading. `headSha` absent on either snapshot means silence: a flake cannot be claimed
 * without knowing nothing was pushed in between.
 * (`docs/spec/27-obstacles.md#the-harness-is-a-voice`)
 */
export function recoveredOnSameCommit(before: PullRequest | undefined, now: PullRequest): CiCheck[] {
  if (!before || !before.headSha || !now.headSha || before.headSha !== now.headSha) return [];
  const was = new Map((before.ciChecks ?? []).map((c) => [c.name, c]));
  return (now.ciChecks ?? []).filter(
    (check) => !check.advisory && check.status === 'passing' && was.get(check.name)?.status === 'failing',
  );
}

/** The checks that have just gone red on this pull request — a transition, never a state. */
export function newlyFailingChecks(before: PullRequest | undefined, now: PullRequest): CiCheck[] {
  if (!before) return [];
  const was = new Map((before.ciChecks ?? []).map((c) => [c.name, c]));
  return (now.ciChecks ?? []).filter((check) => {
    const previously = was.get(check.name);
    return !check.advisory && check.status === 'failing' && previously !== undefined && previously.status !== 'failing';
  });
}
