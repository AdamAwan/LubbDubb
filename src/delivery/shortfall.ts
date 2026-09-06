/**
 * The pure half of a negative assessment: what an assessor may say fell short, and what
 * each answer does. The assessor names the cause and {@link shortfallArm} routes it —
 * nothing else infers which failure this was. Arms A and B spend a fleet and are put to
 * a human as proposals; arm C schedules nothing and is an ordinary deduped escalation.
 */

import { z } from 'zod';
import { optionalText } from '../server/validation.js';
import type { PlanPart, PlanPartInput, ShortfallCause } from '../types.js';
import { partHasWork } from '../plans/parts.js';

/** What an assessor may say fell short, in the order the tool advertises them. */
export const SHORTFALL_CAUSES = ['plan', 'part', 'goal'] as const;

/**
 * The operator's arm of the verdict, as a request body. `cause` is three-valued:
 * absent records a shortfall naming no cause, explicit null clears one, a named cause
 * records it — hence `.optional()` over the union rather than null standing in for
 * "not given". The `.refine` enforces that a `part` cause must name its part.
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
 * The subject of a shortfall: one issue's fallen-short verdict, as an act. One function
 * for both the proposal ref (arms A and B) and arm C's escalation dedup key. Maps back
 * to `issue:<n>` unchanged so rejection expiry works — a refused replan that never
 * expired would veto every future one. It is nobody's dispatch origin.
 */
export function shortfallRef(issueNumber: number): string {
  return `issue:${issueNumber}:shortfall`;
}

/**
 * What a shortfall's cause routes to, decided in one place so the rule, executor and
 * cockpit chip agree. `replan` (arm A) flips the plan to `planning`; `followup` (arm B)
 * appends one part; `escalate` (arm C) asks a human and schedules nothing; `none` means
 * no cause was named, so no route is manufactured (the verdict still reads `more_work`).
 * A shortfall on an issue with no plan always degrades to `escalate`.
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

/** The assessor's verdict as one block of quoted markdown, for the `detail` slot on the card that puts it to a human. Never spliced into a sentence the dispatcher wrote. */
export function quotedAssessment(summary: string, detail: string | null): string {
  return detail ? `**${summary}**\n\n${detail}` : summary;
}

/** Arm C's question, as one line: what the assessment said, and that nothing is coming. Everything else rides in `detail` ({@link quotedAssessment}), so this must stay one sentence. */
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
 * The slug a follow-up part takes, resolved against the plan's existing parts. Derived
 * from the part that fell short, so a second shortfall against an unstarted follow-up
 * collides and refreshes the declaration. A follow-up with work must never be reused —
 * `upsertPlanParts` preserves progress on conflict, so the write would be silently
 * absorbed. A taken slot takes the next free number instead.
 */
export function followupSlot(part: PlanPart, parts: readonly PlanPart[]): FollowupSlot {
  const base = part.slug.endsWith('-followup') ? part.slug : `${part.slug}-followup`;
  const bySlug = new Map(parts.map((p) => [p.slug, p]));
  // A retired row counts as taken too, or re-declaring one would lift a retirement an operator's replan had already dropped.
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
 * Arm B's new part, as the planner would have declared it. Appended, never a
 * resurrection of the part that fell short — a merged part's branch is spent, so
 * returning it to `ready` would put an agent on a closed PR's branch. `dependsOn` is
 * empty on purpose, since the part it follows up has already finished.
 */
export function followupPartInput(part: PlanPart, summary: string, seq: number, slug: string): PlanPartInput {
  return {
    slug,
    // Inherits the part's price rather than the goal's, which would downgrade a part somebody decided needed more.
    profile: part.profile,
    seq,
    title: `Finish "${part.title}"`,
    // The assessor's own words are the scope.
    scope: summary,
    // No inherited paths: carrying the finished part's touches over would claim a scope nobody declared.
    touches: [],
    rationale: `An assessment of the delivered work found that "${part.slug}" did not deliver its scope.`,
    acceptance: null,
    size: null,
    dependsOn: [],
    expectedKind: 'code',
  };
}

/**
 * What the assessor is told happens next, per cause. Careful about tense: nothing has
 * happened yet — the verdict is a row, the rule proposes the arm on a later pulse and a
 * human decides it.
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
