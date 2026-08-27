import type { AppState, Issue } from '../types.js';

/**
 * A goal that hangs off no Feature, on a deployment where that is a problem.
 *
 * ## The gap this closes
 *
 * `src/intake/placement.ts` already states why an unparented goal matters: the
 * work lands, the pull request merges, and the ticket is invisible to whoever
 * plans the backlog — rolled up to nothing, and on no team's board. What it puts
 * on the glass is one row in the needs rail, and that row is gated on the
 * *appraiser having proposed a container*. A goal picked up before the appraiser
 * ran, one whose verdict named nothing, and one the operator answered months ago
 * are all orphans about which the cockpit currently says nothing at all.
 *
 * This is the fact rather than the question: the item hangs off nothing, whoever
 * did or did not suggest what to do about it. The proposal, where there is one,
 * is what the warning *offers* — never what makes it appear.
 *
 * ## Derived on every read, and the three states of `parent`
 *
 * Nothing here is stored, for `placementAsks`' reason: an operator who sets
 * the parent by hand in Azure ends the warning on the next world read, with no
 * timer and no world event to have missed.
 *
 * {@link Issue.parent} draws three states and only one of them is this:
 * `undefined` is a provider that tracks no hierarchy — GitHub, every time — and
 * warning there would put an amber band on every goal of every deployment that
 * has no Features to hang anything off. `null` is the tracker saying this item
 * has no parent, which is the whole subject. An object is a parent.
 *
 * ## Why the feature board's flag gates it
 *
 * Same conjunction the board itself is gated on, read off the one field that
 * already carries it: `config.featureBoard` is the operator's flag **and** a
 * provider that can place a work item, folded server-side by `featureBoardOn`. An
 * operator who has not asked for the tier above their stories has not asked to be
 * told which stories are missing from it — and on a deployment where nothing can
 * write a parent, the warning would be a dead end rather than a warning.
 */
interface OrphanGoal {
  /**
   * The container the appraiser proposed, or null when it named none — every
   * `unclear` verdict, every goal appraised before the board was switched on, and
   * every goal nothing has appraised at all.
   *
   * Read off the *open* placement ask rather than off the appraisal's stored
   * proposal, which is the same reading the needs rail takes: the server derives
   * that list against the live work item and the browser has neither the area
   * tree nor the root node it would need to re-derive it.
   */
  proposed: number | null;
  /**
   * When the operator answered the parent question, or null while it stands.
   *
   * The one thing that separates a goal nobody has ruled on from one somebody
   * decided wants no parent. Both are still orphans and neither rolls up, so the
   * warning stands either way — but only the first is an ask, and drawing them
   * the same way would either nag at a settled decision or bury an unsettled one.
   */
  settledAt: string | null;
}

/**
 * Whether this goal is an orphan worth warning about, and what to offer if so.
 *
 * Null is "nothing to say", and it is the answer on every GitHub deployment,
 * every deployment with the board off, and every goal that has a parent.
 */
export function orphanGoal(state: AppState, issue: Issue): OrphanGoal | null {
  if (!state.config.featureBoard) return null;
  // Never `!issue.parent`: `undefined` is a provider with no hierarchy, and folding
  // it in here is the silent direction — an amber band on every goal on GitHub.
  if (issue.parent !== null) return null;
  const appraisal = issue.appraisal;
  return {
    proposed: appraisal?.placement.find((p) => p.field === 'parent')?.proposedParent ?? null,
    settledAt: appraisal?.parentSettledAt ?? null,
  };
}

/**
 * How many of these goals are orphans — the count a panel header states before
 * anybody opens anything.
 *
 * Here rather than at the call site so the number and the rows it counts are one
 * reading of one predicate. A header that filtered differently from its own list
 * is the failure worth naming: both look right, and they disagree only where it
 * matters.
 */
export function orphanCount(state: AppState, issues: readonly Issue[]): number {
  return issues.filter((issue) => orphanGoal(state, issue) !== null).length;
}
