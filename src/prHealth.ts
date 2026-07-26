import type { PrState, PullRequest } from './types.js';

/**
 * A PR's open/merged/closed state, tolerant of the two shapes that reach us: the
 * explicit `state` a closed-PR-aware provider sets, and the bare `merged` flag
 * everything wrote before that existed (and still writes for open PRs).
 *
 * Deliberately never invents `closed`: a PR nobody told us was closed is open or
 * merged, never abandoned. That asymmetry is the whole point — "closed unmerged"
 * has to be *observed*, because inferring it from a disappearance is precisely
 * the bug this replaced.
 */
export function prState(pr: PullRequest): PrState {
  if (pr.state) return pr.state;
  return pr.merged ? 'merged' : 'open';
}

interface PrHealth {
  /** True when the PR can't progress on its own and needs work or attention. */
  blocked: boolean;
  /** Human-readable reasons, most actionable first. Empty when healthy. */
  reasons: string[];
}

/**
 * Fold a PR's signals into one health verdict for the cockpit: *why* is this PR
 * stuck? Pure and deterministic — the snapshot computes it per PR and the UI
 * renders `reasons`. A merged PR is done, so it is never blocked.
 *
 * `openPrs` is optional stack context: given it, a CI failure inherited from the
 * PR underneath this one is named as such, so the cockpit says *whose* failure it
 * is rather than leaving the operator to wonder why no agent was dispatched (see
 * {@link inheritedCiFailure}). Omitted => the verdict reads the PR alone, exactly
 * as it did before stacks existed.
 */
export function prHealth(pr: PullRequest, openPrs: PullRequest[] = []): PrHealth {
  const reasons: string[] = [];
  if (pr.merged) return { blocked: false, reasons };

  if (pr.ciStatus === 'failing') {
    const from = inheritedCiFailure(pr, openPrs);
    reasons.push(from ? `CI failing on base PR #${from.number}` : 'CI failing');
  }

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
 * The open PR this one is stacked on: the one whose *head* branch is this PR's
 * base. Resolved purely from the world rather than from the plan graph, and
 * deliberately so — "whose commits is this CI run actually testing" is a PR-level
 * fact, true of a stack a human made by hand as much as of one LubbDubb planned,
 * and reading it here keeps the predicate provider-agnostic and plan-free.
 *
 * A merged PR is not a base worth attributing to: its commits are in the
 * integration branch, and the provider retargets its children.
 */
export function basePrOf(pr: PullRequest, openPrs: PullRequest[]): PullRequest | null {
  if (pr.baseBranch === undefined) return null;
  return openPrs.find((c) => !c.merged && c.number !== pr.number && c.branch === pr.baseBranch) ?? null;
}

/**
 * The PR *below* this one whose red CI this PR's red CI is inheriting, or null
 * when the failure is genuinely its own.
 *
 * The hazard this exists for: part 2's CI runs part 1's commits, so part 1 going
 * red turns part 2 red, and the CI rule would put an agent on part 2 to fix code
 * that isn't part 2's — multiplying agents up the whole stack, each of them
 * unable to fix anything. Suppressing the rule on the inheriting PR is enough on
 * its own: the failing PR at the bottom is in the same world and rule 1 fires on
 * it under its own steam, so there is nothing to push down. When the fix lands
 * there, the children go green with it.
 *
 * Walks the whole chain, not just the immediate base, because a base whose own CI
 * is still `pending` must not read as "this failure is yours". Cycle-guarded: a
 * provider reporting a base loop can't spin this.
 */
export function inheritedCiFailure(pr: PullRequest, openPrs: PullRequest[]): PullRequest | null {
  if (pr.ciStatus !== 'failing') return null;
  const seen = new Set<number>([pr.number]);
  let current = pr;
  for (;;) {
    const base = basePrOf(current, openPrs);
    if (!base || seen.has(base.number)) return null;
    seen.add(base.number);
    if (base.ciStatus === 'failing') return base;
    current = base;
  }
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
