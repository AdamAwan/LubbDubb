import type { PullRequest } from './types.js';

/**
 * "Is this pull request the harness's own?" — asked once, here, because two
 * bookkeeping paths now need it and two differently-worded answers would drift.
 *
 * **`filters.prAuthor` is the gate, because it is already the operator's answer to
 * "which pull requests are mine"** — and both providers apply it *at fetch time*,
 * to the open and closed lists alike. So when it is set, every PR in the harness's
 * world is the operator's own **by construction**: the provider never surfaced
 * anyone else's, and no attribution logic is needed at all.
 *
 * When it is unset the world holds everyone's pull requests and the harness
 * genuinely cannot tell them apart, so it falls back to the ones it opened itself
 * — which it knows without asking anyone. **A colleague's pull request is neither
 * renamed nor reaped under either arm**, and that is the whole point of having two.
 */
export function isOurPr(pr: PullRequest, prAuthorConfigured: boolean): boolean {
  return prAuthorConfigured || isHarnessBranch(pr.branch);
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
