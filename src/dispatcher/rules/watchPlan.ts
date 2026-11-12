import { issueWatchGateReason } from '../issuePickup.js';
import { issueOrigin } from '../../plans/planning.js';
import {
  watchAuthored,
  watchAuthoringBriefing,
  watchPlanBranch,
  watchPlanOrigin,
} from '../../validation/watchAuthoring.js';
import { readOnlyDispatch } from './readOnlyDispatch.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/29-post-deploy-watch.md#the-assessor-on-delivered-writes-the-checks (rule `watch-plan`)

export function watchPlan(s: StageContext): void {
  const { ctx } = s;
  for (const issue of ctx.world.issues) {
    if (issueWatchGateReason(issue, s.pickup) !== null) continue;
    if (!s.deliveryParked(issue)) continue;
    const origin = issueOrigin(issue.number);
    const record = s.watchPlans.get(origin) ?? null;
    if (watchAuthored({ record, hasLiveChecks: s.watchedGoals.has(origin) })) continue;
    const plan = s.plansByOrigin.get(origin) ?? null;
    if (plan === null) continue;

    const planOrigin = watchPlanOrigin(issue.number);
    const branch = watchPlanBranch(issue.number);
    const title = `Write the post-deploy watch for issue #${issue.number}`;
    const reason =
      record?.sentBackAt != null
        ? `Issue #${issue.number}'s post-deploy watch was sent back by the operator.`
        : `Issue #${issue.number} is delivered and nobody has written its post-deploy watch.`;
    s.consider({
      origin: planOrigin,
      rule: 'watch-plan',
      title,
      kind: 'code',
      branch,
      reason,
      action: {
        type: 'dispatch_code_agent',
        ...readOnlyDispatch(branch, s.defaultBranch),
        title,
        prompt:
          s.templates.render('watch-plan', { number: issue.number, title: issue.title, body: issue.body }) +
          watchAuthoringBriefing({
            hint: plan.watchHint,
            tickWords: s.watchTickWords.get(plan.id) ?? [],
            sentBackWords: record?.sentBackAt != null ? record.sentBackWords : null,
            environments: s.watchPlanNote,
          }),
        originRef: planOrigin,
        originTitle: issue.title,
        originSummary: issue.body,
        rule: 'watch-plan',
        reason,
      } satisfies RawAction,
    });
  }
}
