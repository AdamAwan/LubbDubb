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

/**
 * What the assayer is allowed to say about which profile a goal's work wants
 * (issue #342), given the profiles this deployment actually configures.
 *
 * The names are the operator's own, handed to the agent by the tool rather than
 * mapped through a difficulty scale of the harness's invention. A scale would
 * need a second table (`byDifficulty`) translating three fixed words into an
 * arbitrary set of profile names, and the translation is exactly where the
 * meaning would be lost: an operator who splits `deep` into two knows what the
 * two are for, and a fixed vocabulary cannot be told.
 *
 * Empty for a deployment with no `agentModels` — and then nothing is asked and
 * nothing is refused for its absence, because there is no choice to make.
 */
export function validateGoalAssay(
  args: Record<string, unknown>,
  profiles: readonly string[] = [],
): { ok: true; verdict: GoalAssayVerdictName; summary: string; profile: string | null } | { ok: false; error: string } {
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
  const named = verdict === 'workable' ? checkProfile(args.profile, profiles) : { ok: true as const, profile: null };
  if (!named.ok) return named;
  return { ok: true, verdict: verdict as GoalAssayVerdictName, summary, profile: named.profile };
}

/**
 * The proposed profile, or why it is not one.
 *
 * Asked only of a **workable** verdict, and dropped rather than refused on an
 * `unclear` one: a goal nobody could start from has no work to size, so a profile
 * beside it is answering a question that does not arise. Refusing it instead
 * would spend a round trip teaching an agent a distinction that changes nothing.
 *
 * Required when this deployment has profiles, for the reason the summary is
 * required: an optional field is one most agents will omit most of the time, and
 * an omitted proposal is indistinguishable from "the default is right" — which is
 * the answer the harness would then act on, at the default's price, having asked.
 */
function checkProfile(
  value: unknown,
  profiles: readonly string[],
): { ok: true; profile: string | null } | { ok: false; error: string } {
  if (profiles.length === 0) return { ok: true, profile: null };
  const options = profiles.join(', ');
  if (typeof value !== 'string' || value.length === 0)
    return {
      ok: false,
      error:
        `profile is required: say which model profile this issue's work should run on, from ${options} — ` +
        `they are listed cheapest-first with what each is for in this tool's description. Judge the work the ` +
        `ticket implies, not the ticket's length. If a human has already pinned a profile on the ticket and you ` +
        `agree with it, name that one.`,
    };
  if (!profiles.includes(value))
    return { ok: false, error: `profile "${value}" is not one of this deployment's profiles: ${options}.` };
  return { ok: true, profile: value };
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

  // The remedy is `escalate` for all three, but a planner is deliberating rather
  // than working (`src/issueOrigins.ts`), so the sentence saying why differs.
  const planner = /^issue:(\d+):plan$/.exec(ref);
  if (planner) {
    return {
      ok: false,
      error:
        `assay_issue is for an agent dispatched to judge whether issue #${planner[1]}'s goal can be acted ` +
        `on at all, before any work starts, and you were dispatched to decompose it — which the harness ` +
        `only asks for once the goal has been read as workable. If it is unclear to you now that you are ` +
        `in it, escalate — that reaches a human who can answer you, where this would only park an issue ` +
        `already under way.`,
    };
  }
  const working = /^issue:(\d+)(?::part:.+)?$/.exec(ref);
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
