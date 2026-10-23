import type { Decision, Plan, PlanPart } from '../../src/types.js';
import type { Store } from '../../src/store/store.js';
import { DEFAULT_COOLDOWN } from '../../src/dispatcher/dispatchCooldown.js';
import { planOrigin } from '../../src/plans/planning.js';
import { appraisalOrigin } from '../../src/intake/appraisal.js';

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

export function spentAppraisalAttempts(issueNumber: number, at = '2026-07-25T00:00:00.000Z'): Decision[] {
  const origin = appraisalOrigin(issueNumber);
  return Array.from({ length: DEFAULT_COOLDOWN.maxAttempts }, (_, i) => ({
    id: `dec_appraisal_${issueNumber}_${i}`,
    cycleId: `cyc_appraisal_${issueNumber}_${i}`,
    action: {
      type: 'dispatch_code_agent' as const,
      branch: `appraisal/issue/${issueNumber}`,
      title: `Appraise issue #${issueNumber}`,
      prompt: 'appraise it',
      originRef: origin,
      rule: 'issue-appraisal',
      reason: `Issue #${issueNumber} needs a goal check.`,
    },
    outcome: 'executed' as const,
    detail: '',
    rule: 'issue-appraisal',
    admission: null,
    createdAt: at,
  }));
}

export function failAppraisalOpen(store: Store, issueNumber: number): void {
  record(store, spentAppraisalAttempts(issueNumber));
}

function record(store: Store, decisions: Decision[]): void {
  for (const decision of decisions) {
    store.decisions.recordDecision({
      cycleId: decision.cycleId,
      action: decision.action,
      outcome: 'executed',
      detail: '',
    });
  }
}

export function planWithOnePart(store: Store, issueNumber: number, title = `Issue #${issueNumber}`): Plan {
  const plan = store.plans.upsertPlan({
    originRef: `issue:${issueNumber}`,
    title,
    status: 'active',
    reason: 'One pull request of work.',
  });
  store.plans.upsertPlanParts(plan.id, [
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

/**
 * The way a test puts an implementation agent on an issue: the appraisal stood aside and a planner
 * wrote one part, `whole`, so rule `plan-part` dispatches it at `issue:<n>:part:whole` on
 * `issue/<n>/whole`. Nothing is implemented without a plan. → docs/spec/08-planning.md#the-four-arms
 */
export function workedAsOnePart(store: Store, issueNumber: number, title = `Issue #${issueNumber}`): Plan {
  failAppraisalOpen(store, issueNumber);
  return planWithOnePart(store, issueNumber, title);
}

/** `workedAsOnePart` for a test that builds a `DispatchContext` by hand rather than a store. */
export function onePartPlanRows(
  issueNumber: number,
  at = '2026-07-25T00:00:00.000Z',
): { plans: Plan[]; planParts: PlanPart[] } {
  const plan: Plan = {
    id: `plan_${issueNumber}`,
    originRef: `issue:${issueNumber}`,
    title: `Issue #${issueNumber}`,
    status: 'active',
    diagnosis: null,
    approach: null,
    reason: 'One pull request of work.',
    risks: null,
    outOfScope: null,
    alternatives: null,
    openQuestions: null,
    verification: null,
    evidence: [],
    document: null,
    statusCommentRef: null,
    createdAt: at,
    updatedAt: at,
  };
  const part: PlanPart = {
    id: `part_${issueNumber}_whole`,
    planId: plan.id,
    slug: 'whole',
    seq: 1,
    title: `Issue #${issueNumber}`,
    scope: 'the whole issue',
    touches: [],
    rationale: null,
    acceptance: null,
    acceptanceMet: [],
    size: null,
    expectedKind: null,
    outcomeKind: null,
    outcomeRef: null,
    outcomeSummary: null,
    dependsOn: [],
    branch: null,
    prNumber: null,
    status: 'ready',
    blockedReason: null,
    blockedBy: null,
    taskId: null,
    createdAt: at,
    updatedAt: at,
  };
  return { plans: [plan], planParts: [part] };
}

/** `onePartPlanRows` for a goal whose one part has merged: the plan the assessor reads delivery against. */
export function deliveredPlanRows(issueNumber: number, at?: string): { plans: Plan[]; planParts: PlanPart[] } {
  const { plans, planParts } = onePartPlanRows(issueNumber, at);
  return {
    plans: plans.map((p) => ({ ...p, status: 'complete' })),
    planParts: planParts.map((p) => ({ ...p, status: 'merged', branch: `issue/${issueNumber}/whole` })),
  };
}
