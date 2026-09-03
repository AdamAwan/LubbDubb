import type { PullRequest } from './types.js';

/**
 * "Is this pull request the harness's own?" — asked once, here, because several
 * bookkeeping paths need it and differently-worded answers would drift.
 *
 * **The provider's own answer comes first.** `PullRequest.viewerAuthored` is the
 * credential's identity compared against the pull request's author, which is the
 * question this one *is*; when a provider reports it, nothing else is consulted.
 *
 * `filters.prAuthor` is not that answer and stopped being a proxy for it the day
 * `ownWorkOnly` widened the fetch to the pull requests a colleague **assigned** to
 * the operator: with the filter set, somebody else's pull request is now in the
 * world by design, and reading the filter as ownership had the harness renaming,
 * relabelling and reaping it. So the filter survives only as the *unknown* arm's
 * fallback, beside the branch shapes a dispatch cuts — the two answers available
 * to a provider that cannot name an author.
 *
 * **A colleague's pull request is neither renamed nor reaped under any arm**, and
 * that is the whole point of asking here rather than at each call site.
 * → `docs/spec/07-pull-requests.md#whose-pull-request-is-it`
 */
export function isOurPr(pr: PullRequest, prAuthorConfigured: boolean): boolean {
  return pr.viewerAuthored ?? (prAuthorConfigured || isHarnessBranch(pr.branch));
}

/**
 * The *negative* of {@link isOurPr}, and deliberately not its inverse: this is true
 * only where the provider positively named an author who is not the credential.
 *
 * Two questions, because the absences differ. "Is this ours, so we may rename it"
 * fails safe by saying no; "is this somebody else's, so hide it from every rule"
 * must fail safe by saying no as well — a provider that cannot name an author
 * would otherwise take every watched pull request out of the dispatch world and
 * stop the fleet with nothing red. Folding the two into one predicate is one
 * `!` away from exactly that.
 */
export function isSomeoneElsesPr(pr: PullRequest): boolean {
  return pr.viewerAuthored === false;
}

/**
 * `issue/12`, `issue/12/<slug>` or `job/<id>` — the branch shapes only a dispatch
 * produces, and therefore the unset arm's answer to "did the harness open this".
 *
 * Derived rather than stored: a PR on one of those can only have come from a
 * dispatch, so recording every opened PR number in a table of its own would be a
 * second answer to a question the branch already answers. Arm A of the
 * unrecorded-work fold's attribution, reused.
 *
 * **One definition, because two readers now ask it.** The watch seeding
 * ([`src/prWatch.ts`]) tags the harness's own pull requests off exactly this
 * predicate, and a second copy of it would be free to disagree about which
 * branches are the fleet's — quietly leaving one class of pull request untagged
 * and therefore unworked. That is why `job/<id>` is here: a code job's branch is
 * cut by a dispatch like any other, and the rename and the merged-branch reap were
 * skipping it only because this answer had never been asked outside them.
 */
export function isHarnessBranch(branch: string): boolean {
  return /^issue\/\d+(\/.+)?$/.test(branch) || /^job\/.+$/.test(branch);
}
