import type { Store } from '../store/store.js';
import type { Plan, PlanPart } from '../types.js';
import { liveParts, partsToRetire } from './parts.js';
import { REFUSED_PART_RESOLUTION, withdrawPartAsks } from './partAsks.js';
import { followupPartInput } from '../delivery/shortfall.js';

/**
 * What a human's verdict *does* to the plan — three functions, one shape: read the
 * plan, refuse unless it is still the thing that was proposed, write, say what
 * happened.
 *
 * The first two are the approval gate (issue #109 phase 3) and compare-and-set
 * against `awaiting_approval` for the same reason `Store.decideProposal` is one
 * against `pending`: a verdict that arrives after the plan moved on — an operator
 * who hit Replan with the card still open — must not release or refuse a
 * decomposition nobody was shown. The third is a failed assessment's arm (issue
 * #159) and compare-and-sets against the states in which its arm still means
 * something. `better-sqlite3` writes are synchronous, so every read-then-write
 * here is race-free by construction.
 */

/**
 * The plan as the operator is asked to authorize it — every part, in dispatch
 * order, with what it stacks on. One part or eight: the list is the list, and a
 * plan with a single entry is not described in some other idiom.
 */
export function describeProposedParts(parts: PlanPart[]): string {
  const live = liveParts(parts);
  if (live.length === 0) return 'The plan declares no parts.';
  return live
    .map((p) => {
      // Every prerequisite: the operator is weighing the shape, and a rejoin whose
      // second dependency went unmentioned would read as a plain chain.
      const stacks = p.dependsOn.length === 0 ? '' : `, stacks on ${p.dependsOn.map((d) => `"${d}"`).join(' + ')}`;
      return `- "${p.slug}": ${p.title}${stacks} — ${p.scope}`;
    })
    .join('\n');
}

/**
 * What the operator actually reads on the card: what the planner found, and what
 * it is going to do about it.
 *
 * The ask used to carry {@link describeProposedParts} as its body — the split, in
 * dispatch order, with every prerequisite — and that is the wrong half of the
 * plan to put in front of someone. A decomposition is *how* the work is cut up;
 * the question being answered here is whether the work is right at all, and the
 * split is one click away in the plan panel, drawn, where it reads far better
 * than a flat list ever did. So the card leads with `diagnosis` and `approach`
 * and the shape stays behind **Read the full plan**.
 *
 * Quoted rather than templated, for `propose_shortfall`'s reason: this is the
 * planner's prose, up to a couple of thousand characters of it, and the cockpit
 * labels a block whose edges it can see.
 *
 * Falls back to `reason` — a plan written before those fields existed, or a
 * planner that filled in neither, would otherwise leave the card with a headline
 * and nothing else. Null when it said nothing at all, which the caller carries
 * as an absent block rather than an empty one.
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
 * What approving and rejecting *this* verdict do — appended to the rendered ask,
 * never interpolated into it.
 *
 * Appending is `planApprovalWarnings`' rule and for its reason: `plan-approval` is
 * operator-overridable and `loadPromptTemplates` rejects only *unknown*
 * placeholders, so a `{settlement}` token would be silently dropped by exactly the
 * deployments that customised most. Appending has no fallback to get wrong.
 *
 * **One paragraph, whatever the plan's size.** This used to be two, because a
 * one-pull-request plan settled somewhere else entirely — approving it handed the
 * issue to ordinary pickup, and refusing it had nowhere to fall back to. Both arms
 * now settle identically, so a reader can no longer be handed the paragraph for
 * the other one.
 */
export function planApprovalNote(): string {
  return (
    `\n\nApprove and each part gets its own agent, branch and pull request, bottom of the stack first. Reject and ` +
    `the plan goes back to a planner with your reason — nothing is scheduled either way until a plan is approved.`
  );
}

/** The outcome of settling a plan, in the form both callers audit. */
interface PlanSettlement {
  ok: boolean;
  detail: string;
}

/**
 * Approve: the plan becomes work. One status write and rule `plan-part` starts on
 * the next pulse — which is the entire effect, because `awaiting_approval` was
 * never anything but the released status with the gate closed.
 *
 * One rule owns every released plan, so there is nothing here to decide: a
 * one-part plan is released by the same write and scheduled by the same stage as
 * any other.
 */
export function releasePlan(store: Store, planId: string, originRef: string): PlanSettlement {
  const plan = store.getPlan(planId);
  if (!plan) return { ok: false, detail: `plan ${planId} for ${originRef} no longer exists` };
  if (plan.status !== 'awaiting_approval')
    return { ok: false, detail: `plan ${planId} is "${plan.status}", not awaiting approval — nothing released` };
  const parts = liveParts(store.listPlanParts(planId));
  store.setPlanStatus(planId, 'active');
  return {
    ok: true,
    detail: `released the ${parts.length}-part plan for ${originRef}; its parts are now schedulable`,
  };
}

/**
 * Refuse: nothing is scheduled from the plan — **and the issue is left a route**,
 * which is the half a plain "no" would get wrong.
 *
 * Rejection is durable by design (phase 1), and once the funnel is on a plan is
 * the only thing that schedules anything for an issue: rule `work-item-in-review`
 * parks the work item in the review state for the life of the plan, and
 * `resolvePlanRoute` fails a spent replan back to `parts` rather than open to
 * unplanned pickup. A "no" that only stopped the parts would therefore park the
 * issue for good — the exact failure the planner's fail-open exists to prevent.
 *
 * So a refusal *reassigns* the plan rather than stopping it, and it does so the
 * same way whatever the plan's size: **back to a planner** (`planning`) with the
 * operator's reason appended, which is the one thing that can produce a different
 * plan. `planning` is exactly the status rule `issue-plan` dispatches a replan
 * from, and the same one status write `POST /api/plans/:id/replan` makes, so the
 * refusal reuses a path rather than inventing one. It cannot loop: the planner's
 * attempt cap ends it, and a spent cap falls the issue open and gets it worked.
 *
 * Refusing used to fork on the part count, and the fork is what this replaces: a
 * plan with parts collapsed to the no-parts "single" shape and was picked up
 * whole, while a plan that was *already* that shape had nowhere to fall and went
 * back to a planner. So "reject" meant two unrelated things depending on a number
 * the button did not mention. Only one of them was ever the operator's intent —
 * this plan is wrong, write a better one — and it is the one that survives.
 *
 * **The one thing still keyed on the parts is work that has actually left the
 * harness**, which is not a question about shape: parts nothing has been started
 * for are retired, so the graph says what happened instead of leaving `ready` rows
 * nothing schedules, and parts with a branch or a PR are left exactly as they are
 * because they are not the refusal's to withdraw. A refusal that finds work in
 * flight is a *replan* being refused, and the work already running carries on.
 */
export function refusePlan(store: Store, planId: string, originRef: string, note?: string | null): PlanSettlement {
  const plan = store.getPlan(planId);
  if (!plan) return { ok: false, detail: `plan ${planId} for ${originRef} no longer exists` };
  if (plan.status !== 'awaiting_approval')
    return { ok: false, detail: `plan ${planId} is "${plan.status}", not awaiting approval — nothing changed` };

  const parts = store.listPlanParts(planId);
  const retire = partsToRetire(parts, []);
  for (const part of retire) store.updatePlanPart(part.id, { status: 'retired' });
  // Retiring the part and withdrawing its ask are one act, wherever a part is
  // retired — a refusal that did only the first left the operator's bench holding
  // a step no plan schedules.
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
 * Perform the arm an accepted shortfall names (issue #159) — the "No → re-plan"
 * end of the loop, finally wired to the check at the other end.
 *
 * **Arm A, `plan` — send the decomposition back.** One status write, and the
 * entire effect: rule `issue-plan` already routes a `planning` plan to a planner with the
 * `issue-replan` prompt and `currentPlanSummary`, and `plannerVerdict` already
 * narrows the cooldown to decisions since `plan.updatedAt` so the original
 * planner's attempt does not throttle the replan. This is {@link releasePlan}'s
 * pattern — write one status, and a rule that was already there starts working.
 * The assessor's summary rides to the planner through `Plan.reason`, appended
 * rather than replacing it: the planner's own reasoning is what the replan is
 * amending, so overwriting it would take away the thing being corrected.
 *
 * **Arm B, `part` — append, never resurrect.** The tempting version returns the
 * named part to `ready`, and `partHasWork` is the existing statement of why it is
 * wrong: a merged part's PR is on the default branch and its branch is spent, so
 * re-dispatching puts an agent on a branch whose PR is closed. So one new part is
 * appended for the scope that fell short and the named part is left exactly as it
 * is — which meets "cannot retire parts that have work started" by construction
 * rather than by a check. Rule `plan-part` schedules it with no new dispatch path, and the
 * plan moves `complete` → `active` through the roll-up it already computes.
 *
 * Routing arm B to a replan instead was considered and refused: that is precisely
 * the issue's stated failure mode — re-decomposing a plan whose shape was fine —
 * and it would give the surviving parts new slugs unless the planner happened to
 * preserve them.
 */
export function actOnShortfall(
  store: Store,
  act: { planId: string; originRef: string; cause: 'plan' | 'part'; partSlug: string | null; summary: string },
): PlanSettlement {
  const plan = store.getPlan(act.planId);
  if (!plan) return { ok: false, detail: `plan ${act.planId} for ${act.originRef} no longer exists` };
  // `planning` means a planner already has it — accepting again would be a second
  // replan of a plan nobody has re-derived yet. `awaiting_approval` means the
  // decomposition the assessment judged has since been replaced by one no human
  // has released, so acting on the old verdict would settle a plan nobody saw.
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
  // Seq beyond every existing part, live or retired: rule `plan-part` orders by depth then
  // seq, and a follow-up is the last thing the plan does.
  const seq = Math.max(0, ...parts.map((p) => p.seq)) + 1;
  const [appended] = store.upsertPlanParts(act.planId, [followupPartInput(target, act.summary, seq)]);
  // The plan may have rolled up to `complete` when the part that fell short
  // merged. An unsettled part makes that false again, and the roll-up is the one
  // place that reading lives — deriving it here would be a second opinion.
  store.rollUpPlanStatus(act.planId);
  return {
    ok: true,
    detail: `appended part "${appended?.slug ?? act.partSlug}" to the plan for ${act.originRef}; "${target.slug}" is untouched`,
  };
}

/**
 * The planner's own reason, with what the assessment found appended.
 *
 * Appended rather than replaced because the replan is *amending* the planner's
 * reasoning, and a planner shown only the complaint has lost the decomposition it
 * is being asked to correct. Bounded so a long assessment cannot grow the row
 * without limit across repeated shortfalls.
 */
function appendShortfallReason(reason: string | null, summary: string): string {
  return appendPlanReason(reason, `An assessment of the delivered work found: ${summary}`);
}

/**
 * The reason a refused plan carries back to the planner: what it decided, plus
 * that a human declined it and why.
 *
 * The operator's note is the whole content of the refusal — without it the replan
 * is a re-run of the question that just produced the answer being refused, and the
 * planner has no reason to decide differently. Appended for
 * {@link appendShortfallReason}'s reason: the planner's own reasoning is what is
 * being corrected.
 *
 * It says nothing about how the work should be cut up. A refusal that told the
 * planner to "reconsider whether it should be split" would answer a question the
 * operator was not asked and may well not have meant — what they declined is this
 * plan, and the note is where they say why.
 */
function refusedPlanReason(reason: string | null, note: string | null): string {
  return appendPlanReason(
    reason,
    `An operator declined this plan${note ? `: ${note}` : '.'} Reconsider it in the light of that.`,
  );
}

/** One plan reason with another appended, bounded so repeated verdicts cannot grow the row without limit. */
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
