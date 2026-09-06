import type { Store } from '../store/store.js';
import type { Plan, PlanPart } from '../types.js';
import { liveParts, partsToRetire } from './parts.js';
import { REFUSED_PART_RESOLUTION, withdrawPartAsks } from './partAsks.js';
import { followupPartInput, followupSlot } from '../delivery/shortfall.js';

/**
 * What a human's verdict *does* to the plan: read the plan, refuse unless it is still the
 * thing that was proposed, write, say what happened.
 */

/**
 * The plan as the operator is asked to authorize it — every part, in dispatch order, with
 * what it stacks on.
 */
export function describeProposedParts(parts: PlanPart[]): string {
  const live = liveParts(parts);
  if (live.length === 0) return 'The plan declares no parts.';
  return live
    .map((p) => {
      // Every prerequisite: a rejoin whose second dependency went unmentioned
      // would read as a plain chain.
      const stacks = p.dependsOn.length === 0 ? '' : `, stacks on ${p.dependsOn.map((d) => `"${d}"`).join(' + ')}`;
      return `- "${p.slug}": ${p.title}${stacks} — ${p.scope}`;
    })
    .join('\n');
}

/**
 * What the operator reads on the card: `diagnosis` and `approach` — whether the work is
 * right at all — with the split left behind "Read the full plan".
 */
export function planApprovalDetail(plan: Pick<Plan, 'diagnosis' | 'approach' | 'reason'>): string | null {
  const blocks: string[] = [];
  const diagnosis = plan.diagnosis?.trim();
  const approach = plan.approach?.trim();
  if (diagnosis) blocks.push(`**What's wrong**\n\n${diagnosis}`);
  if (approach) blocks.push(`**What we'll do**\n\n${approach}`);
  if (blocks.length === 0) {
    const reason = plan.reason?.trim();
    return reason ? reason : null;
  }
  return blocks.join('\n\n');
}

/**
 * What approving and rejecting this verdict do — **appended** to the rendered ask, never
 * interpolated, since an operator override that never learned a placeholder would drop it
 * silently.
 */
export function planApprovalNote(): string {
  return (
    `\n\nApprove and each part gets its own agent, branch and pull request, bottom of the stack first. Reject and ` +
    `the plan goes back to a planner with your reason — nothing is scheduled either way until a plan is approved. ` +
    `If the ticket itself is the problem rather than the plan, back out instead: close the ticket with a comment, ` +
    `or hold it, which stops watching it and sends this plan back — watch it again and a fresh plan is written for it.`
  );
}

/** The outcome of settling a plan, in the form both callers audit. */
interface PlanSettlement {
  ok: boolean;
  detail: string;
}

/** Approve: the plan becomes work. */
export function releasePlan(store: Store, planId: string, originRef: string): PlanSettlement {
  const plan = store.getPlan(planId);
  if (!plan) return { ok: false, detail: `plan ${planId} for ${originRef} no longer exists` };
  if (plan.status !== 'awaiting_approval')
    return { ok: false, detail: `plan ${planId} is "${plan.status}", not awaiting approval — nothing released` };
  const parts = liveParts(store.listPlanParts(planId));
  // A plan with no live parts, if released, schedules nothing and never rolls up,
  // leaving the goal `active` and idle with nothing saying why. Refuse visibly.
  if (parts.length === 0)
    return { ok: false, detail: `plan ${planId} for ${originRef} has no live parts — nothing to release` };
  store.setPlanStatus(planId, 'active');
  return {
    ok: true,
    detail: `released the ${parts.length}-part plan for ${originRef}; its parts are now schedulable`,
  };
}

/** Refuse: nothing is scheduled from the plan — **and the issue is left a route**. */
export function refusePlan(store: Store, planId: string, originRef: string, note?: string | null): PlanSettlement {
  const plan = store.getPlan(planId);
  if (!plan) return { ok: false, detail: `plan ${planId} for ${originRef} no longer exists` };
  if (plan.status !== 'awaiting_approval')
    return { ok: false, detail: `plan ${planId} is "${plan.status}", not awaiting approval — nothing changed` };

  const parts = store.listPlanParts(planId);
  const retire = partsToRetire(parts, []);
  for (const part of retire) store.updatePlanPart(part.id, { status: 'retired' });
  // Retiring a part and withdrawing its ask are one act: doing only the first
  // leaves the operator's bench holding a step no plan schedules.
  withdrawPartAsks(store, retire, REFUSED_PART_RESOLUTION);
  const surviving = survivorsOf(parts, retire);
  store.setPlanStatus(planId, 'planning', refusedPlanReason(plan.reason, note ?? null));

  const kept =
    surviving.length === 0 ? '' : `; ${surviving.length} part(s) already in flight keep running while it replans`;
  return {
    ok: true,
    detail: `sent the plan for ${originRef} back to a planner (retired ${retire.length} unstarted part(s))${kept}`,
  };
}

/**
 * Decline: the plan stops and **nothing takes its place** — the answer for an operator who
 * concludes the *issue* is not worth the work, where a refusal would re-derive a plan for a
 * goal nobody wants. `abandoned` rather than `complete`: both are terminal, but only one is
 * honest about a plan whose parts were never done.
 */
export function declinePlan(store: Store, planId: string, originRef: string, note?: string | null): PlanSettlement {
  const plan = store.getPlan(planId);
  if (!plan) return { ok: false, detail: `plan ${planId} for ${originRef} no longer exists` };
  if (plan.status !== 'awaiting_approval')
    return { ok: false, detail: `plan ${planId} is "${plan.status}", not awaiting approval — nothing changed` };

  const parts = store.listPlanParts(planId);
  const retire = partsToRetire(parts, []);
  for (const part of retire) store.updatePlanPart(part.id, { status: 'retired' });
  withdrawPartAsks(store, retire, REFUSED_PART_RESOLUTION);
  const surviving = survivorsOf(parts, retire);
  store.setPlanStatus(planId, 'abandoned', declinedPlanReason(plan.reason, note ?? null));

  const kept =
    surviving.length === 0 ? '' : `; ${surviving.length} part(s) already in flight keep running until you end the run`;
  return {
    ok: true,
    detail: `abandoned the plan for ${originRef} (retired ${retire.length} unstarted part(s))${kept}`,
  };
}

/**
 * Perform the arm an accepted shortfall names — the "No → re-plan" end of the loop. **Arm
 * A, `plan`** — one status write to `planning`; rule `issue-plan` already routes it to a
 * replan. The assessor's summary is appended to `Plan.reason`, never replacing it, since
 * the planner's reasoning is what is being amended. **Arm B, `part` — append, never
 * resurrect.** Returning the named part to `ready` would put an agent on a spent branch
 * whose PR is closed, so a new part is appended and the named one left untouched. The slug
 * is resolved against the plan's parts (`followupSlot`) so a follow-up that has since
 * merged is not written over — that would schedule nothing and rewrite delivered work.
 */
export function actOnShortfall(
  store: Store,
  act: { planId: string; originRef: string; cause: 'plan' | 'part'; partSlug: string | null; summary: string },
): PlanSettlement {
  const plan = store.getPlan(act.planId);
  if (!plan) return { ok: false, detail: `plan ${act.planId} for ${act.originRef} no longer exists` };
  // `planning`: a planner already has it. `awaiting_approval`: the decomposition
  // the assessment judged has been replaced by one no human released.
  if (plan.status === 'planning' || plan.status === 'awaiting_approval')
    return { ok: false, detail: `plan ${act.planId} is "${plan.status}" — it has already moved on` };

  if (act.cause === 'plan') {
    store.setPlanStatus(act.planId, 'planning', appendShortfallReason(plan.reason, act.summary));
    return { ok: true, detail: `sent the plan for ${act.originRef} back to a planner with what fell short` };
  }

  const parts = store.listPlanParts(act.planId);
  const target = liveParts(parts).find((p) => p.slug === act.partSlug);
  if (!target)
    return { ok: false, detail: `"${act.partSlug}" is no longer a live part of the plan for ${act.originRef}` };
  // Seq beyond every existing part, live or retired: a follow-up is the last
  // thing the plan does.
  const seq = Math.max(0, ...parts.map((p) => p.seq)) + 1;
  // See `followupSlot`: a `-followup` that has already merged would absorb the
  // write, scheduling nothing and rewriting what that merged part was for.
  const slot = followupSlot(target, parts);
  const [written] = store.upsertPlanParts(act.planId, [followupPartInput(target, act.summary, seq, slot.slug)]);
  if (!written) return { ok: false, detail: `could not append a follow-up part to the plan for ${act.originRef}` };
  // The plan may have rolled up to `complete`; an unsettled part makes that false
  // again, and the roll-up is the one place that reading lives.
  store.rollUpPlanStatus(act.planId);
  // Copied verbatim into the decision log, so it must say which of the two happened.
  const what = slot.refreshing
    ? `refreshed the declaration of the unstarted follow-up part "${written.slug}"`
    : `appended part "${written.slug}"`;
  return {
    ok: true,
    detail: `${what} on the plan for ${act.originRef}; "${target.slug}" is untouched`,
  };
}

/**
 * The planner's own reason, with what the assessment found appended — a planner shown only
 * the complaint has lost the decomposition it must correct.
 */
function appendShortfallReason(reason: string | null, summary: string): string {
  return appendPlanReason(reason, `An assessment of the delivered work found: ${summary}`);
}

/**
 * The reason a refused plan carries back to the planner: what it decided, plus that a human
 * declined it and why. Deliberately says nothing about how the work should be cut up — the
 * operator declined this plan, and the note is where they say why.
 */
function refusedPlanReason(reason: string | null, note: string | null): string {
  return appendPlanReason(
    reason,
    `An operator declined this plan${note ? `: ${note}` : '.'} Reconsider it in the light of that.`,
  );
}

/**
 * The reason an abandoned plan keeps: what it decided, plus that a human stopped it here
 * and why — the record in front of whoever reopens the goal.
 */
function declinedPlanReason(reason: string | null, note: string | null): string {
  return appendPlanReason(
    reason,
    `An operator backed out of this plan${note ? `: ${note}` : '.'} Nothing was scheduled for it.`,
  );
}

/**
 * One plan reason with another appended, bounded so repeated verdicts cannot grow the row
 * without limit.
 */
function appendPlanReason(reason: string | null, note: string): string {
  const joined = reason ? `${reason}\n\n${note}` : note;
  return joined.length > MAX_PLAN_REASON ? `${joined.slice(0, MAX_PLAN_REASON - 1)}…` : joined;
}

/** Long enough for a planner's reasoning plus a couple of assessments against it. */
const MAX_PLAN_REASON = 4000;

/** The live parts a refusal left standing — everything it did not just retire. */
function survivorsOf(parts: PlanPart[], retired: PlanPart[]): PlanPart[] {
  const gone = new Set(retired.map((p) => p.id));
  return liveParts(parts).filter((p) => !gone.has(p.id));
}
