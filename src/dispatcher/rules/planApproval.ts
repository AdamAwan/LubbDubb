import { issueWatchGateReason } from '../issuePickup.js';
import { planProposalHold, planProposalRef } from '../../proposals/proposals.js';
import { describeProposedParts, describeSingleRoute, planApprovalNote } from '../../plans/planApproval.js';
import { planApprovalWarnings } from '../../plans/planWedge.js';
import { liveParts, planIssueNumber } from '../../plans/parts.js';
import type { RawAction, StageContext } from './context.js';

/**
 * With `planning.requireApproval` on, a planner's verdict is a proposal before it
 * is work — **either** verdict. Ingestion parks it as `awaiting_approval` and this
 * puts it to the operator — once: the executor writes the proposal, and a pending
 * one holds this rule off the plan (`planProposalHold`, asked here *and* there for
 * the same reason `pr-merge-ready` and the executor both ask about a merge). It
 * claims no headroom; it starts nothing. Accepting releases the plan — to `active`
 * for a decomposition, where `plan-part` takes over on the next pulse, or to
 * `single`, where `issue-pickup` does.
 *
 * The two arms are told apart by the parts, not by a stored verdict
 * (`releasedPlanStatus` says why): a decomposition always declares at least one,
 * and a single verdict retires everything nothing was started for. So the ask
 * carries the shape being weighed either way — the split, or the one branch and
 * one pull request the issue would be worked whole on.
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
    const single = parts.length === 0;
    s.raw.push({
      type: 'propose_plan',
      planId: plan.id,
      originRef: plan.originRef,
      // Both notes are appended, never interpolated, for `ciFailureNote`'s reason:
      // an override that never learned a `{warnings}` or `{arm}` token would
      // silently drop them on exactly the deployments that customised most.
      // `{parts}` is the pull requests the plan produces, which is 1 for a single
      // verdict — the count the template's sentence is about either way.
      prompt:
        s.templates.render('plan-approval', {
          number: issueNumber,
          title: issue.title,
          parts: single ? 1 : parts.length,
          reason: plan.reason ?? 'the planner gave no reason',
          list: single ? describeSingleRoute(issueNumber) : describeProposedParts(parts),
        }) +
        planApprovalNote(issueNumber, single) +
        planApprovalWarnings(issue, parts, s.openPrs),
      rule: 'plan-approval',
      reason: single
        ? `Issue #${issueNumber} was planned as a single pull request and approval is required before it is picked up.`
        : `Issue #${issueNumber} was decomposed into ${parts.length} part(s) and approval is required before any of them is scheduled.`,
    } satisfies RawAction);
  }
}
