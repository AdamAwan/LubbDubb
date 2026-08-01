/**
 * The pure half of a negative assessment (issue #159): what an assessor may say
 * fell short, and what each answer *does*.
 *
 * ## The gap this closes
 *
 * The intended loop is Plan → Work → is the goal achieved? → No → re-plan. Both
 * ends existed and nothing joined them. The assessor could say `more_work`, but it
 * wrote that into `issue_conclusions` — the working agent's own row — where the
 * only consumer is rule `work-item-back-to-pickup`, which emits a *tracker* move and so
 * fires only where `issueInReviewState` is configured. On GitHub it changed no
 * dispatch at all; and on either provider, for an issue with a plan, rule `issue-pickup` is
 * gated on the `single` route and rule `plan-part` finds every part settled. The assessor
 * said "not delivered" and the harness scheduled nothing, anywhere.
 *
 * ## Why the cause is declared rather than derived
 *
 * Three distinct failures wear one face, and a design that routes all three to a
 * replan re-decomposes plans whose shape was never the problem. Deriving "the plan
 * was wrong" from the fact that something is missing would be the harness
 * inferring a route from incidental output — the thing refused at every other
 * point where a positive terminal could have been guessed at (`undeclared` vs
 * `more_work`, the DONE sentinel vs the `result` event, `conclude_part`'s `kind`).
 * So the assessor names the cause and {@link shortfallArm} routes it, and nothing
 * else in the harness has an opinion about which failure this was.
 *
 * ## Why arm C is not a proposal
 *
 * Arms A and B spend a fleet — a replan puts an agent on the planner, a follow-up
 * part puts one on the work — so both are put to a human before they happen, which
 * is what bounds the loop from the outside. Arm C schedules nothing: it says the
 * *goal* is wrong, which is #158's question and not the planner's. A proposal
 * whose accept and reject both do nothing is not a decision, so arm C is an
 * ordinary escalation, deduped the way rule `pr-ci-blocked`'s is.
 */

import type { PlanPart, PlanPartInput, ShortfallCause } from '../types.js';

/** What an assessor may say fell short, in the order the tool advertises them. */
export const SHORTFALL_CAUSES = ['plan', 'part', 'goal'] as const;

/** What each cause means to the agent choosing it, and what the harness will do about it. */
export const SHORTFALL_CAUSE_HELP: Record<ShortfallCause, string> = {
  plan:
    'the decomposition was wrong — a part is missing, or the split itself was. The whole plan goes back ' +
    'to a planner, which sees the current plan and your summary and amends it. Choose this only when the ' +
    'shape is the problem: if one named part simply did not finish its own scope, say part',
  part:
    'the split was right and one named part did not deliver the scope it declared. A follow-up part is ' +
    'appended to the plan for that scope; nothing else about the plan changes and no other part is ' +
    'touched. Name it in `part`',
  goal:
    'the issue itself is the problem — it is wrong, ambiguous, or was already obsolete before anyone ' +
    'started. Nothing is dispatched: a human is asked, because no planner and no agent can fix a goal. ' +
    'Choose this even though it schedules nothing — it is the honest answer, and it is the only one that ' +
    'reaches a person',
};

/**
 * The subject of a shortfall: one issue's fallen-short verdict, as an act.
 *
 * `issue:<n>:shortfall` — the harness's existing ref vocabulary, suffixed so it
 * reads as *the act* and not the issue, exactly as `pr:42:merge` does. One
 * function for both the proposal ref (arms A and B) and arm C's escalation dedup
 * key, because they name the same act; two would be two spellings of one string,
 * which is the drift `MCP_TOOL_NAMES` exists to prevent in miniature.
 *
 * Two properties fall out of the shape and are worth knowing rather than
 * rediscovering:
 *
 * - `proposalWorldRef` maps it to `issue:<n>` with no change, because it splits on
 *   `:` and takes the first two segments — so phase 4's rejection expiry works on
 *   a shortfall unmodified, which it must: a refused replan that never expired
 *   would veto every future one, the phase-4 failure exactly.
 * - It is **nobody's dispatch origin**, so `rejectionGuidance` — which matches on
 *   an exact ref — deliberately reaches no agent with it. That is the same
 *   treatment a refused merge gets, and for the same reason: the harness's answer
 *   to "no, do not re-plan this" is not re-planning it, and no agent's job is to
 *   hear about it.
 */
export function shortfallRef(issueNumber: number): string {
  return `issue:${issueNumber}:shortfall`;
}

/**
 * What a shortfall's cause routes to. Three arms, decided in one place so the
 * rule, the executor and the cockpit chip cannot disagree about what accepting
 * would do.
 *
 * - `replan` — arm A. Flips the plan to `planning`, which is the *entire* effect:
 *   rule `issue-plan` already routes a `planning` plan back to a planner with the
 *   `issue-replan` prompt and `currentPlanSummary`, and `plannerVerdict` already
 *   narrows the cooldown to decisions since `plan.updatedAt` so the original
 *   planner does not throttle it. `releasePlan`'s pattern — one status write, and
 *   a rule that was already there starts working.
 * - `followup` — arm B. Appends one part; the named part is left exactly as it is.
 * - `escalate` — arm C. Asks a human and schedules nothing.
 * - `none` — no cause was named, so nothing is routed. The verdict still stands
 *   and `resolveIssueConclusion` still reads it as `more_work`; what it does *not*
 *   do is manufacture a route out of silence, which is `undeclared`'s discipline.
 *
 * A shortfall on an issue with **no plan** never replans or follows up whatever
 * its cause says. Those two are refused at the tool boundary, so reaching them
 * means a plan was removed between the verdict and the pulse — there is nothing to
 * replan and no part to follow up, so it degrades to the arm that asks a person.
 */
export function shortfallArm(
  cause: ShortfallCause | null,
  hasPlan: boolean,
): 'replan' | 'followup' | 'escalate' | 'none' {
  if (cause === null) return 'none';
  if (cause === 'goal') return 'escalate';
  if (!hasPlan) return 'escalate';
  return cause === 'plan' ? 'replan' : 'followup';
}

/**
 * The slug a follow-up part takes.
 *
 * Derived from the part that fell short rather than freshly named, so the graph
 * reads as what it is — this scope, again — and so a second shortfall against the
 * same part collides on the primary key (`<plan id>:<slug>`) and refreshes the
 * declaration instead of stacking a `-followup-followup`.
 */
function followupSlug(slug: string): string {
  return slug.endsWith('-followup') ? slug : `${slug}-followup`;
}

/**
 * Arm B's new part, as the planner would have declared it.
 *
 * **Appended, never a resurrection of the part that fell short**, and
 * `partHasWork` is the existing statement of why: a merged part's PR is on the
 * default branch and its branch is spent, so returning it to `ready` would put an
 * agent on a branch whose PR is closed — and the issue's own acceptance criterion
 * forbids touching a part that has work started. Appending meets that criterion by
 * construction rather than by a check, which is the stronger form.
 *
 * `dependsOn` is empty on purpose. The part it follows up has already finished, so
 * there is no open branch to stack on; making it depend on a merged sibling would
 * have `partBase` resolve to the default branch anyway, by a longer route.
 */
export function followupPartInput(part: PlanPart, summary: string, seq: number): PlanPartInput {
  return {
    slug: followupSlug(part.slug),
    seq,
    title: `Finish "${part.title}"`,
    // The assessor's own words are the scope: it read the delivered state and said
    // what is missing from it, which is exactly what this part is for.
    scope: summary,
    rationale: `An assessment of the delivered work found that "${part.slug}" did not deliver its scope.`,
    acceptance: null,
    dependsOn: [],
    expectedKind: 'code',
  };
}

/**
 * What the assessor is told happens next, per cause.
 *
 * Careful about tense: nothing has happened yet. The verdict is a row; the rule
 * proposes the arm on a later pulse and a human decides it. An assessor told
 * "re-planned" would believe it had scheduled something, which is the failure
 * `conclusionOrigin` refuses rather than silently scopes.
 */
export function shortfallRecordedNote(cause: ShortfallCause | null): string {
  const tail =
    ' Nothing is dispatched by this call: the harness puts it to a human on a later cycle, and only their ' +
    'accept spends an agent.';
  if (cause === 'plan')
    return `Recorded. The harness will offer to send the plan back to a planner, with your summary.${tail}`;
  if (cause === 'part')
    return (
      `Recorded. The harness will offer to append a follow-up part for that scope; the part you named is ` +
      `left exactly as it is, because its branch is spent.${tail}`
    );
  if (cause === 'goal')
    return (
      'Recorded. A wrong or unclear goal is not something a planner or an agent can fix, so the harness asks ' +
      'a person and schedules nothing at all. Your summary is what they will read.'
    );
  return (
    'Recorded. The issue is no longer parked as delivered, so it comes back round for pickup with your ' +
    'summary against it. Nothing else is scheduled: you named nothing that fell short beyond the work ' +
    'itself, and the harness does not invent a route from that.'
  );
}
