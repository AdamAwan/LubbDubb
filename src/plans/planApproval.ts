import type { Store } from '../store/store.js';
import type { Plan, PlanPart } from '../types.js';
import { liveParts, partsToRetire } from './parts.js';
import { REFUSED_PART_RESOLUTION, withdrawPartAsks } from './partAsks.js';
import { followupPartInput, followupSlot } from '../delivery/shortfall.js';

// → docs/spec/08-planning.md

export function describeProposedParts(parts: PlanPart[]): string {
  const live = liveParts(parts);
  if (live.length === 0) return 'The plan declares no parts.';
  return live
    .map((p) => {
      const stacks = p.dependsOn.length === 0 ? '' : `, stacks on ${p.dependsOn.map((d) => `"${d}"`).join(' + ')}`;
      return `- "${p.slug}": ${p.title}${stacks} — ${p.scope}`;
    })
    .join('\n');
}

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

export function planApprovalNote(): string {
  return (
    `\n\nWhat each answer does — nothing is scheduled either way until a plan is approved:\n\n` +
    `- Approve — each part gets its own agent, branch and pull request, bottom of the stack first.\n` +
    `- Reject — the plan goes back to a planner with your reason.\n` +
    `- Close the ticket with a comment — if the ticket itself is the problem rather than the plan.\n` +
    `- Hold the ticket — stops watching it and sends this plan back; watch it again and a fresh plan is written for it.`
  );
}

interface PlanSettlement {
  ok: boolean;
  detail: string;
}

export function releasePlan(store: Store, planId: string, originRef: string): PlanSettlement {
  const plan = store.getPlan(planId);
  if (!plan) return { ok: false, detail: `plan ${planId} for ${originRef} no longer exists` };
  if (plan.status !== 'awaiting_approval')
    return { ok: false, detail: `plan ${planId} is "${plan.status}", not awaiting approval — nothing released` };
  const parts = liveParts(store.listPlanParts(planId));
  if (parts.length === 0)
    return { ok: false, detail: `plan ${planId} for ${originRef} has no live parts — nothing to release` };
  store.setPlanStatus(planId, 'active');
  return {
    ok: true,
    detail: `released the ${parts.length}-part plan for ${originRef}; its parts are now schedulable`,
  };
}

export function refusePlan(store: Store, planId: string, originRef: string, note?: string | null): PlanSettlement {
  const plan = store.getPlan(planId);
  if (!plan) return { ok: false, detail: `plan ${planId} for ${originRef} no longer exists` };
  if (plan.status !== 'awaiting_approval')
    return { ok: false, detail: `plan ${planId} is "${plan.status}", not awaiting approval — nothing changed` };

  const parts = store.listPlanParts(planId);
  const retire = partsToRetire(parts, []);
  for (const part of retire) store.updatePlanPart(part.id, { status: 'retired' });
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

export function actOnShortfall(
  store: Store,
  act: { planId: string; originRef: string; cause: 'plan' | 'part'; partSlug: string | null; summary: string },
): PlanSettlement {
  const plan = store.getPlan(act.planId);
  if (!plan) return { ok: false, detail: `plan ${act.planId} for ${act.originRef} no longer exists` };
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
  const seq = Math.max(0, ...parts.map((p) => p.seq)) + 1;
  const slot = followupSlot(target, parts);
  const [written] = store.upsertPlanParts(act.planId, [followupPartInput(target, act.summary, seq, slot.slug)]);
  if (!written) return { ok: false, detail: `could not append a follow-up part to the plan for ${act.originRef}` };
  store.rollUpPlanStatus(act.planId);
  const what = slot.refreshing
    ? `refreshed the declaration of the unstarted follow-up part "${written.slug}"`
    : `appended part "${written.slug}"`;
  return {
    ok: true,
    detail: `${what} on the plan for ${act.originRef}; "${target.slug}" is untouched`,
  };
}

function appendShortfallReason(reason: string | null, summary: string): string {
  return appendPlanReason(reason, `An assessment of the delivered work found: ${summary}`);
}

function refusedPlanReason(reason: string | null, note: string | null): string {
  return appendPlanReason(
    reason,
    `An operator declined this plan${note ? `: ${note}` : '.'} Reconsider it in the light of that.`,
  );
}

function declinedPlanReason(reason: string | null, note: string | null): string {
  return appendPlanReason(
    reason,
    `An operator backed out of this plan${note ? `: ${note}` : '.'} Nothing was scheduled for it.`,
  );
}

function appendPlanReason(reason: string | null, note: string): string {
  const joined = reason ? `${reason}\n\n${note}` : note;
  return joined.length > MAX_PLAN_REASON ? `${joined.slice(0, MAX_PLAN_REASON - 1)}…` : joined;
}

const MAX_PLAN_REASON = 4000;

function survivorsOf(parts: PlanPart[], retired: PlanPart[]): PlanPart[] {
  const gone = new Set(retired.map((p) => p.id));
  return liveParts(parts).filter((p) => !gone.has(p.id));
}
