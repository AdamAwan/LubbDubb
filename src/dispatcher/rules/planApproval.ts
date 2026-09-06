import { issueWatchGateReason } from '../issuePickup.js';
import { planProposalHold, planProposalRef } from '../../proposals/proposals.js';
import { describeProposedParts, planApprovalDetail, planApprovalNote } from '../../plans/planApproval.js';
import { caveatNotice, planCaveats } from '../../plans/planCaveats.js';
import { liveParts, planIssueNumber } from '../../plans/parts.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `plan-approval`)

export function planApproval(s: StageContext): void {
  const { ctx } = s;
  for (const plan of ctx.plans ?? []) {
    if (plan.status !== 'awaiting_approval') continue;
    const issueNumber = planIssueNumber(plan.originRef);
    if (issueNumber === null) continue;
    const issue = s.liveIssue(issueNumber);
    if (!issue || issue.state !== 'open') continue;
    if (issueWatchGateReason(issue, s.pickup) !== null) continue;
    if (planProposalHold(planProposalRef(plan.originRef), ctx.proposals ?? []) !== null) continue;
    const parts = liveParts((ctx.planParts ?? []).filter((p) => p.planId === plan.id));
    const caveats = planCaveats(plan, issue, parts, s.openPrs);
    s.raw.push({
      type: 'propose_plan',
      planId: plan.id,
      originRef: plan.originRef,
      detail: planApprovalDetail(plan),
      caveats,
      prompt:
        s.templates.render('plan-approval', {
          number: issueNumber,
          title: issue.title,
          parts: parts.length,
          reason: plan.reason ?? 'the planner gave no reason',
          list: describeProposedParts(parts),
        }) +
        planApprovalNote() +
        caveatNotice(caveats),
      rule: 'plan-approval',
      reason: `Issue #${issueNumber} has a ${parts.length}-part plan and approval is required before any of it is scheduled.`,
    } satisfies RawAction);
  }
}
