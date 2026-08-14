import type { Plan } from '../../src/types.js';
import type { Store } from '../../src/store/store.js';

/**
 * Persist the same `single` verdict for a goal, for a test that runs a whole
 * cycle rather than calling a rule directly.
 *
 * The row is what the planner would have written, so the issue arrives at pickup
 * the way it does in a real run — rather than the test turning a funnel off that
 * no deployment can turn off.
 */
export function planAsSingle(store: Store, issueNumber: number, title = `Issue #${issueNumber}`): Plan {
  return store.upsertPlan({
    originRef: `issue:${issueNumber}`,
    title,
    status: 'active',
    reason: 'One pull request.',
  });
}

/**
 * A plan whose verdict is **one pull request** — the `single` arm, which is a
 * plan row with no parts.
 *
 * The funnel is unconditional, so an issue with no plan row is an issue a planner
 * is owed and pickup is narrowed away from it. A test about anything downstream of
 * pickup therefore has to say the planner has already spoken, and this is that
 * sentence written once: the alternative is every such test carrying nineteen
 * null columns it has no opinion about.
 */
export function singlePlan(issueNumber: number, over: Partial<Plan> = {}): Plan {
  const at = '2026-07-25T00:00:00.000Z';
  return {
    id: `plan_${issueNumber}`,
    originRef: `issue:${issueNumber}`,
    title: `Issue #${issueNumber}`,
    status: 'active',
    reason: 'One pull request.',
    diagnosis: null,
    approach: null,
    risks: null,
    outOfScope: null,
    alternatives: null,
    openQuestions: null,
    verification: null,
    evidence: [],
    document: null,
    discussing: false,
    statusCommentRef: null,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}
