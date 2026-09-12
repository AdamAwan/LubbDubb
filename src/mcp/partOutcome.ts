import { issueOriginId, issueOriginNumber } from '../issueOrigins.js';
import type { PartOutcomeKind } from '../types.js';

// → docs/spec/11-mcp-tools.md

export const PART_OUTCOME_KINDS = ['report', 'determination'] as const satisfies readonly PartOutcomeKind[];

type DeclarableKind = (typeof PART_OUTCOME_KINDS)[number];

export const PART_OUTCOME_KIND_HELP: Record<DeclarableKind, string> = {
  report: 'the deliverable is a write-up, a measurement or a document rather than a change to the code',
  determination:
    'you established that nothing needs building here — it is already done, it duplicates other work, ' +
    'or the premise turned out to be wrong',
};

const MAX_PART_SUMMARY = 2000;

// The slug shape `plan_submit` validated the part under. → docs/spec/08-planning.md
const PART_SLUG = /^[a-z0-9][a-z0-9-]*$/;

export function partConclusionOrigin(
  originRef: string | null,
): { ok: true; issueNumber: number; slug: string } | { ok: false; error: string } {
  const ref = originRef ?? '';
  const part = issueOriginId('part', ref);
  if (part !== null && PART_SLUG.test(part.id)) return { ok: true, issueNumber: part.issueNumber, slug: part.id };

  const issue = issueOriginNumber('root', ref);
  if (issue !== null) {
    return {
      ok: false,
      error:
        `conclude_part closes one part of a decomposed issue, and you own the whole of issue ` +
        `#${issue} rather than a part of it. Use conclude_work instead — it says whether the issue ` +
        `is finished, which is the verdict your origin carries.`,
    };
  }
  const planner = issueOriginNumber('plan', ref);
  if (planner !== null) {
    return {
      ok: false,
      error:
        `conclude_part closes a part that has been worked, and you are planning issue #${planner}, ` +
        `not delivering any of it. Submit your decomposition with plan_submit instead.`,
    };
  }
  const assessor = issueOriginNumber('assess', ref);
  if (assessor !== null) {
    return {
      ok: false,
      error:
        `conclude_part closes a part you worked, and you were dispatched to *assess* issue ` +
        `#${assessor} rather than to deliver any of it. Cast your verdict with assess_issue instead.`,
    };
  }
  const appraiser = issueOriginNumber('appraisal', ref);
  if (appraiser !== null) {
    return {
      ok: false,
      error:
        `conclude_part closes a part you worked, and you were dispatched to judge whether issue ` +
        `#${appraiser}'s goal can be worked from at all. Cast your verdict with appraise_issue instead.`,
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
