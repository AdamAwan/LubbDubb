import { SHORTFALL_CAUSES, SHORTFALL_CAUSE_HELP } from '../delivery/shortfall.js';
import type { ShortfallCause } from '../types.js';

// → docs/spec/11-mcp-tools.md

export const ASSESSMENT_VERDICTS = ['delivered', 'more_work'] as const;

export type AssessmentVerdict = (typeof ASSESSMENT_VERDICTS)[number];

export const ASSESSMENT_VERDICT_HELP: Record<AssessmentVerdict, string> = {
  delivered:
    'what the issue asked for is present in the repository; the harness should schedule nothing further ' +
    'for it. This does not close the ticket — a human does that after testing — and it is reversible',
  more_work:
    'something the issue asked for is missing or unverifiable. Say what fell short in `cause` and the ' +
    'harness routes it: a wrong decomposition back to a planner, one short part to a follow-up part, a ' +
    'wrong goal to a human',
};

const MAX_ASSESSMENT_SUMMARY = 160;

const MAX_ASSESSMENT_DETAIL = 2000;

interface ValidAssessment {
  verdict: AssessmentVerdict;
  summary: string;
  detail: string | null;
  cause: ShortfallCause | null;
  part: string | null;
}

export function validateAssessment(
  args: Record<string, unknown>,
): ({ ok: true } & ValidAssessment) | { ok: false; error: string } {
  const verdict = args.status;
  if (typeof verdict !== 'string' || !ASSESSMENT_VERDICTS.includes(verdict as AssessmentVerdict)) {
    return {
      ok: false,
      error:
        `status must be one of ${ASSESSMENT_VERDICTS.join(', ')}. ` +
        ASSESSMENT_VERDICTS.map((v) => `${v}: ${ASSESSMENT_VERDICT_HELP[v]}`).join('. '),
    };
  }
  const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
  if (!summary) {
    return {
      ok: false,
      error:
        'summary is required. One line saying whether the goal is reached and what decided it; the evidence ' +
        'goes in `detail`. An operator decides what happens to the ticket from these two alone.',
    };
  }
  if (/[\r\n]/.test(summary)) {
    return {
      ok: false,
      error:
        'summary is one line — what you found, in a sentence. Everything with a line break in it is evidence: ' +
        'put it in `detail`, which takes markdown and is rendered as the body of the card an operator reads.',
    };
  }
  if (summary.length > MAX_ASSESSMENT_SUMMARY) {
    return {
      ok: false,
      error:
        `summary is too long (${summary.length} chars, max ${MAX_ASSESSMENT_SUMMARY}) — it is the headline, ` +
        `not the account. Keep the claim and move the rest to \`detail\`.`,
    };
  }
  const detailText = typeof args.detail === 'string' ? args.detail.trim() : '';
  if (detailText.length > MAX_ASSESSMENT_DETAIL) {
    return {
      ok: false,
      error: `detail is too long (${detailText.length} chars, max ${MAX_ASSESSMENT_DETAIL}). Summarise it.`,
    };
  }
  const detail = detailText || null;

  if (verdict === 'delivered') {
    if (args.cause !== undefined || args.part !== undefined) {
      return {
        ok: false,
        error:
          'cause and part describe what fell short, and you said the issue is delivered. Drop them, or ' +
          'say more_work if something is in fact missing.',
      };
    }
    return { ok: true, verdict, summary, detail, cause: null, part: null };
  }

  const cause = args.cause;
  if (cause !== undefined && (typeof cause !== 'string' || !SHORTFALL_CAUSES.includes(cause as ShortfallCause))) {
    return {
      ok: false,
      error:
        `cause must be one of ${SHORTFALL_CAUSES.join(', ')}. ` +
        SHORTFALL_CAUSES.map((c) => `${c}: ${SHORTFALL_CAUSE_HELP[c]}`).join('. '),
    };
  }
  const part = typeof args.part === 'string' ? args.part.trim() : '';
  if (part && cause !== 'part') {
    return {
      ok: false,
      error:
        `part names the one part that fell short, which only means something for cause "part" — you said ` +
        `${cause === undefined ? 'no cause' : `"${cause}"`}. Say cause "part" if that is what you meant, or drop part.`,
    };
  }
  if (cause === 'part' && !part) {
    return {
      ok: false,
      error:
        'cause "part" says one named part did not deliver its scope, so name it in `part` (its slug, as the ' +
        'plan declares it). If you cannot say which, the decomposition itself is what is wrong — say cause "plan".',
    };
  }
  return {
    ok: true,
    verdict: verdict as AssessmentVerdict,
    summary,
    detail,
    cause: (cause as ShortfallCause | undefined) ?? null,
    part: part || null,
  };
}

export function assessmentOrigin(
  originRef: string | null,
): { ok: true; originRef: string; issueOrigin: string } | { ok: false; error: string } {
  const ref = originRef ?? '';
  const match = /^issue:(\d+):assess$/.exec(ref);
  if (match) return { ok: true, originRef: ref, issueOrigin: `issue:${match[1]}` };

  const planner = /^issue:(\d+):plan$/.exec(ref);
  if (planner) {
    return {
      ok: false,
      error:
        `assess_issue is for an agent dispatched to judge whether issue #${planner[1]} is finished, and ` +
        `you are planning it rather than delivering it. Submit your decomposition with plan_submit ` +
        `instead; the harness assesses the issue once the work is done.`,
    };
  }
  const part = /^issue:(\d+):part:/.exec(ref);
  if (part) {
    return {
      ok: false,
      error:
        `assess_issue is for an agent dispatched to judge whether issue #${part[1]} is finished, and you ` +
        `are working one part of its plan. Close your part with conclude_part — the plan roll-up is what ` +
        `concludes the issue, and the harness assesses it separately, which is the point.`,
    };
  }
  const worker = /^issue:(\d+)$/.exec(ref);
  if (worker) {
    return {
      ok: false,
      error:
        `assess_issue is for an agent dispatched to judge whether issue #${worker[1]} is finished, and ` +
        `you were dispatched to work on it. Use conclude_work to record what you believe you delivered; ` +
        `the harness assesses the issue separately, which is the point — it is not a judgement you make ` +
        `about your own work.`,
    };
  }
  const appraiser = /^issue:(\d+):appraisal$/.exec(ref);
  if (appraiser) {
    return {
      ok: false,
      error:
        `assess_issue says whether issue #${appraiser[1]} was delivered, and you were dispatched to judge ` +
        `whether its goal can be worked from at all, before anything was started. Cast your verdict with ` +
        `appraise_issue instead.`,
    };
  }
  return {
    ok: false,
    error:
      `assess_issue says whether an issue is finished, and this task's origin is ${ref || '(none)'}, ` +
      `which is not an issue assessment. Only the agent dispatched to assess an issue casts this verdict.`,
  };
}
