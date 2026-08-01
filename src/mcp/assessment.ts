/**
 * The `assess_issue` tool's pure layer: what an assessment is allowed to be, and
 * whose origin may cast one.
 *
 * Modelled on `conclusion.ts` because the two are siblings, and split from it
 * because they are not the same statement. `conclude_work` is the agent that did
 * the work saying whether it finished; this is a later agent, dispatched by rule
 * 3e with a checkout of the delivered state and the work graph in front of it,
 * saying whether the *issue* is finished. The summary is required and kept whole
 * for `validateConclusion`'s reason: a verdict that parks a ticket has to be
 * reviewable, and it is written once per issue rather than once a minute.
 */

import { SHORTFALL_CAUSES, SHORTFALL_CAUSE_HELP } from '../delivery/shortfall.js';
import type { ShortfallCause } from '../types.js';

/** What an assessor may conclude. */
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

/** Long enough to be prose, short of a pasted transcript. Matches the conclusion cap. */
const MAX_ASSESSMENT_SUMMARY = 2000;

/**
 * A validated assessment. `cause`/`part` are only ever set for `more_work` — a
 * delivered issue has nothing that fell short — and `cause` may still be null
 * there, because whether it is *required* depends on the plan, which is a store
 * question this pure layer deliberately cannot ask. That check lives in
 * `AgentManager.recordAssessment`, one call away, where the plan is in hand.
 */
interface ValidAssessment {
  verdict: AssessmentVerdict;
  summary: string;
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
        'summary is required. Say what you found in the repository and which pull requests delivered it ' +
        '(for delivered), or precisely what is missing (for more_work) — an operator decides what happens ' +
        'to the ticket from this alone.',
    };
  }
  if (summary.length > MAX_ASSESSMENT_SUMMARY) {
    return {
      ok: false,
      error: `summary is too long (${summary.length} chars, max ${MAX_ASSESSMENT_SUMMARY}). Summarise it.`,
    };
  }

  // A `delivered` verdict has nothing that fell short, so the two shortfall
  // fields are *refused* rather than ignored — an assessor that filled them in
  // has contradicted itself, and silently dropping them would leave it believing
  // it had routed something.
  if (verdict === 'delivered') {
    if (args.cause !== undefined || args.part !== undefined) {
      return {
        ok: false,
        error:
          'cause and part describe what fell short, and you said the issue is delivered. Drop them, or ' +
          'say more_work if something is in fact missing.',
      };
    }
    return { ok: true, verdict, summary, cause: null, part: null };
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
    cause: (cause as ShortfallCause | undefined) ?? null,
    part: part || null,
  };
}

/**
 * Resolve a task's origin into the issue it may assess — or say why it may not.
 *
 * **Only an assessor's own origin qualifies**, which is `conclusionOrigin`'s
 * discipline pointed the other way: there, a part agent is refused because the
 * plan speaks for the issue; here, every agent that is *doing* work is refused
 * because judging your own delivery is not an assessment. The agent that wrote
 * the code has `conclude_work`, which records what it believes it did; rule `issue-assess`
 * exists precisely to have someone else look.
 *
 * Refusing beats silently narrowing, for the reason `conclusionOrigin` gives: an
 * agent handed `{ok: true}` would believe it had parked the issue.
 */
export function assessmentOrigin(
  originRef: string | null,
): { ok: true; originRef: string; issueOrigin: string } | { ok: false; error: string } {
  const ref = originRef ?? '';
  const match = /^issue:(\d+):assess$/.exec(ref);
  if (match) return { ok: true, originRef: ref, issueOrigin: `issue:${match[1]}` };

  const working = /^issue:(\d+)(?::(?:plan|part:.+))?$/.exec(ref);
  if (working) {
    return {
      ok: false,
      error:
        `assess_issue is for an agent dispatched to judge whether issue #${working[1]} is finished, and ` +
        `you were dispatched to work on it. Use conclude_work to record what you believe you delivered; ` +
        `the harness assesses the issue separately, which is the point — it is not a judgement you make ` +
        `about your own work.`,
    };
  }
  const assayer = /^issue:(\d+):assay$/.exec(ref);
  if (assayer) {
    return {
      ok: false,
      error:
        `assess_issue says whether issue #${assayer[1]} was delivered, and you were dispatched to judge ` +
        `whether its goal can be worked from at all, before anything was started. Cast your verdict with ` +
        `assay_issue instead.`,
    };
  }
  return {
    ok: false,
    error:
      `assess_issue says whether an issue is finished, and this task's origin is ${ref || '(none)'}, ` +
      `which is not an issue assessment. Only the agent dispatched to assess an issue casts this verdict.`,
  };
}
