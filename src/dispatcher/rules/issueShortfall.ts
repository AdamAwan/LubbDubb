import { askedAlready } from '../admission.js';
import { issueWatchGateReason } from '../issuePickup.js';
import { proposalHold } from '../../proposals/proposals.js';
import { shortfallArm, shortfallRef } from '../../delivery/shortfall.js';
import { issueOrigin } from '../../plans/planning.js';
import { planIssueNumber } from '../../plans/parts.js';
import type { RawAction, StageContext } from './context.js';

/**
 * Act on an assessment that said the goal was *not* reached (issue #159).
 *
 * The gap this closes: the check existed (`issue-assess`) and the replan existed
 * (`POST /api/plans/:id/replan`), and nothing joined them. A negative verdict was
 * written into `issue_conclusions`, whose only consumer emits a *tracker* move —
 * so on GitHub it changed no dispatch at all, and on either provider, for a
 * decomposed issue, `issue-pickup` is gated on the `single` route while `plan-part`
 * finds every part settled. The assessor said "not delivered" and the harness
 * scheduled nothing, anywhere. This is the one consumer of the row that says so.
 *
 * Three arms, chosen by the cause the assessor *declared* — deriving it would
 * route every shortfall to a replan and re-decompose plans whose shape was never
 * the problem, which is the issue's own stated failure mode. Two of them spend a
 * fleet, so they are put to a human; the third asks a human and schedules nothing,
 * so it is an escalation rather than a proposal (accepting and rejecting "do
 * nothing" are the same act, and that is not a decision).
 *
 * Read off `ctx.shortfalls` rather than `eligibleIssues` for `issue-assess` and
 * `plan-part`'s reason: an issue that has been worked has a PR, open or not, and
 * the workflow-state gate is exactly what parks it while this question matters.
 */
export function issueShortfall(s: StageContext): void {
  const { ctx } = s;
  for (const shortfall of ctx.shortfalls ?? []) {
    const issueNumber = planIssueNumber(shortfall.originRef);
    if (issueNumber === null) continue;
    const issue = ctx.world.issues.find((i) => i.number === issueNumber);
    if (!issue || issue.state !== 'open') continue;
    if (issueWatchGateReason(issue, s.pickup) !== null) continue;
    const plan = s.plansByOrigin.get(issueOrigin(issueNumber)) ?? null;
    // Both plan-shaped arms are performed by rules that only exist with the
    // funnel on — a replan needs `issue-plan` to pick the `planning` plan up, and
    // a follow-up part needs `plan-part` to schedule it. With planning off,
    // accepting either would park the issue on a transition nothing consumes, so
    // the arm degrades to the one that asks a person. Same fail-safe direction as
    // the planner's and the assessor's.
    const routable = plan !== null && s.planning.enabled;
    const arm = shortfallArm(shortfall.cause, routable);
    // Nothing was named beyond "the work is not finished", so there is nothing to
    // route. The verdict still stands and `resolveIssueConclusion` still reads it
    // as `more_work` — what does not happen is a route invented out of silence.
    if (arm === 'none') continue;

    const ref = shortfallRef(issueNumber);
    if (arm === 'escalate') {
      if (askedAlready(ref, ctx.openEscalations, ctx.recentDecisions)) continue;
      s.raw.push({
        type: 'escalate_to_human',
        escalationType: 'resolve_ambiguity',
        prompt:
          `An assessment of issue #${issueNumber} ("${issue.title}") found that the work is done and the ` +
          `goal is still not reached${shortfall.cause === 'goal' ? ', and that the issue itself is what is wrong' : ''}. ` +
          `No agent has been dispatched and none will be: ${
            shortfall.cause === 'goal'
              ? 'a wrong or ambiguous goal is not something a planner or an agent can fix'
              : 'there is no delivery plan here to re-plan or add a part to'
          }. What the assessor found:\n\n"${shortfall.summary}"`,
        context: { originRef: ref, issueNumber, taskTitle: issue.title },
        rule: 'issue-shortfall',
        reason:
          `Issue #${issueNumber} was assessed as not delivered with cause "${shortfall.cause}", which routes to ` +
          `nobody the harness can dispatch.`,
      } satisfies RawAction);
      continue;
    }

    // Arms A and B spend a fleet, so a human authorizes them. The full
    // `proposalHold` applies — including the durable `rejected` arm, unlike a
    // plan proposal — because this row persists until its arm is performed, so
    // without it one refusal would be re-asked every pulse. It expires on world
    // signal like any other rejection.
    if (proposalHold('shortfall', ref, ctx.proposals ?? [], { rejectionSignals: ctx.rejectionSignals }) !== null)
      continue;
    // Both remaining arms transition a plan, so `routable` above already
    // established there is one; this is the narrowing, not a guard.
    if (!plan) continue;
    // Narrowed to the two routable causes by `shortfallArm` above; re-stated here
    // because the action's schema is narrower than the row's column.
    const cause = arm === 'replan' ? 'plan' : 'part';
    s.raw.push({
      type: 'propose_shortfall',
      originRef: shortfall.originRef,
      issueNumber,
      planId: plan.id,
      cause,
      partSlug: shortfall.partSlug,
      summary: shortfall.summary,
      prompt: s.templates.render('issue-shortfall', {
        number: issueNumber,
        title: issue.title,
        summary: shortfall.summary,
        consequence:
          cause === 'plan'
            ? 'Accepting sends the plan back to a planner, which sees the current decomposition and this ' +
              'assessment and amends it. Nothing already in flight is retired.'
            : `Accepting appends one new part to the plan for the scope "${shortfall.partSlug}" fell short of. ` +
              `That part is left exactly as it is — its branch is spent — and no other part is touched.`,
      }),
      rule: 'issue-shortfall',
      reason:
        `Issue #${issueNumber} was assessed as not delivered, with "${cause}" named as what fell short; ` +
        `acting on it spends agents, so it goes to you first.`,
    } satisfies RawAction);
  }
}
