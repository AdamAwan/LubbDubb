import { openPrForIssue } from '../issuePickup.js';
import { issueOriginRole } from '../../issueOrigins.js';
import { isActiveTask } from '../../tasks.js';
import type { RawAction, StageContext } from './context.js';

/**
 * Move a work item into the in-progress state ("Doing") once an agent is actually
 * working it, so a board shows work in flight where it is instead of leaving it in
 * "Ready" until a PR opens.
 *
 * It fires off an **observed live task**, not off the dispatch that started one.
 * The tempting place is the headroom cut, where a pickup candidate becomes a
 * dispatch — but that cut is generic, fires exactly once, and fires for candidates
 * that are then held or superseded: a provider write refused there is never
 * retried, and a candidate cut for want of headroom would park an item in "Doing"
 * nobody is working. Observing instead makes the rule idempotent and self-healing,
 * at the cost of one pulse of lag, and gives it the shape both sibling work-item
 * rules already have.
 *
 * `issueOriginRole(...) === 'work'` is the predicate for "an agent is doing the
 * work": it covers the pickup root `issue:<n>` and a plan part, and excludes the
 * deliberation runs — an appraisal, a planner, an assessor or a retro leaves the item
 * where it is, because none of them is work on the goal.
 *
 * **Mutually exclusive with {@link workItemInReview} by construction**: that rule
 * owns an item with an open PR *or* a decomposed one, and this one refuses both.
 * They must never both fire for one item in one cycle — the item would ping-pong,
 * one provider write per pulse, forever — which is a test rather than a comment.
 *
 * Opt-in: off unless the operator set both an in-progress state and pickup states,
 * which is what the `workItemInProgress` condition on the registry entry switches
 * it in on, and only for items carrying a native state (Azure work items; GitHub
 * issues have none, so this is a no-op for them).
 */
export function workItemInProgress(s: StageContext): void {
  if (!s.workItemInProgress) return;
  const { inProgressState, pickupStates } = s.workItemInProgress;
  for (const issue of s.ctx.world.issues) {
    // A retained run carries the state the item last had (issue #234), which is
    // enough to make this rule move an item the tracker no longer returns. Said
    // here rather than left to the `open` check below, which would refuse it by
    // coincidence — see `work-item-in-review` for the same explicitness.
    if (s.retained.has(issue.number)) continue;
    const state = issue.workItemState;
    if (state === undefined || issue.state !== 'open') continue;
    // `pickupStates` is the *effective* list, so it already contains the state
    // this rule writes — which is exactly what makes the next line the whole of
    // its idempotency rather than a happy accident of the operator's config.
    if (!pickupStates.includes(state)) continue;
    if (state === inProgressState) continue;
    // An open PR, or a decomposition, is the review state's business.
    if (openPrForIssue(issue, s.openPrs)) continue;
    if (s.partsPlanFor(issue.number) !== null) continue;
    const task = s.ctx.tasks.find((t) => isActiveTask(t) && issueOriginRole(issue.number, t.originRef) === 'work');
    if (!task) continue;
    s.raw.push({
      type: 'set_work_item_state',
      number: issue.number,
      state: inProgressState,
      rule: 'work-item-in-progress',
      reason:
        `An agent is working work item #${issue.number} (task on ${task.originRef}); ` +
        `move it from "${state}" to "${inProgressState}" so the board shows the work in flight.`,
    } satisfies RawAction);
  }
}
