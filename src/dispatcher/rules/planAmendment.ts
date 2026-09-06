import { issueWatchGateReason } from '../issuePickup.js';
import { planAmendmentHold, planAmendmentProposalRef } from '../../proposals/proposals.js';
import { planIssueNumber } from '../../plans/parts.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `plan-amendment`)

export function planAmendment(s: StageContext): void {
  const { ctx } = s;
  const plans = new Map((ctx.plans ?? []).map((p) => [p.id, p]));
  for (const amendment of ctx.planAmendments ?? []) {
    if (amendment.status !== 'pending') continue;
    const plan = plans.get(amendment.planId);
    if (!plan || plan.status !== 'active') continue;
    const issueNumber = planIssueNumber(plan.originRef);
    if (issueNumber === null) continue;
    const issue = s.liveIssue(issueNumber);
    if (!issue || issue.state !== 'open') continue;
    if (issueWatchGateReason(issue, s.pickup) !== null) continue;
    if (planAmendmentHold(planAmendmentProposalRef(amendment.id), ctx.proposals ?? []) !== null) continue;
    s.raw.push({
      type: 'propose_plan_amendment',
      amendmentId: amendment.id,
      planId: plan.id,
      originRef: plan.originRef,
      prompt:
        s.templates.render('plan-amendment', {
          number: issueNumber,
          title: issue.title,
          who: amendment.author === 'operator' ? 'You, at your own keyboard,' : 'An agent working this goal',
          note: amendment.note,
        }) + AMENDMENT_SETTLEMENT,
      rule: 'plan-amendment',
      reason: `The plan for issue #${issueNumber} is running and a change to it is waiting on your approval.`,
    } satisfies RawAction);
  }
}

const AMENDMENT_SETTLEMENT =
  '\n\nAccept and the amended plan is ingested over the live one: parts that already have a branch, a pull ' +
  'request or an outcome keep them and only their declaration is refreshed, a new part becomes schedulable on ' +
  'the next pulse, and a dropped part nothing was started for is retired. Nothing that is running is stopped — ' +
  'end a run yourself if it should. Reject and nothing changes at all: the plan carries on exactly as it is.';
