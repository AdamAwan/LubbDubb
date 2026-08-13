import type { Store } from '../store/store.js';
import type { Plan, PlanPart } from '../types.js';
import { amendedPlanStatus, liveParts, partsToRetire, planShape } from './parts.js';
import { issueBranch } from '../dispatcher/issuePickup.js';
import { abandonBlockers } from './planWedge.js';
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
      // Every prerequisite: the operator is weighing the shape, and a rejoin whose
      // second dependency went unmentioned would read as a plain chain.
      const stacks = p.dependsOn.length === 0 ? '' : `, stacks on ${p.dependsOn.map((d) => `"${d}"`).join(' + ')}`;
      return `- "${p.slug}": ${p.title}${stacks} — ${p.scope}`;
    })
    .join('\n');
}

/**
 * The **single** verdict as the operator is asked to authorize it — what fills the
 * ask's `{list}` where a decomposition lists its parts.
 *
 * A single-PR proposal has no parts, and `describeProposedParts`' "declares no
 * parts" is true but reads as a plan that failed to say anything. The shape being
 * weighed is still a shape: one agent, one branch, one pull request — and the
 * branch is worth naming, because a branch that already exists is exactly the
 * collision the plan panel's other warnings are about.
 */
export function describeSingleRoute(issueNumber: number): string {
  return (
    `- no split: one agent works the whole issue on branch ${issueBranch(issueNumber)} and opens a single ` +
    `pull request.`
  );
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
 * placeholders, so an `{arm}` token would be silently dropped by exactly the
 * deployments that customised most — and the two arms settle differently enough
 * that a reader given the wrong one would answer the wrong question. Appending has
 * no fallback to get wrong.
 *
 * The template itself stays arm-neutral, so an override written before the single
 * arm existed still frames the question correctly and this paragraph completes it.
 */
export function planApprovalNote(issueNumber: number, single: boolean): string {
  if (single)
    return (
      `\n\nApprove and the issue is worked whole: one agent on ${issueBranch(issueNumber)}, one pull request, ` +
      `through ordinary pickup. Reject and the plan goes back to a planner with your reason — a "no" here means ` +
      `"not as one pull request", which is a question only a planner can answer again, so nothing is scheduled ` +
      `either way until a verdict is approved.`
    );
  return (
    `\n\nApprove and each part gets its own agent, branch and pull request, bottom of the stack first. Reject and ` +
    `the issue is worked as a single pull request instead — parts nothing has been started for are retired.`
  );
}

/** The outcome of settling a plan, in the form both callers audit. */
interface PlanSettlement {
  ok: boolean;
  detail: string;
}

/**
 * Approve: the verdict becomes work. One status write and the rule that owns the
 * released arm starts on the next pulse — which is the entire effect, because
 * `awaiting_approval` was never anything but the released status with the gate
 * closed.
 *
 * `active` on **either** arm: which arm it is, is the parts, and rule
 * `issue-pickup` reads that shape rather than the status — so a released single
 * verdict is worked whole without the status having to say so.
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
    detail:
      planShape(parts) === 'single'
        ? `released the single-pull-request plan for ${originRef}; the issue is now picked up whole`
        : `released the ${parts.length}-part plan for ${originRef}; its parts are now schedulable`,
  };
}

/**
 * Refuse: nothing is scheduled from the decomposition — **and the issue is left a
 * route**, which is the half a plain "no" would get wrong.
 *
 * Rejection is durable by design (phase 1), and once the funnel is on a plan is
 * the only thing that schedules anything for an issue: rule `work-item-in-review` parks the work item
 * in the review state for the life of the plan, and `resolvePlanRoute` fails a
 * spent replan back to `parts` rather than open to `single`. A "no" that only
 * stopped the parts would therefore park the issue for good — the exact failure
 * the planner's fail-open exists to prevent.
 *
 * So a refusal *reassigns* the issue rather than stopping it, using the rules that
 * already exist for the same question.
 *
 * A refused **single** verdict is the arm with nowhere to fall — the single-PR
 * route is what a refused decomposition falls *back* to — so it goes back to a
 * planner (`planning`) with the operator's reason appended, which is the one thing
 * that can produce a different verdict. See the guard in the body.
 *
 * A refused decomposition:
 *
 * - Every part nothing has been started for is retired ({@link partsToRetire} with
 *   an empty declaration — a refused decomposition declares no parts), so the
 *   graph says what happened instead of leaving `ready` rows nothing schedules.
 * - The status is then whatever {@link amendedPlanStatus} makes of what survived:
 *   `single`, so rule `issue-pickup` works the issue as one PR (the pre-funnel path, and the
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
/**
 * Abandon a **released** decomposition and work the issue as one pull request.
 *
 * `refusePlan` is the same collapse and cannot serve here: it compare-and-sets
 * against `awaiting_approval`, correctly, because refusing is a verdict on a
 * question you have not yet answered. That left an approved plan with no way back
 * — and a plan approved onto an issue whose flat `issue/<n>` branch was already
 * taken is approved into a wall. Its parts block instantly, `resolvePlanRoute`
 * fails a spent replan back to `parts` rather than open to `single`, and the only
 * remaining exit was editing the database.
 *
 * A separate act rather than a loosened guard, because it is a different sentence.
 * Refusing says *I will not authorize this*; this says *I authorized it, it cannot
 * run, work the issue whole instead*. Collapsing them would have one control mean
 * two things depending on a status the operator cannot see.
 *
 * **The bar is `partHasWork`**, so nothing with an agent, a branch or a PR behind
 * it is ever retired — the rule `partsToRetire` already enforces for an amendment,
 * asked here through the pure {@link abandonBlockers} so the route's refusal and
 * the cockpit's control cannot disagree. That bar is also what makes the collapse
 * to `single` safe: a part that never pushed has no branch to strand, so the flat
 * `issue/<n>` branch git refused to create beside them is exactly the one rule `issue-pickup`
 * now wants — and on the wedged path it already exists, carrying the work that
 * caused the collision.
 */
export function abandonDecomposition(store: Store, planId: string, originRef: string): PlanSettlement {
  const plan = store.getPlan(planId);
  if (!plan) return { ok: false, detail: `plan ${planId} for ${originRef} no longer exists` };
  if (plan.status !== 'active')
    return { ok: false, detail: `plan ${planId} is "${plan.status}", not active — nothing changed` };

  const parts = store.listPlanParts(planId);
  // The status no longer carries the shape, so `active` alone no longer means
  // "decomposed": an issue already being worked whole reaches here and would
  // otherwise be answered `ok` for retiring nothing at all.
  if (planShape(parts) === 'single')
    return {
      ok: false,
      detail: `plan ${planId} has no live parts — ${originRef} is already worked as one pull request`,
    };

  const blockers = abandonBlockers(parts);
  if (blockers.length > 0)
    return {
      ok: false,
      detail:
        `work has already started on this decomposition (${blockers.join(', ')}), so it cannot be collapsed onto ` +
        `the flat branch — replan instead, or let those parts finish`,
    };

  // Retiring the parts *is* the collapse — the shape is the live part list, so
  // there is no second status write that could disagree with it.
  const retire = liveParts(parts);
  for (const part of retire) store.updatePlanPart(part.id, { status: 'retired' });
  return {
    ok: true,
    detail: `retired ${retire.length} unstarted part(s); ${originRef} falls back to a single pull request`,
  };
}

export function refusePlan(store: Store, planId: string, originRef: string, note?: string | null): PlanSettlement {
  const plan = store.getPlan(planId);
  if (!plan) return { ok: false, detail: `plan ${planId} for ${originRef} no longer exists` };
  if (plan.status !== 'awaiting_approval')
    return { ok: false, detail: `plan ${planId} is "${plan.status}", not awaiting approval — nothing changed` };

  const parts = store.listPlanParts(planId);
  // Refusing a **single** verdict has nowhere to fall: the single-PR route *is*
  // what a refused decomposition falls back to, so writing `single` here would
  // perform the very thing the operator declined. "Not as one pull request" is a
  // question only a planner can answer again, and `planning` is exactly the status
  // rule `issue-plan` dispatches a replan from — the same one status write
  // `POST /api/plans/:id/replan` makes, so the refusal reuses a path rather than
  // inventing one. It cannot loop: the planner's attempt cap is what ends it, and
  // a spent cap fails the issue open to `single` and gets it worked, which is the
  // funnel's existing answer to a planner that cannot settle.
  if (liveParts(parts).length === 0) {
    store.setPlanStatus(planId, 'planning', refusedSingleReason(plan.reason, note ?? null));
    return { ok: true, detail: `sent the single-pull-request verdict for ${originRef} back to a planner` };
  }

  const retire = partsToRetire(parts, []);
  for (const part of retire) store.updatePlanPart(part.id, { status: 'retired' });
  const surviving = survivorsOf(parts, retire);
  store.setPlanStatus(planId, amendedPlanStatus('single', surviving));

  return {
    ok: true,
    detail:
      planShape(surviving) === 'single'
        ? `retired ${retire.length} unstarted part(s); ${originRef} falls back to a single pull request`
        : `retired ${retire.length} unstarted part(s); ${surviving.length} part(s) already in flight keep running`,
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
 * The reason a refused **single** verdict carries back to the planner: what it
 * decided, plus that a human declined it and why.
 *
 * The operator's note is the whole content of the refusal — without it the replan
 * is a re-run of the question that just produced the answer being refused, and the
 * planner has no reason to decide differently. Appended for
 * {@link appendShortfallReason}'s reason: the planner's own reasoning is what is
 * being corrected.
 */
function refusedSingleReason(reason: string | null, note: string | null): string {
  return appendPlanReason(
    reason,
    `An operator declined working this issue as a single pull request${note ? `: ${note}` : '.'} Reconsider ` +
      `whether it should be split into parts.`,
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
