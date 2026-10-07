import type { resolveIssueConclusion } from '../../issueConclusion.js';
import type { RawAction, StageContext } from './context.js';
import { workItemRelease } from './workItemRelease.js';

// → docs/spec/05-dispatcher.md (rule `work-item-back-to-pickup`)

export function workItemBackToPickup(s: StageContext): void {
  if (!s.workItemStates) return;
  const { inReviewState, pickupStates } = s.workItemStates;
  if (pickupStates.includes(inReviewState)) return;
  const returnState = pickupStates[0]!;
  for (const issue of s.ctx.world.issues) {
    if (s.retained.has(issue.number)) continue;
    if (issue.state !== 'open' || issue.workItemState !== inReviewState) continue;
    const conclusion = workItemRelease(s, issue);
    if (!conclusion) continue;
    s.raw.push({
      type: 'set_work_item_state',
      number: issue.number,
      state: returnState,
      rule: 'work-item-back-to-pickup',
      reason:
        `Work item #${issue.number} is open in "${inReviewState}" with no open PR, and ` +
        outstandingBy(conclusion) +
        `; move it back to "${returnState}" so the rest can be picked up.`,
    } satisfies RawAction);
  }
}

function outstandingBy(conclusion: ReturnType<typeof resolveIssueConclusion>): string {
  if (conclusion.by === 'plan') return conclusion.note;
  if (conclusion.by === 'assessor') return 'an assessment of the delivered work found the goal is not reached';
  return `${conclusion.by === 'operator' ? 'you' : 'the agent that worked it'} reported work outstanding`;
}
