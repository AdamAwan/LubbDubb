import { issueWatchGateReason } from '../issuePickup.js';
import { planProposalHold, planProposalRef } from '../../proposals/proposals.js';
import { describeProposedParts, planApprovalDetail, planApprovalNote } from '../../plans/planApproval.js';
import { planApprovalWarnings } from '../../plans/planWedge.js';
import { liveParts, planIssueNumber } from '../../plans/parts.js';
import type { RawAction, StageContext } from './context.js';

/**
 * A plan is a proposal before it is work, on every deployment.
 * Ingestion parks it as `awaiting_approval` and this puts it to the operator —
 * once: the executor writes the proposal, and a pending one holds this rule off
 * the plan (`planProposalHold`, asked here *and* there for the same reason
 * `pr-merge-ready` and the executor both ask about a merge). It claims no
 * headroom; it starts nothing. Accepting releases the plan to `active`, where
 * `plan-part` takes over on the next pulse.
 *
 * **One ask, whatever the plan's size.** This rule used to fork: a plan with parts
 * was described one way and released to `plan-part`, while a plan that was "one
 * pull request" carried no parts at all, was described in its own sentence, and
 * was released to `issue-pickup` instead. Two asks, two settlements and two
 * schedulers for one question — is this work right — and the fork bought nothing
 * the part list does not already say.
 *
 * Read off `ctx.plans` rather than `eligibleIssues` for the same reason `plan-part`
 * is: a replan of an in-flight plan needs re-approving, and by then the issue's
 * parts have PRs, so the "no open PR" gate would hide it exactly when the question
 * matters most.
 */
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
    s.raw.push({
      type: 'propose_plan',
      planId: plan.id,
      originRef: plan.originRef,
      // Both notes are appended, never interpolated, for `ciFailureNote`'s reason:
      // an override that never learned a `{warnings}` or `{settlement}` token would
      // silently drop them on exactly the deployments that customised most.
      // `{parts}` is the pull requests the plan produces — the count the template's
      // sentence is about, and now simply the number of parts.
      //
      // `{list}` is still rendered although the built-in template no longer uses
      // it: the split moved behind the plan panel, and an override written when it
      // was the body of the ask must keep working.
      detail: planApprovalDetail(plan),
      prompt:
        s.templates.render('plan-approval', {
          number: issueNumber,
          title: issue.title,
          parts: parts.length,
          reason: plan.reason ?? 'the planner gave no reason',
          list: describeProposedParts(parts),
        }) +
        planApprovalNote() +
        planApprovalWarnings(issue, parts, s.openPrs),
      rule: 'plan-approval',
      reason: `Issue #${issueNumber} has a ${parts.length}-part plan and approval is required before any of it is scheduled.`,
    } satisfies RawAction);
  }
}
