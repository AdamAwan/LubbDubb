import { issueWatchGateReason, openPrForIssue } from '../issuePickup.js';
import { assessBranch, assessOrigin, hasPriorWork } from '../../delivery/assessment.js';
import { issueOrigin } from '../../plans/planning.js';
import { planInFlight } from '../../plans/parts.js';
import { assessAuthoringNote, authoringBriefing, checkSetAuthored } from '../../validation/authoring.js';
import { assessWatchNote, watchAskedOnDelivery } from '../../validation/watchAuthoring.js';
import { watchBriefing } from './deliveredAuthor.js';
import { readOnlyDispatch } from './readOnlyDispatch.js';
import type { Plan } from '../../types.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `issue-assess`)

/**
 * The assessor's second output, on `validation.checkSets` and while nobody has authored a check set
 * yet. Empty otherwise, so the prompt never asks for something the tool would refuse.
 */
function authoringAppendix(s: StageContext, root: string, plan: Plan): string {
  if (!s.checkSets) return '';
  const record = s.validationPlans.get(root) ?? null;
  if (checkSetAuthored({ record, checks: s.validationChecks.get(root) ?? [] })) return '';
  return (
    assessAuthoringNote() +
    authoringBriefing({
      hint: record?.hint ?? null,
      parts: (s.ctx.planParts ?? []).filter((p) => p.planId === plan.id),
      environments: s.validationPlanNote,
    })
  );
}

/**
 * The assessor's third output: the post-deploy watch, where some environment declares one and a
 * `delivered` verdict would ask for it. Appended after the check set's fold, so the order the prompt asks
 * for is the order the turn is safe in. → docs/spec/29-post-deploy-watch.md#the-assessor-on-delivered-writes-the-checks
 */
function watchAppendix(s: StageContext, root: string, plan: Plan): string {
  if (s.watchPlanNote === '') return '';
  const record = s.watchPlans.get(root) ?? null;
  if (!watchAskedOnDelivery({ record, hasLiveChecks: s.watchedGoals.has(root), planned: true })) return '';
  return assessWatchNote() + watchBriefing(s, plan, record);
}

export function issueAssess(s: StageContext): void {
  const { ctx } = s;
  for (const issue of ctx.world.issues) {
    if (issue.state !== 'open' && !s.retained.has(issue.number)) continue;
    if (issueWatchGateReason(issue, s.pickup) !== null) continue;
    if (openPrForIssue(issue, s.openPrs) !== null) continue;
    if (s.deliveryParked(issue)) continue;
    if (!hasPriorWork(issue.number, ctx.tasks)) continue;
    const root = issueOrigin(issue.number);
    const plan = s.plansByOrigin.get(root);
    if (!plan || planInFlight(plan)) continue;
    const origin = assessOrigin(issue.number);
    if (s.activeOrigins.has(origin)) continue;
    if ([...s.activeOrigins].some((o) => o === root || o.startsWith(`${root}:`))) continue;

    const branch = assessBranch(issue.number);
    const title = `Assess issue #${issue.number}`;
    const reason = `Issue #${issue.number} has had work and has nothing in flight; assess whether it is finished.`;
    s.consider({
      origin,
      rule: 'issue-assess',
      title,
      kind: 'code',
      branch,
      reason,
      action: {
        type: 'dispatch_code_agent',
        ...readOnlyDispatch(branch, s.defaultBranch),
        title,
        prompt:
          s.templates.render('issue-assess', {
            number: issue.number,
            title: issue.title,
            body: issue.body,
            branch,
          }) +
          authoringAppendix(s, root, plan) +
          watchAppendix(s, root, plan),
        originRef: origin,
        originTitle: issue.title,
        originSummary: issue.body,
        rule: 'issue-assess',
        reason,
      } satisfies RawAction,
    });
  }
}
