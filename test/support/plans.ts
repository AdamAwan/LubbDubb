import type { Decision, Plan } from '../../src/types.js';
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

export function pastTheFunnel(issueNumber: number, at = '2026-07-25T00:00:00.000Z'): Decision[] {
  return [...spentAppraisalAttempts(issueNumber, at), ...spentPlannerAttempts(issueNumber, at)];
}

export function failPlanningOpen(store: Store, issueNumber: number): void {
  record(store, pastTheFunnel(issueNumber));
}

export function failAppraisalOpen(store: Store, issueNumber: number): void {
  record(store, spentAppraisalAttempts(issueNumber));
}

function record(store: Store, decisions: Decision[]): void {
  for (const decision of decisions) {
    store.recordDecision({ cycleId: decision.cycleId, action: decision.action, outcome: 'executed', detail: '' });
  }
}

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
