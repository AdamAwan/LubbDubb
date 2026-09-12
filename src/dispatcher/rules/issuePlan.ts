import { supersededReason } from '../admission.js';
import { budgetNote } from '../../pr/prSplit.js';
import { atomNote } from '../../plans/atoms.js';
import { PLAN_FILE } from '../../plans/planDocument.js';
import { issueOrigin, planBranch, planOrigin } from '../../plans/planning.js';
import { currentPlanSummary } from '../../plans/parts.js';
import { relatedWorkNote } from '../../issueRelations.js';
import { sequenceHoldReason } from '../../sequence/readiness.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `issue-plan`)

export function issuePlan(s: StageContext): void {
  const { ctx } = s;
  for (const { issue } of s.eligibleIssues) {
    const route = s.routes.get(issue.number);
    if (route?.route !== 'planning') continue;
    const supersededBy = s.appraising.has(issue.number) ? ('issue-appraisal' as const) : null;
    const origin = planOrigin(issue.number);
    if (s.activeOrigins.has(origin)) continue;
    const branch = planBranch(issue.number);
    const existing = s.plansByOrigin.get(issueOrigin(issue.number)) ?? null;
    const replan = existing !== null && existing.status === 'planning';
    const title = replan ? `Replan issue #${issue.number}` : `Plan issue #${issue.number}`;
    const reason = replan
      ? `Issue #${issue.number} was sent back for replanning; plan it again from its current state.`
      : `Open issue #${issue.number} has no plan yet; plan it before dispatching work.`;
    const waits = s.sequenceWaits.get(issue.number);
    s.candidates.push({
      origin,
      rule: 'issue-plan',
      title,
      kind: 'code',
      branch,
      reason: supersededBy
        ? supersededReason(supersededBy, reason)
        : waits
          ? `${reason} ${sequenceHoldReason(waits)}`
          : reason,
      held: supersededBy ? 'superseded' : waits ? 'sequenced' : route.planner === 'cooldown' ? 'cooldown' : undefined,
      action: {
        type: 'dispatch_code_agent',
        branch,
        title,
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
                  s.prRefStyle,
                ),
              })
            : s.templates.render('issue-plan', {
                number: issue.number,
                title: issue.title,
                body: issue.body,
                branch,
                planFile: PLAN_FILE,
              })) +
          budgetNote(s.planning.fileBudget) +
          atomNote() +
          relatedWorkNote(issue, s.pickup.containerTypes, s.parentCandidates, s.pickup.parentedTypes) +
          s.watchNote +
          s.testPartNote,
        originRef: origin,
        originTitle: issue.title,
        originSummary: issue.body,
        rule: 'issue-plan',
        reason,
      } satisfies RawAction,
    });
  }
}
