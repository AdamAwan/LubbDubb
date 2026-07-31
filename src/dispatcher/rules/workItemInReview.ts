import { openPrForIssue } from '../issuePickup.js';
import type { RawAction, StageContext } from './context.js';

/**
 * Keep a work item's state in step with whether a PR is open for it. An item in a
 * pickup state ("Ready"/"Doing") with an open PR moves to the review state, so it
 * isn't re-picked while it waits on CI/review.
 *
 * A decomposed item belongs in the review state for the whole life of its plan,
 * so the same move fires for one with no open PR at all.
 *
 * Idempotent (after the move the item no longer matches) and never fires on a
 * closed item. Opt-in — off unless the operator set both a review state and
 * pickup states, which is what the `workItemStates` condition on the registry
 * entry switches it in on, and only for items carrying a native state (Azure work
 * items; GitHub issues have none, so this is a no-op for them).
 *
 * This and {@link workItemBackToPickup} run as two passes rather than the two arms
 * of one `if/else`, which is why the second re-states this one's condition as an
 * exclusion: identical behaviour under every config, including the degenerate one
 * where an operator has named their review state as a pickup state too.
 */
export function workItemInReview(s: StageContext): void {
  if (!s.workItemStates) return;
  const { inReviewState, pickupStates } = s.workItemStates;
  for (const issue of s.ctx.world.issues) {
    const state = issue.workItemState;
    if (state === undefined || issue.state !== 'open') continue;
    if (!pickupStates.includes(state)) continue;
    // The agent for an issue works branch `issue/<n>` (see `issue-pickup`), so
    // its PR lands on that branch — the reliable link even when Azure hasn't
    // wired the ArtifactLink relation. `openPrForIssue` falls back to the
    // linked-PR number.
    const pr = openPrForIssue(issue, s.openPrs);
    // A decomposed item belongs in the review state for the whole life of its
    // plan: it isn't waiting on one PR, it's waiting on several, and the inverse
    // below would bounce it back to "Ready" in every gap between parts — and
    // again the moment the last one merges. This is also the design's
    // "completion moves an Azure work item to the review state", reusing the
    // action rather than inventing a second path to it.
    const decomposed = s.partsPlanFor(issue.number) !== null;
    if (!pr && !decomposed) continue;
    s.raw.push({
      type: 'set_work_item_state',
      number: issue.number,
      state: inReviewState,
      rule: 'work-item-in-review',
      reason: decomposed
        ? `Work item #${issue.number} is delivered as a multi-part plan; move it to "${inReviewState}" for the life of the plan.`
        : `PR #${pr!.number} is open for work item #${issue.number}; move it to "${inReviewState}" so it isn't re-picked while under review.`,
    } satisfies RawAction);
  }
}
