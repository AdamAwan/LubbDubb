import { askedAlready } from '../admission.js';
import { issueWatchGateReason } from '../issuePickup.js';
import { planOrigin } from '../../plans/planning.js';
import { planIsWedged, wedgedPlanPrompt } from '../../plans/planWedge.js';
import { liveParts, planIssueNumber } from '../../plans/parts.js';
import type { RawAction, StageContext } from './context.js';

/**
 * A released plan that is going nowhere. The reconciler already knows — it blocks
 * the parts and records the reason — but an error is a feed entry, and a feed is
 * not a question. Without this, an approved decomposition whose parts all blocked
 * showed two red machines, no agent, and nothing in "Needs you"; the operator's own
 * approval was the last thing that happened to it.
 *
 * Only `active` plans. An unapproved one is already in front of a human, and
 * `planApprovalWarnings` puts the same fact in that ask — escalating as well would
 * be the same sentence twice, to the same person, about a decomposition they have
 * not authorized.
 */
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
      reason: `Every part of issue #${issueNumber}'s approved plan is blocked, so nothing will be dispatched for it.`,
    } satisfies RawAction);
  }
}
