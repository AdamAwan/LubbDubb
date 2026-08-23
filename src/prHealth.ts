import { isWatched } from './watchLabels.js';
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
 * Name the failing checks after "CI failing" when the provider reported them.
 *
 * Deliberately the raw names and no policy verdict: this is the *health*
 * question ("can this merge"), and a check the operator has told the harness to
 * leave alone still blocks the merge. Whose turn it is belongs to
 * `prAttentionStatus`, and what the harness will do about it to `ciPolicy`.
 * Capped so a matrix build of thirty jobs doesn't fill the cockpit row.
 *
 * By the same question, a check the provider says does **not** block completion
 * has no place here, and neither does an advisory one, which is not a CI check
 * at all. A *muted* check does belong: telling the harness to leave it alone
 * does not stop the provider holding the PR on it.
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
 * Is there a CI failure on this PR the harness should put an agent on?
 *
 * Deliberately *not* `ciStatus === 'failing'`, which is the **merge** question. A
 * provider can report a check that fails without blocking completion — an Azure
 * "Optional" branch policy — and the harness should still fix it. Folding that
 * into the aggregate instead would claim the PR cannot merge when it can, and
 * would stop the merge rule merging it.
 *
 * The aggregate is a fallback, not a second vote: it only answers when there is
 * no per-check detail to defer to at all (`ciChecks` undefined or empty — a
 * provider that hasn't reported per-check detail, or a PR persisted before
 * checks existed). Once detail exists, it settles the question on its own — a
 * provider whose aggregate folds a check the per-check list marks `advisory`
 * (Azure's policy aggregate does this; see `aggregatePolicyCiStatus`) must not
 * out-vote the detail that says the same check isn't actionable.
 *
 * Advisory checks are excluded for the reason `classifyCiFailures` excludes them:
 * they restate a signal something else already owns at higher fidelity, and
 * dispatching on one would outrank the rule that owns it.
 */
export function ciNeedsAttention(pr: PullRequest): boolean {
  const checks = pr.ciChecks;
  if (checks === undefined || checks.length === 0) return pr.ciStatus === 'failing';
  return checks.some((c) => c.status === 'failing' && !c.advisory);
}

/**
 * The PR *below* this one whose red CI this PR's red CI is inheriting, or null
 * when the failure is genuinely its own.
 *
 * The hazard this exists for: part 2's CI runs part 1's commits, so part 1 going
 * red turns part 2 red, and the CI rule would put an agent on part 2 to fix code
 * that isn't part 2's — multiplying agents up the whole stack, each of them
 * unable to fix anything. Suppressing the rule on the inheriting PR is enough on
 * its own: the failing PR at the bottom is in the same world and rule `pr-ci-failing` fires on
 * it under its own steam, so there is nothing to push down. When the fix lands
 * there, the children go green with it.
 *
 * Walks the whole chain, not just the immediate base, because a base whose own CI
 * is still `pending` must not read as "this failure is yours". Cycle-guarded: a
 * provider reporting a base loop can't spin this.
 *
 * Reads {@link ciNeedsAttention} rather than the aggregate, so a failure that
 * dispatches without blocking the merge is attributed too — otherwise one red
 * Optional check on a stack's base would put an agent on every PR above it,
 * which is exactly the multiplication this exists to prevent.
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
 * Is this pull request opted in? True when it carries the configured watch tag.
 * Pure and provider-agnostic — reads `PullRequest.labels` through `isWatched`, so it
 * gates the fake/github/azure providers identically. An empty `watchLabel` (feature
 * off) means every PR is watched.
 *
 * Pull requests are **opt-in**, exactly as issues are: an untagged one is left
 * alone. The harness tags the ones it opens itself (`src/prWatch.ts`), so its own
 * work never depends on an operator noticing it — and removing that tag is how you
 * take a PR off the fleet, permanently, because nothing writes it back.
 */
export function isPrWatched(pr: PullRequest, watchLabel: string): boolean {
  return isWatched(pr.labels, watchLabel);
}

/**
 * Could a reviewer act on this pull request right now, and have they not?
 *
 * The clock behind `PrAttention.reviewWaitingSince`, folded once per pulse
 * (`Store.foldReviewWaits`). Pure over the pull request plus whether an agent
 * holds its branch, so it is decidable inside the pulse — which is the whole
 * requirement: the moment a pull request *becomes* reviewable is observable only
 * as it happens, and no provider payload carries it after the fact.
 *
 * **Deliberately a superset of `prAttention`'s `waiting on review` arm**, and it
 * lives here rather than there for the reason that file states about itself:
 * nothing outside the state snapshot may import the lens, and the pulse has to
 * fold this. That arm is reached only after seven earlier ones decline the pull
 * request, and reproducing all seven would be a second copy of the verdict, free
 * to drift. So the clock runs a little more eagerly and the *arm* decides whether
 * an age is ever displayed: a pull request whose clock is running but whose court
 * is the harness's shows nothing, which is the safe direction — an age shown for
 * a wait the fleet caused would be a reminder pointed at the wrong person.
 *
 * Red CI, an unhandled comment and a staffed branch all stop it, for that same
 * reason: a reviewer cannot be late for work that is not ready.
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
