/**
 * The `assay_issue` tool's pure layer: what a goal assay is allowed to be, and
 * whose origin may cast one.
 *
 * Modelled on `assessment.ts` because the two are the same shape pointed at
 * opposite ends of an issue — one asks whether it was workable before anything
 * started, the other whether it was delivered after everything finished — and split
 * from it because they are not the same statement and must not share a verdict
 * vocabulary. The summary is required and kept whole for `validateAssessment`'s
 * reason: a verdict that parks a ticket has to be reviewable, and it is written
 * once per issue rather than once a minute.
 */

/** What an assayer may conclude about a goal. */
export const GOAL_ASSAY_VERDICTS = ['workable', 'unclear'] as const;

export type GoalAssayVerdictName = (typeof GOAL_ASSAY_VERDICTS)[number];

export const GOAL_ASSAY_VERDICT_HELP: Record<GoalAssayVerdictName, string> = {
  workable:
    'there is a goal here an agent could start from — you may not agree with it, and it may be large, ' +
    'but what is being asked for is identifiable against this repository. The harness proceeds exactly ' +
    'as it would have',
  unclear:
    'the goal cannot be acted on as written — it is ambiguous about what "done" means, it contradicts ' +
    'itself or something already true of the repository, or it names things that do not exist. Nothing ' +
    'is dispatched for it until the ticket changes or a human overrides you',
};

/** Long enough to be prose, short of a pasted transcript. Matches the assessment cap. */
const MAX_ASSAY_SUMMARY = 2000;

export function validateGoalAssay(
  args: Record<string, unknown>,
): { ok: true; verdict: GoalAssayVerdictName; summary: string } | { ok: false; error: string } {
  const verdict = args.status;
  if (typeof verdict !== 'string' || !GOAL_ASSAY_VERDICTS.includes(verdict as GoalAssayVerdictName)) {
    return {
      ok: false,
      error:
        `status must be one of ${GOAL_ASSAY_VERDICTS.join(', ')}. ` +
        GOAL_ASSAY_VERDICTS.map((v) => `${v}: ${GOAL_ASSAY_VERDICT_HELP[v]}`).join('. '),
    };
  }
  const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
  if (!summary) {
    return {
      ok: false,
      error:
        'summary is required. For unclear, say exactly what you would need in order to start — that text ' +
        'is the whole of what a human has to go on, and nothing happens for this issue until they act on ' +
        'it. For workable, say in a sentence what you understood the goal to be, so a wrong reading is ' +
        'visible before an agent acts on it.',
    };
  }
  if (summary.length > MAX_ASSAY_SUMMARY) {
    return {
      ok: false,
      error: `summary is too long (${summary.length} chars, max ${MAX_ASSAY_SUMMARY}). Summarise it.`,
    };
  }
  return { ok: true, verdict: verdict as GoalAssayVerdictName, summary };
}

/**
 * Resolve a task's origin into the issue it may assay — or say why it may not.
 *
 * **Only an assayer's own origin qualifies**, which is `assessmentOrigin`'s
 * discipline applied at the other end of the run: there, an agent that did the work
 * is refused because judging your own delivery is not an assessment; here, every
 * agent that is *doing* the work is refused because an agent already at work has
 * answered the question by starting. A verdict of `unclear` from one of them would
 * park an issue it is itself mid-way through.
 *
 * Refusing beats silently narrowing, for the reason `conclusionOrigin` gives: an
 * agent handed `{ok: true}` would believe it had parked the issue.
 */
export function assayerOrigin(
  originRef: string | null,
): { ok: true; originRef: string; issueOrigin: string } | { ok: false; error: string } {
  const ref = originRef ?? '';
  const match = /^issue:(\d+):assay$/.exec(ref);
  if (match) return { ok: true, originRef: ref, issueOrigin: `issue:${match[1]}` };

  const assessor = /^issue:(\d+):assess$/.exec(ref);
  if (assessor) {
    return {
      ok: false,
      error:
        `assay_issue says whether issue #${assessor[1]}'s goal can be worked from at all, and you were ` +
        `dispatched to judge whether it was delivered. Cast your verdict with assess_issue instead.`,
    };
  }

  const working = /^issue:(\d+)(?::(?:plan|part:.+))?$/.exec(ref);
  if (working) {
    return {
      ok: false,
      error:
        `assay_issue is for an agent dispatched to judge whether issue #${working[1]}'s goal can be acted ` +
        `on, before any work starts, and you were dispatched to do the work. If the goal is unclear to ` +
        `you now that you are in it, escalate — that reaches a human who can answer you, where this would ` +
        `only park the issue you are already working.`,
    };
  }
  return {
    ok: false,
    error:
      `assay_issue says whether an issue's goal can be worked from, and this task's origin is ` +
      `${ref || '(none)'}, which is not an issue assay. Only the agent dispatched to assay an issue casts ` +
      `this verdict.`,
  };
}
