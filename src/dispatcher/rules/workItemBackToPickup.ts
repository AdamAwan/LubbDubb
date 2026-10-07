import { askedAlready } from '../admission.js';
import type { resolveIssueConclusion } from '../../issueConclusion.js';
import { issueOriginRef } from '../../issueOrigins.js';
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
    const ref = issueOriginRef('reviewStranded', issue.number);
    if (askedAlready(ref, s.ctx.openEscalations, s.ctx.recentDecisions)) continue;
    s.raw.push({
      type: 'escalate_to_human',
      escalationType: 'resolve_ambiguity',
      prompt:
        `Work item #${issue.number} ("${issue.title}") is in "${inReviewState}" with no open PR, and ` +
        `${outstandingBy(conclusion)}. The harness never moves a work item backwards, so nothing will pick ` +
        `it up while it sits there. Move it back to "${returnState}" if the fleet should do the rest, or ` +
        `mark the issue done if no more work is expected.`,
      context: { originRef: ref, issueNumber: issue.number, taskTitle: issue.title },
      rule: 'work-item-back-to-pickup',
      reason:
        `Work item #${issue.number} is open in "${inReviewState}" with no open PR and work reported outstanding; ` +
        `ask a human whether to move it back rather than moving it.`,
    } satisfies RawAction);
  }
}

function outstandingBy(conclusion: ReturnType<typeof resolveIssueConclusion>): string {
  if (conclusion.by === 'plan') return conclusion.note;
  if (conclusion.by === 'assessor') return 'an assessment of the delivered work found the goal is not reached';
  return `${conclusion.by === 'operator' ? 'you' : 'the agent that worked it'} reported work outstanding`;
}
