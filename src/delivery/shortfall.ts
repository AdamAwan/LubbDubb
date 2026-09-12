import { z } from 'zod';
import { issueOriginRef } from '../issueOrigins.js';
import { optionalText } from '../server/validation.js';
import type { PlanPart, PlanPartInput, ShortfallCause } from '../types.js';
import { partHasWork } from '../plans/parts.js';

// → docs/spec/24-environments.md

export const SHORTFALL_CAUSES = ['plan', 'part', 'goal'] as const;

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

export function shortfallRef(issueNumber: number): string {
  return issueOriginRef('shortfall', issueNumber);
}

export function shortfallArm(
  cause: ShortfallCause | null,
  hasPlan: boolean,
): 'replan' | 'followup' | 'escalate' | 'none' {
  if (cause === null) return 'none';
  if (cause === 'goal') return 'escalate';
  if (!hasPlan) return 'escalate';
  return cause === 'plan' ? 'replan' : 'followup';
}

export function quotedAssessment(summary: string, detail: string | null): string {
  return detail ? `**${summary}**\n\n${detail}` : summary;
}

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

interface FollowupSlot {
  slug: string;
  refreshing: boolean;
}

export function followupSlot(part: PlanPart, parts: readonly PlanPart[]): FollowupSlot {
  const base = part.slug.endsWith('-followup') ? part.slug : `${part.slug}-followup`;
  const bySlug = new Map(parts.map((p) => [p.slug, p]));
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

export function followupPartInput(part: PlanPart, summary: string, seq: number, slug: string): PlanPartInput {
  return {
    slug,
    profile: part.profile,
    seq,
    title: `Finish "${part.title}"`,
    scope: summary,
    touches: [],
    rationale: `An assessment of the delivered work found that "${part.slug}" did not deliver its scope.`,
    acceptance: null,
    size: null,
    dependsOn: [],
    expectedKind: 'code',
  };
}

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
