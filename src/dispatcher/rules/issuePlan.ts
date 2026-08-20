import { supersededReason } from '../admission.js';
import { PLAN_FILE } from '../../plans/planDocument.js';
import { issueOrigin, planBranch, planOrigin } from '../../plans/planning.js';
import { currentPlanSummary } from '../../plans/parts.js';
import { relatedWorkNote } from '../../issueRelations.js';
import type { RawAction, StageContext } from './context.js';

/**
 * Put a planning agent in front of pickup. It reads the repo and writes a verdict
 * — one PR or several — which is what makes today's one-agent/one-PR path an
 * explicit outcome of the funnel rather than a bypass. Ranked ahead of
 * `issue-pickup` because a planner *unblocks* work, so it should win a scarce slot
 * before the work it unblocks. There is no escalation arm: a planner that spends
 * its attempt cap without producing a plan fails the issue open to `single` (see
 * `resolvePlanRoute`), so a failure never parks an issue.
 */
export function issuePlan(s: StageContext): void {
  const { ctx } = s;
  for (const { issue } of s.eligibleIssues) {
    const route = s.routes.get(issue.number);
    if (route?.route !== 'planning') continue;
    // `issue-assay` is deciding whether this goal can be worked from at all.
    // Planning it in the same cycle is the exact waste the assay exists to
    // prevent — and would put the decomposition of an unanswerable question in
    // front of an operator. Queued as `superseded` rather than skipped: a
    // planner that silently never appeared was the same invisibility `capped`
    // was named to fix.
    const supersededBy = s.assaying.has(issue.number) ? ('issue-assay' as const) : null;
    const origin = planOrigin(issue.number);
    if (s.activeOrigins.has(origin)) continue; // a planner is already on it
    const branch = planBranch(issue.number);
    // Ingestion only ever writes `single`/`active`, so a plan row sitting in
    // `planning` is an operator's replan request: same rule, same origin, same
    // ingestion path — but the planner is primed with what already exists rather
    // than being asked to plan the issue cold. Without that it would re-derive a
    // decomposition from scratch and give the parts new slugs, which is precisely
    // what would strand the in-flight ones.
    const existing = s.plansByOrigin.get(issueOrigin(issue.number)) ?? null;
    const replan = existing !== null && existing.status === 'planning';
    // There is no third arm here any more. Discussing a plan used to be a replan
    // whose planner talked first, dispatched from this same status with only the
    // prompt to tell the two apart; it is now a deep link into the operator's own
    // Claude Code, which amends the plan through `plan_amend` and dispatches
    // nothing. What is left is the distinction that was always load-bearing:
    // whether there is an existing decomposition to plan *from*.
    const title = replan ? `Replan issue #${issue.number}` : `Plan issue #${issue.number}`;
    const reason = replan
      ? `Issue #${issue.number} was sent back for replanning; plan it again from its current state.`
      : `Open issue #${issue.number} has no plan yet; plan it before dispatching work.`;
    s.candidates.push({
      origin,
      rule: 'issue-plan',
      title,
      kind: 'code',
      branch,
      reason: supersededBy ? supersededReason(supersededBy, reason) : reason,
      // Superseded outranks the throttle as an explanation: this planner is not
      // going out this cycle whatever the cooldown says. Otherwise throttled
      // like any other origin — kept visible in the queue, not dispatched.
      held: supersededBy ? 'superseded' : route.planner === 'cooldown' ? 'cooldown' : undefined,
      action: {
        type: 'dispatch_code_agent',
        branch,
        title,
        // Appended to whichever of the three prompts this planner got: the scope
        // either side of the item — the feature's goal above it, the sibling
        // stories beside it — is what a decomposition has to fit inside, and a
        // planner that can't see it re-decomposes work someone already has.
        prompt:
          (replan
            ? s.templates.render('issue-replan', {
                number: issue.number,
                title: issue.title,
                body: issue.body,
                branch,
                planFile: PLAN_FILE,
                current: currentPlanSummary(
                  existing!,
                  (ctx.planParts ?? []).filter((p) => p.planId === existing!.id),
                ),
              })
            : s.templates.render('issue-plan', {
                number: issue.number,
                title: issue.title,
                body: issue.body,
                branch,
                planFile: PLAN_FILE,
              })) + relatedWorkNote(issue, s.pickup.containerTypes, s.parentCandidates),
        originRef: origin,
        originTitle: issue.title,
        originSummary: issue.body,
        rule: 'issue-plan',
        reason,
      } satisfies RawAction,
    });
  }
}
