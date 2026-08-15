import type { Decision, Plan } from '../../src/types.js';
import type { Store } from '../../src/store/store.js';
import { DEFAULT_COOLDOWN } from '../../src/dispatcher/dispatchCooldown.js';
import { planOrigin } from '../../src/plans/planning.js';

/**
 * The state in which rule `issue-pickup` works an issue: **the funnel gave up on
 * it.**
 *
 * The funnel is unconditional, so an issue with no plan is an issue a planner is
 * owed and pickup is narrowed away from it. There is exactly one arm left where
 * pickup fires — `unplanned`, reached when the planner has spent its attempt cap —
 * so a test about anything downstream of pickup has to put the issue there.
 *
 * This used to be a plan row saying "one pull request", because that verdict
 * *meant* no parts and was worked by pickup. It is not a thing a planner can say
 * any more: a plan that is one pull request is a plan with one part, and rule
 * `plan-part` schedules it. Writing a partless plan row here would now park the
 * issue instead of releasing it to pickup — the same silence
 * `backfillWholePlanParts` exists to keep off real databases.
 */
export function spentPlannerAttempts(issueNumber: number, at = '2026-07-25T00:00:00.000Z'): Decision[] {
  const origin = planOrigin(issueNumber);
  return Array.from({ length: DEFAULT_COOLDOWN.maxAttempts }, (_, i) => ({
    id: `dec_plan_${issueNumber}_${i}`,
    cycleId: `cyc_plan_${issueNumber}_${i}`,
    action: {
      type: 'dispatch_code_agent' as const,
      branch: `plan/issue/${issueNumber}`,
      title: `Plan issue #${issueNumber}`,
      prompt: 'plan it',
      originRef: origin,
      rule: 'issue-plan',
      reason: `Issue #${issueNumber} needs a plan.`,
    },
    outcome: 'executed' as const,
    detail: '',
    rule: 'issue-plan',
    admission: null,
    createdAt: at,
  }));
}

/**
 * The same fact, persisted, for a test that runs a whole cycle rather than calling
 * a rule directly — the decisions are read back off the store there rather than
 * handed to a context.
 */
export function failPlanningOpen(store: Store, issueNumber: number): void {
  for (const decision of spentPlannerAttempts(issueNumber)) {
    store.recordDecision({ cycleId: decision.cycleId, action: decision.action, outcome: 'executed', detail: '' });
  }
}

/**
 * A plan of one part, as a store write — what a planner writes for work that is
 * one pull request, which is an ordinary plan and not a shape of its own.
 *
 * For a test that wants the *planned* path rather than the fail-open one above.
 */
export function planWithOnePart(store: Store, issueNumber: number, title = `Issue #${issueNumber}`): Plan {
  const plan = store.upsertPlan({
    originRef: `issue:${issueNumber}`,
    title,
    status: 'active',
    reason: 'One pull request of work.',
  });
  store.upsertPlanParts(plan.id, [
    {
      slug: 'whole',
      seq: 1,
      title,
      scope: 'the whole issue',
      touches: [],
      dependsOn: [],
      rationale: null,
      acceptance: null,
      size: null,
      expectedKind: null,
      profile: null,
    },
  ]);
  return plan;
}
