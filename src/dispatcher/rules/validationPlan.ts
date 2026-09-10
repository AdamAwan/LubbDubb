import { dispatchVerdict } from '../dispatchCooldown.js';
import { issueWatchGateReason } from '../issuePickup.js';
import { issueOrigin } from '../../plans/planning.js';
import {
  authoringBriefing,
  checkSetAuthored,
  validationPlanBranch,
  validationPlanOrigin,
} from '../../validation/authoring.js';
import { readOnlyDispatch } from './readOnlyDispatch.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `validation-plan`)

export function validationPlan(s: StageContext): void {
  const { ctx } = s;
  for (const issue of ctx.world.issues) {
    if (issueWatchGateReason(issue, s.pickup) !== null) continue;
    if (!s.deliveryParked(issue)) continue;
    const origin = issueOrigin(issue.number);
    const record = s.validationPlans.get(origin) ?? null;
    if (checkSetAuthored({ record, checks: s.validationChecks.get(origin) ?? [] })) continue;

    // A goal with no plan has no check set to write: `covers` names live part slugs, which are a
    // property of the plan, and `validation_plan` refuses such a goal in as many words. Dispatching
    // an agent to be refused by the tool it was sent to call is spend with no outcome.
    const plan = s.plansByOrigin.get(origin) ?? null;
    if (plan === null) continue;

    const planOrigin = validationPlanOrigin(issue.number);
    const verdict = dispatchVerdict(planOrigin, s.now, ctx.recentDecisions, s.cooldown);
    if (verdict.kind === 'escalate' || verdict.kind === 'hold') continue;

    const title = `Write the validation check set for issue #${issue.number}`;
    const reason = `Issue #${issue.number} is delivered and nobody has written its validation check set.`;
    s.candidates.push({
      origin: planOrigin,
      rule: 'validation-plan',
      title,
      kind: 'code',
      branch: validationPlanBranch(issue.number),
      reason,
      held: verdict.kind === 'cooldown' ? 'cooldown' : undefined,
      action: {
        type: 'dispatch_code_agent',
        ...readOnlyDispatch(validationPlanBranch(issue.number), s.defaultBranch),
        title,
        prompt:
          s.templates.render('validation-plan', {
            number: issue.number,
            title: issue.title,
            body: issue.body,
          }) +
          authoringBriefing({
            hint: record?.hint ?? null,
            parts: (ctx.planParts ?? []).filter((p) => p.planId === plan.id),
            environments: s.validationPlanNote,
          }),
        originRef: planOrigin,
        originTitle: issue.title,
        originSummary: issue.body,
        rule: 'validation-plan',
        reason,
      } satisfies RawAction,
    });
  }
}
