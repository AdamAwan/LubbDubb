import { watchOwed, watchPlanBranch, watchPlanOrigin } from '../../validation/watchAuthoring.js';
import { dispatchDeliveredAuthor, watchBriefing } from './deliveredAuthor.js';
import type { StageContext } from './context.js';

// → docs/spec/29-post-deploy-watch.md#the-assessor-on-delivered-writes-the-checks (rule `watch-plan`)

export function watchPlan(s: StageContext): void {
  dispatchDeliveredAuthor(s, {
    rule: 'watch-plan',
    owed: (origin) => watchOwed({ record: s.watchPlans.get(origin) ?? null, planned: true }),
    origin: watchPlanOrigin,
    branch: watchPlanBranch,
    title: (n) => `Write the post-deploy watch for issue #${n}`,
    reason: (issue, origin) =>
      s.watchPlans.get(origin)?.sentBackWords != null
        ? `Issue #${issue.number}'s post-deploy watch was sent back by the operator.`
        : `Issue #${issue.number} is delivered and nobody has written its post-deploy watch.`,
    prompt: (issue, plan) =>
      s.templates.render('watch-plan', { number: issue.number, title: issue.title, body: issue.body }) +
      watchBriefing(s, plan, s.watchPlans.get(plan.originRef) ?? null),
  });
}
