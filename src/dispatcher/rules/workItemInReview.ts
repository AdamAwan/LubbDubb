import { openPrForIssue } from '../issuePickup.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `work-item-in-review`)

export function workItemInReview(s: StageContext): void {
  if (!s.workItemStates) return;
  const { inReviewState, pickupStates } = s.workItemStates;
  for (const issue of s.ctx.world.issues) {
    if (s.retained.has(issue.number)) continue;
    const state = issue.workItemState;
    if (state === undefined || issue.state !== 'open') continue;
    if (!pickupStates.includes(state)) continue;
    const pr = openPrForIssue(issue, s.openPrs);
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
