import {
  authoringBriefing,
  checkSetAuthored,
  validationPlanBranch,
  validationPlanOrigin,
} from '../../validation/authoring.js';
import { dispatchDeliveredAuthor } from './deliveredAuthor.js';
import type { StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rule `validation-plan`)

export function validationPlan(s: StageContext): void {
  dispatchDeliveredAuthor(s, {
    rule: 'validation-plan',
    owed: (origin) =>
      !checkSetAuthored({
        record: s.validationPlans.get(origin) ?? null,
        checks: s.validationChecks.get(origin) ?? [],
      }),
    origin: validationPlanOrigin,
    branch: validationPlanBranch,
    title: (n) => `Write the validation check set for issue #${n}`,
    reason: (issue) => `Issue #${issue.number} is delivered and nobody has written its validation check set.`,
    prompt: (issue, plan) =>
      s.templates.render('validation-plan', { number: issue.number, title: issue.title, body: issue.body }) +
      authoringBriefing({
        hint: s.validationPlans.get(plan.originRef)?.hint ?? null,
        parts: (s.ctx.planParts ?? []).filter((p) => p.planId === plan.id),
        environments: s.validationPlanNote,
      }),
  });
}
