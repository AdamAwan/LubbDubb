import { issueWatchGateReason } from '../issuePickup.js';
import { planAmendmentHold, planAmendmentProposalRef } from '../../proposals/proposals.js';
import { planIssueNumber } from '../../plans/parts.js';
import type { RawAction, StageContext } from './context.js';

/**
 * A change to a plan that is **already running** is a proposal, exactly as the
 * plan itself was.
 *
 * `src/plans/planAmendment.ts` says why the row exists at all; this is only what
 * puts it in front of somebody. It is `plan-approval` with one field moved: the
 * pending row is the amendment rather than the plan's status, the hold is
 * {@link planAmendmentHold}, and the thing it must **not** do is touch the plan —
 * every part that was dispatchable stays dispatchable while the question is open,
 * which is the whole difference between this and a replan.
 *
 * The plan must be `active`. An amendment against one that has since been
 * replanned, refused or backed out is settled where the world moved
 * (`supersedePlanAmendments`), so the row this skips is one already on its way to
 * `superseded` — and skipping is the safe direction either way: an amendment
 * cannot be applied outside `active`, so asking about one would be asking a
 * question no answer can settle.
 *
 * It claims no headroom and starts nothing, like every other proposing rule. The
 * card's body is built by the executor rather than here, because it is a reading
 * of the plan out of the store rather than of the cycle's world.
 */
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
      // The settlement is appended rather than interpolated, for `plan-approval`'s
      // reason: an override that never learned a `{settlement}` token would drop it
      // silently on exactly the deployments that customised most.
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

/**
 * What the two answers do. Both halves matter and neither is obvious from the
 * card: accepting does **not** stop anything, and rejecting does **not** send the
 * plan back to a planner — the two things an operator would reasonably assume from
 * every other plan verdict they have answered.
 */
const AMENDMENT_SETTLEMENT =
  '\n\nAccept and the amended plan is ingested over the live one: parts that already have a branch, a pull ' +
  'request or an outcome keep them and only their declaration is refreshed, a new part becomes schedulable on ' +
  'the next pulse, and a dropped part nothing was started for is retired. Nothing that is running is stopped — ' +
  'end a run yourself if it should. Reject and nothing changes at all: the plan carries on exactly as it is.';
