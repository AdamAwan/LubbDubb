import type { Store } from '../store/store.js';
import type { PlanPart } from '../types.js';
import { amendedPlanStatus, liveParts, partsToRetire } from './parts.js';

/**
 * What a human's verdict on a decomposition *does* to the plan (issue #109
 * phase 3). Two functions, one shape: read the plan, refuse unless it is still
 * the thing that was proposed, write one status, say what happened.
 *
 * Both are compare-and-set against `awaiting_approval` for the same reason
 * `Store.decideProposal` is one against `pending`: a verdict that arrives after
 * the plan moved on — an operator who hit Replan with the card still open — must
 * not release or refuse a decomposition nobody was shown. `better-sqlite3` writes
 * are synchronous, so the read-then-write here is race-free by construction.
 */

/**
 * The decomposition as the operator is asked to authorize it — every part, in
 * dispatch order, with what it stacks on. The whole point of the gate is that a
 * human weighs the *shape* of the split, so the ask carries it rather than a
 * count and a link to the panel.
 */
export function describeProposedParts(parts: PlanPart[]): string {
  const live = liveParts(parts);
  if (live.length === 0) return 'The plan declares no parts.';
  return live
    .map((p) => {
      const dep = p.dependsOn[0];
      const stacks = dep === undefined ? '' : `, stacks on "${dep}"`;
      return `- "${p.slug}": ${p.title}${stacks} — ${p.scope}`;
    })
    .join('\n');
}

/** The outcome of settling a plan, in the form both callers audit. */
export interface PlanSettlement {
  ok: boolean;
  detail: string;
}

/**
 * Approve: the decomposition becomes work. One status write and rule 4a starts
 * scheduling its parts on the next pulse — which is the entire effect, because
 * `awaiting_approval` was never anything but `active` with the gate closed.
 */
export function releasePlan(store: Store, planId: string, originRef: string): PlanSettlement {
  const plan = store.getPlan(planId);
  if (!plan) return { ok: false, detail: `plan ${planId} for ${originRef} no longer exists` };
  if (plan.status !== 'awaiting_approval')
    return { ok: false, detail: `plan ${planId} is "${plan.status}", not awaiting approval — nothing released` };
  store.setPlanStatus(planId, 'active');
  const parts = liveParts(store.listPlanParts(planId)).length;
  return { ok: true, detail: `released the ${parts}-part plan for ${originRef}; its parts are now schedulable` };
}

/**
 * Refuse: nothing is scheduled from the decomposition — **and the issue is left a
 * route**, which is the half a plain "no" would get wrong.
 *
 * Rejection is durable by design (phase 1), and once the funnel is on a plan is
 * the only thing that schedules anything for an issue: rule 3b parks the work item
 * in the review state for the life of the plan, and `resolvePlanRoute` fails a
 * spent replan back to `parts` rather than open to `single`. A "no" that only
 * stopped the parts would therefore park the issue for good — the exact failure
 * the planner's fail-open exists to prevent.
 *
 * So a refusal *reassigns* the issue rather than stopping it, using the two rules
 * that already exist for the same question:
 *
 * - Every part nothing has been started for is retired ({@link partsToRetire} with
 *   an empty declaration — a refused decomposition declares no parts), so the
 *   graph says what happened instead of leaving `ready` rows nothing schedules.
 * - The status is then whatever {@link amendedPlanStatus} makes of what survived:
 *   `single`, so rule 4 works the issue as one PR (the pre-funnel path, and the
 *   arm the funnel already falls open to); or `active` when parts *are* in flight,
 *   because an issue whose parts have branches and PRs cannot be collapsed onto
 *   the flat `issue/<n>` branch git will not create beside them. That second case
 *   is a replan being refused: the amendment's new parts are retired and the work
 *   already running carries on, which is the honest reading of "no" once the
 *   decomposition has left the harness.
 *
 * The operator who wants a *different* decomposition rather than either of these
 * has Replan, which is reachable from the same panel.
 */
export function refusePlan(store: Store, planId: string, originRef: string): PlanSettlement {
  const plan = store.getPlan(planId);
  if (!plan) return { ok: false, detail: `plan ${planId} for ${originRef} no longer exists` };
  if (plan.status !== 'awaiting_approval')
    return { ok: false, detail: `plan ${planId} is "${plan.status}", not awaiting approval — nothing changed` };

  const parts = store.listPlanParts(planId);
  const retire = partsToRetire(parts, []);
  for (const part of retire) store.updatePlanPart(part.id, { status: 'retired' });
  const surviving = survivorsOf(parts, retire);
  const status = amendedPlanStatus('single', surviving);
  store.setPlanStatus(planId, status);

  return {
    ok: true,
    detail:
      status === 'single'
        ? `retired ${retire.length} unstarted part(s); ${originRef} falls back to a single pull request`
        : `retired ${retire.length} unstarted part(s); ${surviving.length} part(s) already in flight keep running`,
  };
}

/** The live parts a refusal left standing — everything it did not just retire. */
function survivorsOf(parts: PlanPart[], retired: PlanPart[]): PlanPart[] {
  const gone = new Set(retired.map((p) => p.id));
  return liveParts(parts).filter((p) => !gone.has(p.id));
}
