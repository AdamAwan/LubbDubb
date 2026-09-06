import { askedAlready } from '../admission.js';
import { issueWatchGateReason } from '../issuePickup.js';
import { proposalHold } from '../../proposals/proposals.js';
import { quotedAssessment, shortfallArm, shortfallEscalationPrompt, shortfallRef } from '../../delivery/shortfall.js';
import { issueOrigin } from '../../plans/planning.js';
import { planIssueNumber } from '../../plans/parts.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `issue-shortfall`)

export function issueShortfall(s: StageContext): void {
  const { ctx } = s;
  for (const shortfall of ctx.shortfalls ?? []) {
    const issueNumber = planIssueNumber(shortfall.originRef);
    if (issueNumber === null) continue;
    const issue = s.liveIssue(issueNumber);
    if (!issue || issue.state !== 'open') continue;
    if (issueWatchGateReason(issue, s.pickup) !== null) continue;
    const plan = s.plansByOrigin.get(issueOrigin(issueNumber)) ?? null;
    const routable = plan !== null;
    const arm = shortfallArm(shortfall.cause, routable);
    if (arm === 'none') continue;

    const ref = shortfallRef(issueNumber);
    if (arm === 'escalate') {
      if (askedAlready(ref, ctx.openEscalations, ctx.recentDecisions)) continue;
      s.raw.push({
        type: 'escalate_to_human',
        escalationType: 'resolve_ambiguity',
        prompt: shortfallEscalationPrompt(issueNumber, issue.title, shortfall.cause),
        context: {
          originRef: ref,
          issueNumber,
          taskTitle: issue.title,
          detail: quotedAssessment(shortfall.summary, shortfall.detail),
          detailFrom: 'What the assessor found',
        },
        rule: 'issue-shortfall',
        reason:
          `Issue #${issueNumber} was assessed as not delivered with cause "${shortfall.cause}", which routes to ` +
          `nobody the harness can dispatch.`,
      } satisfies RawAction);
      continue;
    }

    if (proposalHold('shortfall', ref, ctx.proposals ?? [], { rejectionSignals: ctx.rejectionSignals }) !== null)
      continue;
    if (!plan) continue;
    const cause = arm === 'replan' ? 'plan' : 'part';
    s.raw.push({
      type: 'propose_shortfall',
      originRef: shortfall.originRef,
      issueNumber,
      planId: plan.id,
      cause,
      partSlug: shortfall.partSlug,
      summary: shortfall.summary,
      detail: quotedAssessment(shortfall.summary, shortfall.detail),
      prompt: s.templates.render('issue-shortfall', {
        number: issueNumber,
        title: issue.title,
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
