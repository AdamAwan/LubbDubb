import { openPrForIssue } from '../issuePickup.js';
import { resolveIssueConclusion } from '../../issueConclusion.js';
import { issueOrigin } from '../../plans/planning.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `work-item-back-to-pickup`)

export function workItemBackToPickup(s: StageContext): void {
  if (!s.workItemStates) return;
  const { inReviewState, pickupStates } = s.workItemStates;
  const returnState = pickupStates[0]!;
  for (const issue of s.ctx.world.issues) {
    if (s.retained.has(issue.number)) continue;
    const state = issue.workItemState;
    if (state === undefined || issue.state !== 'open') continue;
    if (pickupStates.includes(state)) continue;
    if (state !== inReviewState) continue;
    if (openPrForIssue(issue, s.openPrs)) continue;
    const plan = s.plansByOrigin.get(issueOrigin(issue.number)) ?? null;
    const conclusion = resolveIssueConclusion(
      s.conclusions.get(issueOrigin(issue.number)) ?? null,
      plan,
      plan ? (s.ctx.planParts ?? []).filter((p) => p.planId === plan.id) : [],
      s.shortfallsByOrigin.get(issueOrigin(issue.number)) ?? null,
    );
    if (conclusion.verdict !== 'more_work') continue;
    s.raw.push({
      type: 'set_work_item_state',
      number: issue.number,
      state: returnState,
      rule: 'work-item-back-to-pickup',
      reason:
        `Work item #${issue.number} is open in "${inReviewState}" with no open PR, and ` +
        `${
          conclusion.by === 'plan'
            ? conclusion.note
            : conclusion.by === 'assessor'
              ? 'an assessment of the delivered work found the goal is not reached'
              : `${conclusion.by === 'operator' ? 'you' : 'the agent that worked it'} reported work outstanding`
        }` +
        `; move it back to "${returnState}" so the rest can be picked up.`,
    } satisfies RawAction);
  }
}
