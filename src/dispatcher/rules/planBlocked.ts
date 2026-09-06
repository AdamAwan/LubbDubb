import { askedAlready } from '../admission.js';
import { issueWatchGateReason } from '../issuePickup.js';
import { planOrigin } from '../../plans/planning.js';
import { planIsWedged, wedgedPlanPrompt } from '../../plans/planWedge.js';
import { liveParts, planIssueNumber } from '../../plans/parts.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `plan-blocked`)

export function planBlocked(s: StageContext): void {
  const { ctx } = s;
  for (const plan of ctx.plans ?? []) {
    if (plan.status !== 'active') continue;
    const issueNumber = planIssueNumber(plan.originRef);
    if (issueNumber === null) continue;
    const issue = s.liveIssue(issueNumber);
    if (!issue || issue.state !== 'open') continue;
    if (issueWatchGateReason(issue, s.pickup) !== null) continue;
    const parts = liveParts((ctx.planParts ?? []).filter((p) => p.planId === plan.id));
    if (!planIsWedged(parts)) continue;
    const wedgeOrigin = planOrigin(issueNumber);
    if (askedAlready(wedgeOrigin, ctx.openEscalations, ctx.recentDecisions)) continue;
    s.raw.push({
      type: 'escalate_to_human',
      escalationType: 'resolve_ambiguity',
      prompt: wedgedPlanPrompt(issueNumber, issue, parts, s.openPrs),
      context: { originRef: wedgeOrigin, taskTitle: issue.title },
      rule: 'plan-blocked',
      reason:
        `Issue #${issueNumber}'s approved plan is going nowhere — something is blocked and nothing is moving, ` +
        `so nothing will be dispatched for it.`,
    } satisfies RawAction);
  }
}
