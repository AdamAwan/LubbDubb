import { supersededReason } from '../admission.js';
import { budgetNote } from '../../pr/prSplit.js';
import { atomNote } from '../../plans/atoms.js';
import { PLAN_FILE } from '../../plans/planDocument.js';
import { issueOrigin, planBranch, planOrigin } from '../../plans/planning.js';
import { currentPlanSummary } from '../../plans/parts.js';
import { relatedWorkNote } from '../../issueRelations.js';
import { readOnlyDispatch, readOnlyNote } from './readOnlyDispatch.js';
import { sequenceHoldReason } from '../../sequence/readiness.js';
import { SITTING_REASON } from '../../intake/sitting.js';
import { goalCriteriaNote } from '../../criteria/note.js';
import type { RuleHeld } from '../admission.js';
import type { Issue, Plan } from '../../types.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `issue-plan`)

function planHold(
  s: StageContext,
  issueNumber: number,
  reason: string,
  planner: 'dispatch' | 'cooldown',
): { reason: string; held: RuleHeld | undefined } {
  const supersededBy = s.appraising.has(issueNumber) ? ('issue-appraisal' as const) : null;
  const waits = s.sequenceWaits.get(issueNumber);
  const sitting = !supersededBy && s.sittingHolds(issueNumber);
  if (supersededBy) return { reason: supersededReason(supersededBy, reason), held: 'superseded' };
  if (sitting) return { reason: `${reason} Held: ${SITTING_REASON}, on the goal in the cockpit.`, held: 'sitting' };
  if (waits) return { reason: `${reason} ${sequenceHoldReason(waits)}`, held: 'sequenced' };
  return { reason, held: planner === 'cooldown' ? 'cooldown' : undefined };
}

function planTemplate(s: StageContext, issue: Issue, branch: string, replanOf: Plan | null): string {
  if (!replanOf) {
    return s.templates.render('issue-plan', {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      branch,
      planFile: PLAN_FILE,
    });
  }
  return s.templates.render('issue-replan', {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    branch,
    planFile: PLAN_FILE,
    current: currentPlanSummary(
      replanOf,
      (s.ctx.planParts ?? []).filter((p) => p.planId === replanOf.id),
      s.prRefStyle,
    ),
  });
}

export function issuePlan(s: StageContext): void {
  for (const { issue } of s.eligibleIssues) {
    const route = s.routes.get(issue.number);
    if (route?.route !== 'planning') continue;
    const origin = planOrigin(issue.number);
    if (s.activeOrigins.has(origin)) continue;
    const branch = planBranch(issue.number);
    const existing = s.plansByOrigin.get(issueOrigin(issue.number)) ?? null;
    const replan = existing !== null && existing.status === 'planning';
    const title = replan ? `Replan issue #${issue.number}` : `Plan issue #${issue.number}`;
    const reason = replan
      ? `Issue #${issue.number} was sent back for replanning; plan it again from its current state.`
      : `Open issue #${issue.number} has no plan yet; plan it before dispatching work.`;
    const hold = planHold(s, issue.number, reason, route.planner);
    s.candidates.push({
      origin,
      rule: 'issue-plan',
      title,
      kind: 'code',
      branch,
      reason: hold.reason,
      held: hold.held,
      action: {
        type: 'dispatch_code_agent',
        ...readOnlyDispatch(branch, s.defaultBranch),
        title,
        prompt:
          planTemplate(s, issue, branch, replan ? existing : null) +
          readOnlyNote(
            `Your plan needs neither: plan_submit records it directly, and ${PLAN_FILE} is read off disk where ` +
              'you write it.',
          ) +
          goalCriteriaNote(s.criteriaFor(issue.number)) +
          budgetNote(s.planning.fileBudget) +
          atomNote() +
          relatedWorkNote(issue, s.pickup.containerTypes, s.parentCandidates, s.pickup.parentedTypes) +
          s.watchNote +
          s.testPartNote +
          s.screenCheckNote,
        originRef: origin,
        originTitle: issue.title,
        originSummary: issue.body,
        rule: 'issue-plan',
        reason,
      } satisfies RawAction,
    });
  }
}
