import { issueWatchGateReason } from '../issuePickup.js';
import { planProposalHold, planProposalRef } from '../../proposals/proposals.js';
import { describeProposedParts } from '../../plans/planApproval.js';
import { planApprovalWarnings } from '../../plans/planWedge.js';
import { liveParts, planIssueNumber } from '../../plans/parts.js';
import type { RawAction, StageContext } from './context.js';

/**
 * With `planning.requireApproval` on, a decomposition is a proposal before it is
 * work. Ingestion parks the verdict as `awaiting_approval` and this puts it to the
 * operator — once: the executor writes the proposal, and a pending one holds this
 * rule off the plan (`planProposalHold`, asked here *and* there for the same reason
 * `pr-merge-ready` and the executor both ask about a merge). It claims no headroom;
 * it starts nothing. Accepting releases the plan to `active` and `plan-part` takes
 * over on the next pulse.
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
    const issue = ctx.world.issues.find((i) => i.number === issueNumber);
    if (!issue || issue.state !== 'open') continue;
    if (issueWatchGateReason(issue, s.pickup) !== null) continue;
    if (planProposalHold(planProposalRef(plan.originRef), ctx.proposals ?? []) !== null) continue;
    const parts = liveParts((ctx.planParts ?? []).filter((p) => p.planId === plan.id));
    s.raw.push({
      type: 'propose_plan',
      planId: plan.id,
      originRef: plan.originRef,
      // Appended, never interpolated, for `ciFailureNote`'s reason: an override
      // that never learned a `{warnings}` token would silently drop this on
      // exactly the deployments that customised most.
      prompt:
        s.templates.render('plan-approval', {
          number: issueNumber,
          title: issue.title,
          parts: parts.length,
          reason: plan.reason ?? 'the planner gave no reason',
          list: describeProposedParts(parts),
        }) + planApprovalWarnings(issue, parts, s.openPrs),
      rule: 'plan-approval',
      reason: `Issue #${issueNumber} was decomposed into ${parts.length} part(s) and approval is required before any of them is scheduled.`,
    } satisfies RawAction);
  }
}
