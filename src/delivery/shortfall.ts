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

import { z } from 'zod';
import { optionalText } from '../server/validation.js';
import type { PlanPart, PlanPartInput, ShortfallCause } from '../types.js';
import { partHasWork } from '../plans/parts.js';

/** What an assessor may say fell short, in the order the tool advertises them. */
export const SHORTFALL_CAUSES = ['plan', 'part', 'goal'] as const;

/**
 * The operator's arm of the verdict, as a request body — here beside
 * {@link SHORTFALL_CAUSES} and {@link shortfallArm} rather than in the route
 * that reads it, because what it encodes is the rule and not the routing.
 *
 * `cause` distinguishes three states and the schema has to keep all three apart:
 * **absent** records a shortfall naming no cause (an unplanned issue that simply
 * is not finished), an explicit **null** *clears* one, and a named cause records
 * it. Absent and null are the same value in JSON and opposite acts here, which is
 * why `.optional()` wraps the union rather than `null` standing in for "not
 * given".
 *
 * The one cross-field rule on the whole HTTP surface is the `.refine` below: a
 * `part` cause names which part. It is the same fact {@link shortfallArm} routes
 * on — arm B has no part to follow up without it — so the two are stated within
 * a screen of each other rather than 800 lines into a route file.
 */
export const ShortfallBody = z
  .object({
    cause: z
      .union([z.enum(SHORTFALL_CAUSES), z.null()], {
        errorMap: () => ({ message: `cause must be null or one of ${SHORTFALL_CAUSES.join(', ')}` }),
      })
      .optional(),
    part: optionalText('part'),
    summary: optionalText('summary'),
  })
  .refine((body) => body.cause !== 'part' || body.part !== undefined, {
    message: 'cause "part" needs the part slug in `part`',
  });

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
 * The assessor's verdict as one block of quoted markdown, for the `detail` slot
 * on the card that puts it to a human.
 *
 * **Quoted, not spliced.** An assessment is up to two thousand characters of
 * someone else's prose; interpolating it into a sentence the dispatcher wrote is
 * what turned the stamp desk's card into one unreadable paragraph, and it leaves
 * the cockpit unable to label the block because it cannot see where it starts.
 *
 * The headline leads in bold and the account follows, so the two read as one
 * passage rather than as a repeated sentence. A pre-split row — every assessment
 * recorded before `detail` existed — has its whole blob in `summary` and yields
 * just that: a tall block rather than a lie about its own structure.
 */
export function quotedAssessment(summary: string, detail: string | null): string {
  return detail ? `**${summary}**\n\n${detail}` : summary;
}

/**
 * Arm C's question, as one line.
 *
 * A lede and nothing else: what the assessment said, and that nothing is coming.
 * Everything the assessor wrote rides in `detail` beside it — see
 * {@link quotedAssessment} — so this stays a sentence an operator reads before
 * deciding whether to read further, which is the whole job of the first line on a
 * card. Pure, and tested for exactly that: a prompt builder that grew a paragraph
 * would put the wall back with nothing to catch it.
 */
export function shortfallEscalationPrompt(issueNumber: number, title: string, cause: ShortfallCause | null): string {
  const wrongGoal = cause === 'goal';
  return (
    `An assessment of issue #${issueNumber} ("${title}") found the work done and the goal still not reached` +
    `${wrongGoal ? ', and the issue itself to be what is wrong' : ''} — ` +
    `${
      wrongGoal
        ? 'no planner and no agent can fix a goal'
        : 'and there is no delivery plan here to re-plan or add a part to'
    }, so nothing has been dispatched and nothing will be.`
  );
}

/** Where arm B's part is going to land, and whether that is an append or a refresh. */
interface FollowupSlot {
  slug: string;
  /** An unstarted follow-up already declared for this scope is re-declared in place. */
  refreshing: boolean;
}

/**
 * The slug a follow-up part takes, resolved against the plan's existing parts.
 *
 * Derived from the part that fell short rather than freshly named, so the graph
 * reads as what it is — this scope, again — and so a second shortfall against a
 * follow-up **nobody has started** collides on the primary key
 * (`<plan id>:<slug>`) and refreshes the declaration instead of stacking a
 * `-followup-followup`. That collision is the design while the follow-up is still
 * a declaration.
 *
 * It stops being the design the moment the follow-up has work. `upsertPlanParts`
 * preserves progress on conflict, so a merged `-followup` absorbs the write:
 * nothing is scheduled, the plan stays `complete`, and the row recording what a
 * merged pull request was for is rewritten to describe work nobody did. The same
 * ordering arrives the short way when the shortfall names a `-followup` part
 * itself — there the target *is* the collision. So a taken slot takes the next
 * free number instead, which is the honest form of "this scope, again, a second
 * time", and leaves `partDepth`/`partBase` unchanged since `dependsOn` is empty
 * either way.
 *
 * A pure `slug -> slug` function cannot answer this: it is a question about what
 * the plan already holds.
 */
export function followupSlot(part: PlanPart, parts: readonly PlanPart[]): FollowupSlot {
  const base = part.slug.endsWith('-followup') ? part.slug : `${part.slug}-followup`;
  const bySlug = new Map(parts.map((p) => [p.slug, p]));
  // A retired row counts as taken too: re-declaring one lifts the retirement,
  // which would overwrite a declaration an operator's replan had already dropped.
  const free = (slug: string): boolean => !bySlug.has(slug);
  const unstarted = (slug: string): boolean => {
    const existing = bySlug.get(slug);
    return (
      existing !== undefined &&
      existing.status !== 'retired' &&
      !partHasWork(existing) &&
      existing.branch === null &&
      existing.prNumber === null
    );
  };
  if (free(base)) return { slug: base, refreshing: false };
  if (unstarted(base)) return { slug: base, refreshing: true };
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (free(candidate)) return { slug: candidate, refreshing: false };
    if (unstarted(candidate)) return { slug: candidate, refreshing: true };
  }
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
 * The slug comes from {@link followupSlot}, which is where "appended" stops being
 * true by construction: a follow-up that has already merged is a collision, not a
 * blank row, and the append has to go to the next free slot to stay an append.
 *
 * `dependsOn` is empty on purpose. The part it follows up has already finished, so
 * there is no open branch to stack on; making it depend on a merged sibling would
 * have `partBase` resolve to the default branch anyway, by a longer route.
 */
export function followupPartInput(part: PlanPart, summary: string, seq: number, slug: string): PlanPartInput {
  return {
    slug,
    // The part it follows up was priced by the planner that declared it, and this
    // is the same work finishing — so it inherits that price rather than falling
    // back to the goal's, which would quietly downgrade the one part somebody had
    // already decided needed more.
    profile: part.profile,
    seq,
    title: `Finish "${part.title}"`,
    // The assessor's own words are the scope: it read the delivered state and said
    // what is missing from it, which is exactly what this part is for.
    scope: summary,
    // No declared paths, and none inherited from the part this follows up: what an
    // assessment found missing is prose about behaviour, and carrying the finished
    // part's `touches` over would claim a scope nobody declared for this work —
    // which `partScopeDrift` would then read as a promise about where it may write.
    touches: [],
    rationale: `An assessment of the delivered work found that "${part.slug}" did not deliver its scope.`,
    acceptance: null,
    size: null,
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
