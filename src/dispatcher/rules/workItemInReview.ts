import { openPrForIssue } from '../issuePickup.js';
import type { RawAction, StageContext } from './context.js';
import { workItemRelease } from './workItemRelease.js';
import { liveWorkTask } from './workItemInProgress.js';
import type { Issue } from '../../types.js';

const STARTED: ReadonlySet<string> = new Set(['dispatched', 'in_review', 'merged', 'concluded']);

function planUnderway(s: StageContext, issue: Issue): boolean {
  const plan = s.partsPlanFor(issue.number);
  if (plan === null || liveWorkTask(s, issue) !== undefined) return false;
  return (s.ctx.planParts ?? []).some((p) => p.planId === plan.id && STARTED.has(p.status));
}

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
    const decomposed = planUnderway(s, issue);
    if (!pr && !decomposed) continue;
    if (workItemRelease(s, issue)) continue;
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
