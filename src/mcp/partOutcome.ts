import type { PartOutcomeKind } from '../types.js';

/**
 * The `conclude_part` tool's pure layer: what a plan part is allowed to say it
 * produced.
 *
 * ## Why `code` is not one of the kinds
 *
 * A code part finishes by merging a pull request, and the world observes that —
 * `observePartPr` reads it off the provider every pulse. Accepting `code` here
 * would let an agent declare its own work finished with no pull request behind it,
 * which is exactly the false terminal that ruled *derivation* out when this was
 * designed. The tool covers precisely the two outcomes that have no outside world
 * to observe them, and the refusal says so rather than silently rejecting.
 *
 * ## Why the summary is required and not trimmed
 *
 * `conclude_work`'s rule, for its reason. A progress note is cheap and frequent, so
 * trimming an over-long one beats refusing it; a terminal is written once and read
 * by an operator deciding what the plan achieved — and for a determination it is
 * the entire record of why no code was written. A silently truncated one is worse
 * than a refusal the agent can act on.
 */

/** The kinds an agent may declare. `code` is deliberately absent — see above. */
export const PART_OUTCOME_KINDS = ['report', 'determination'] as const satisfies readonly PartOutcomeKind[];

type DeclarableKind = (typeof PART_OUTCOME_KINDS)[number];

export const PART_OUTCOME_KIND_HELP: Record<DeclarableKind, string> = {
  report: 'the deliverable is a write-up, a measurement or a document rather than a change to the code',
  determination:
    'you established that nothing needs building here — it is already done, it duplicates other work, ' +
    'or the premise turned out to be wrong',
};

/** A summary long enough to be prose rather than a label, short of a pasted transcript. */
const MAX_PART_SUMMARY = 2000;

/**
 * Resolve a task's origin into the part it may conclude — or say why it may not.
 *
 * Only a part origin qualifies, and every other caller is refused **by name**
 * rather than scoped down: an agent handed `{ok: true}` would reasonably believe it
 * had closed something. Each refusal names the tool that caller actually wants, the
 * way `conclusionOrigin`'s assessor arm points at `assess_issue`.
 */
export function partConclusionOrigin(
  originRef: string | null,
): { ok: true; issueNumber: number; slug: string } | { ok: false; error: string } {
  const ref = originRef ?? '';
  const part = /^issue:(\d+):part:([a-z0-9][a-z0-9-]*)$/.exec(ref);
  if (part) return { ok: true, issueNumber: Number(part[1]), slug: part[2]! };

  const issue = /^issue:(\d+)$/.exec(ref);
  if (issue) {
    return {
      ok: false,
      error:
        `conclude_part closes one part of a decomposed issue, and you own the whole of issue ` +
        `#${issue[1]} rather than a part of it. Use conclude_work instead — it says whether the issue ` +
        `is finished, which is the verdict your origin carries.`,
    };
  }
  const planner = /^issue:(\d+):plan$/.exec(ref);
  if (planner) {
    return {
      ok: false,
      error:
        `conclude_part closes a part that has been worked, and you are planning issue #${planner[1]}, ` +
        `not delivering any of it. Submit your decomposition with plan_submit instead.`,
    };
  }
  const assessor = /^issue:(\d+):assess$/.exec(ref);
  if (assessor) {
    return {
      ok: false,
      error:
        `conclude_part closes a part you worked, and you were dispatched to *assess* issue ` +
        `#${assessor[1]} rather than to deliver any of it. Cast your verdict with assess_issue instead.`,
    };
  }
  const assayer = /^issue:(\d+):assay$/.exec(ref);
  if (assayer) {
    return {
      ok: false,
      error:
        `conclude_part closes a part you worked, and you were dispatched to judge whether issue ` +
        `#${assayer[1]}'s goal can be worked from at all. Cast your verdict with assay_issue instead.`,
    };
  }
  return {
    ok: false,
    error:
      `conclude_part closes one part of a decomposed issue, and this task's origin is ` +
      `${ref || '(none)'}, which is not a part. Only the agent dispatched for a plan part concludes it.`,
  };
}

export function validatePartConclusion(
  args: Record<string, unknown>,
): { ok: true; kind: DeclarableKind; summary: string; ref: string | null } | { ok: false; error: string } {
  const kind = args.kind;
  if (kind === 'code') {
    return {
      ok: false,
      error:
        'a code part finishes by merging its pull request, which the harness observes for itself — there ' +
        'is nothing for you to declare. Open the pull request instead. If you found that no code is ' +
        'needed after all, that is kind "determination".',
    };
  }
  if (typeof kind !== 'string' || !PART_OUTCOME_KINDS.includes(kind as DeclarableKind)) {
    return {
      ok: false,
      error:
        `kind must be one of ${PART_OUTCOME_KINDS.join(', ')}. ` +
        PART_OUTCOME_KINDS.map((k) => `${k}: ${PART_OUTCOME_KIND_HELP[k]}`).join('. '),
    };
  }
  const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
  if (!summary) {
    return {
      ok: false,
      error:
        'summary is required. Say what you produced or found — an operator reads this to decide what the ' +
        'plan achieved, and for a determination it is the whole record of why no code was written.',
    };
  }
  if (summary.length > MAX_PART_SUMMARY) {
    return {
      ok: false,
      error: `summary is too long (${summary.length} chars, max ${MAX_PART_SUMMARY}). Summarise it.`,
    };
  }
  const raw = args.evidenceRef;
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    return { ok: false, error: 'evidenceRef must be a string when given.' };
  }
  const ref = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  // A narrow vocabulary, for `report_finding`'s reason: an open-ended evidence
  // field is an unqueryable junk drawer, and both records it may name are already
  // addressed this way everywhere else.
  if (ref !== null && !/^(flag|finding):\S+$/.test(ref)) {
    return {
      ok: false,
      error:
        'evidenceRef must be "flag:<id>" (an artifact you surfaced) or "finding:<id>" (something you ' +
        'reported with report_finding). Omit it if you have neither — the summary is what matters.',
    };
  }
  return { ok: true, kind: kind as DeclarableKind, summary, ref };
}
