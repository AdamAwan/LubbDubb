import { revealGateOn } from '../config/config.js';
import type { System } from '../system.js';
import type { Plan } from '../types.js';

// → docs/spec/16-http-api.md#the-plan-body-is-withheld-until-it-is-revealed

/**
 * What stands in for a plan's prose everywhere it would otherwise ship. The
 * cockpit draws the gate off `PlanView.revealed`, not off this sentence; this is
 * what any other reader of the payload sees.
 */
export const WITHHELD_PLAN =
  'A plan is ready for this goal. It is withheld until you reveal it, on the goal in the cockpit.';

/**
 * Whether this plan's body must be kept out of the payload.
 *
 * One predicate, read by the snapshot and by every route that can hand back plan
 * prose. A second copy of it is how one of them comes to disagree, and the
 * disagreement would be silent — the gate would still render, and the body would
 * be one fetch away.
 *
 * The `awaiting_approval` arm matters as much as the reveal stamp: a plan
 * approved while the gate was off has no stamp and never will, and withholding on
 * the missing stamp alone would leave it withheld for ever.
 */
export function planIsWithheld(system: System, plan: Plan | null | undefined): boolean {
  if (plan === null || plan === undefined) return false;
  if (!revealGateOn(system.config)) return false;
  if (plan.status !== 'awaiting_approval') return false;
  return system.predictions.getReveal(plan.originRef) === null;
}

/**
 * The refusal a route owes an operator acting on a plan they have not revealed,
 * or null when there is nothing to refuse.
 *
 * Deciding a plan is not only a way to read its prose back out of the response —
 * it is the decision the gate stands in front of. Approving or refusing a plan
 * sight-unseen would settle the goal with `revealed_at` never stamped, so it
 * would read as *never offered* when in truth the operator acted on it. Revealing
 * first is one press, and if they then want nothing to do with the plan the
 * record says so honestly: revealed, not predicted on.
 */
export function withheldPlanRefusal(system: System, planId: unknown): string | null {
  if (typeof planId !== 'string') return null;
  if (!planIsWithheld(system, system.store.plans.getPlan(planId))) return null;
  return 'this goal’s plan has not been revealed yet — POST /api/goals/:number/reveal first, which hands you the plan';
}
