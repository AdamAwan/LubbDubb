import { revealGateOn, type Config } from '../config/config.js';
import type { PredictionStore } from '../store/predictions.js';
import type { Store } from '../store/store.js';
import type { Plan } from '../types.js';

/**
 * What deciding this question needs, rather than the whole `System`. `System`
 * satisfies it structurally, so every caller there is unchanged — but stating it
 * this narrowly is what lets the composition root hand the *answer* to a channel
 * that must never be able to ask it, the desktop MCP server above all.
 */
interface RevealReader {
  config: Config;
  predictions: PredictionStore;
}

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
export function planIsWithheld(reader: RevealReader, plan: Plan | null | undefined): boolean {
  if (plan === null || plan === undefined) return false;
  if (!revealGateOn(reader.config)) return false;
  if (plan.status !== 'awaiting_approval') return false;
  return reader.predictions.getReveal(plan.originRef) === null;
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
export function withheldPlanRefusal(reader: RevealReader & { store: Store }, planId: unknown): string | null {
  if (typeof planId !== 'string') return null;
  if (!planIsWithheld(reader, reader.store.plans.getPlan(planId))) return null;
  return 'this goal’s plan has not been revealed yet — POST /api/goals/:number/reveal first, which hands you the plan';
}

/**
 * The same action with every field that can carry plan prose replaced. One helper,
 * because the proposal, the escalation behind it and the Decision row that recorded
 * it are three copies of one action — and redacting two of the three is redacting
 * none of them.
 */
export function withheldAction<T extends object>(action: T): T {
  return { ...action, prompt: WITHHELD_PLAN, detail: WITHHELD_PLAN, caveats: [] };
}

/**
 * An escalation as it may be broadcast, with the plan prose taken out when its plan
 * is withheld. The socket reaches every open cockpit the moment a plan is proposed,
 * which is before any reveal can have happened — so an unredacted relay would put
 * the body in the browser ahead of the gate that exists to keep it out.
 */
export function withheldEscalation(reader: RevealReader & { store: Store }, escalation: unknown): unknown {
  if (typeof escalation !== 'object' || escalation === null) return escalation;
  const context: unknown = (escalation as { context?: unknown }).context;
  const planId: unknown =
    typeof context === 'object' && context !== null ? (context as { planId?: unknown }).planId : undefined;
  if (typeof planId !== 'string') return escalation;
  if (!planIsWithheld(reader, reader.store.plans.getPlan(planId))) return escalation;
  return {
    ...escalation,
    prompt: WITHHELD_PLAN,
    context: { ...(context as object), detail: WITHHELD_PLAN, detailFrom: 'Withheld until the plan is revealed' },
  };
}
