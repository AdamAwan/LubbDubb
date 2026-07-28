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

/** What an assessor may conclude. */
export const ASSESSMENT_VERDICTS = ['delivered', 'more_work'] as const;

export type AssessmentVerdict = (typeof ASSESSMENT_VERDICTS)[number];

export const ASSESSMENT_VERDICT_HELP: Record<AssessmentVerdict, string> = {
  delivered:
    'what the issue asked for is present in the repository; the harness should schedule nothing further ' +
    'for it. This does not close the ticket — a human does that after testing — and it is reversible',
  more_work:
    'something the issue asked for is missing or unverifiable; the issue should come back round, with ' +
    'your summary in front of the next agent',
};

/** Long enough to be prose, short of a pasted transcript. Matches the conclusion cap. */
const MAX_ASSESSMENT_SUMMARY = 2000;

export function validateAssessment(
  args: Record<string, unknown>,
): { ok: true; verdict: AssessmentVerdict; summary: string } | { ok: false; error: string } {
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
  return { ok: true, verdict: verdict as AssessmentVerdict, summary };
}

/**
 * Resolve a task's origin into the issue it may assess — or say why it may not.
 *
 * **Only an assessor's own origin qualifies**, which is `conclusionOrigin`'s
 * discipline pointed the other way: there, a part agent is refused because the
 * plan speaks for the issue; here, every agent that is *doing* work is refused
 * because judging your own delivery is not an assessment. The agent that wrote
 * the code has `conclude_work`, which records what it believes it did; rule 3e
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
  return {
    ok: false,
    error:
      `assess_issue says whether an issue is finished, and this task's origin is ${ref || '(none)'}, ` +
      `which is not an issue assessment. Only the agent dispatched to assess an issue casts this verdict.`,
  };
}
