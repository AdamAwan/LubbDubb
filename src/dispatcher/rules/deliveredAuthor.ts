import { issueWatchGateReason } from '../issuePickup.js';
import { issueOrigin } from '../../plans/planning.js';
import { watchAuthoringBriefing } from '../../validation/watchAuthoring.js';
import { readOnlyDispatch } from './readOnlyDispatch.js';
import type { Issue, Plan, WatchPlanRecord } from '../../types.js';
import type { DispatchRuleId } from '../rules.js';
import type { RawAction, StageContext } from './context.js';

// → docs/spec/05-dispatcher.md (rules `validation-plan` and `watch-plan`)

/**
 * The shape `validation-plan` and `watch-plan` share: a goal parked as delivered, with a plan, that is still
 * owed something only a reader of the merged code can write, gets one code agent in a read-only checkout of
 * the default branch. A goal with no plan is skipped — both tools refuse one, and an agent dispatched to be
 * refused is spend with no outcome.
 */
export function dispatchDeliveredAuthor(
  s: StageContext,
  spec: {
    rule: DispatchRuleId;
    owed: (origin: string, plan: Plan) => boolean;
    origin: (issueNumber: number) => string;
    branch: (issueNumber: number) => string;
    title: (issueNumber: number) => string;
    reason: (issue: Issue, origin: string) => string;
    prompt: (issue: Issue, plan: Plan) => string;
  },
): void {
  for (const issue of s.ctx.world.issues) {
    if (issueWatchGateReason(issue, s.pickup) !== null) continue;
    if (!s.deliveryParked(issue)) continue;
    const root = issueOrigin(issue.number);
    const plan = s.plansByOrigin.get(root) ?? null;
    if (plan === null || !spec.owed(root, plan)) continue;
    const origin = spec.origin(issue.number);
    const branch = spec.branch(issue.number);
    const title = spec.title(issue.number);
    const reason = spec.reason(issue, root);
    s.consider({
      origin,
      rule: spec.rule,
      title,
      kind: 'code',
      branch,
      reason,
      action: {
        type: 'dispatch_code_agent',
        ...readOnlyDispatch(branch, s.defaultBranch),
        title,
        prompt: spec.prompt(issue, plan),
        originRef: origin,
        originTitle: issue.title,
        originSummary: issue.body,
        rule: spec.rule,
        reason,
      } satisfies RawAction,
    });
  }
}

/** Everything a watch author reads, for the assessor's appendix and rule `watch-plan` alike. */
export function watchBriefing(s: StageContext, plan: Plan, record: WatchPlanRecord | null): string {
  return watchAuthoringBriefing({
    hint: plan.watchHint,
    tickWords: s.watchTickWords.get(plan.id) ?? [],
    sentBackWords: record?.sentBackWords ?? null,
    environments: s.watchPlanNote,
  });
}
