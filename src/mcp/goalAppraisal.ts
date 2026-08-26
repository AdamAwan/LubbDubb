/**
 * The `appraise_issue` tool's pure layer: what a goal appraisal is allowed to be, and
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

import { normalizeAreaPath } from '../intake/placement.js';

/** What an appraiser may conclude about a goal. */
export const GOAL_APPRAISAL_VERDICTS = ['workable', 'unclear'] as const;

export type GoalAppraisalVerdictName = (typeof GOAL_APPRAISAL_VERDICTS)[number];

export const GOAL_APPRAISAL_VERDICT_HELP: Record<GoalAppraisalVerdictName, string> = {
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
const MAX_APPRAISAL_SUMMARY = 2000;

/**
 * What the appraiser is allowed to say about which profile a goal's work wants
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
export function validateGoalAppraisal(
  args: Record<string, unknown>,
  profiles: readonly string[] = [],
  areaPaths: readonly string[] = [],
):
  | {
      ok: true;
      verdict: GoalAppraisalVerdictName;
      summary: string;
      profile: string | null;
      parent: number | null;
      areaPath: string | null;
    }
  | { ok: false; error: string } {
  const verdict = args.status;
  if (typeof verdict !== 'string' || !GOAL_APPRAISAL_VERDICTS.includes(verdict as GoalAppraisalVerdictName)) {
    return {
      ok: false,
      error:
        `status must be one of ${GOAL_APPRAISAL_VERDICTS.join(', ')}. ` +
        GOAL_APPRAISAL_VERDICTS.map((v) => `${v}: ${GOAL_APPRAISAL_VERDICT_HELP[v]}`).join('. '),
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
  if (summary.length > MAX_APPRAISAL_SUMMARY) {
    return {
      ok: false,
      error: `summary is too long (${summary.length} chars, max ${MAX_APPRAISAL_SUMMARY}). Summarise it.`,
    };
  }
  const named = verdict === 'workable' ? checkProfile(args.profile, profiles) : { ok: true as const, profile: null };
  if (!named.ok) return named;
  // Both placements are dropped on an `unclear` verdict for the profile's reason:
  // a goal nobody could start from has no work to file anywhere, so proposing a
  // home for it answers a question that does not arise.
  const workable = verdict === 'workable';
  const parent = workable ? checkParent(args.parent) : { ok: true as const, parent: null };
  if (!parent.ok) return parent;
  const area = workable ? checkAreaPath(args.area_path, areaPaths) : { ok: true as const, areaPath: null };
  if (!area.ok) return area;
  return {
    ok: true,
    verdict: verdict as GoalAppraisalVerdictName,
    summary,
    profile: named.profile,
    parent: parent.parent,
    areaPath: area.areaPath,
  };
}

/**
 * The proposed parent, or why it is not one.
 *
 * **Optional, unlike the profile**, and that asymmetry is the design rather than
 * an oversight. A profile is required because every dispatch runs on one, so an
 * omission is indistinguishable from "the default is right" — an answer the
 * harness would then act on at the default's price. A parent is not like that:
 * most items already have one, the tool cannot see whether this one does, and an
 * argument required of every appraisal would make a proposal for an item that needs
 * none the common case.
 *
 * Validated only for **shape**: a positive work item number.
 * The candidates the appraiser picks from are the open containers already appended
 * to its prompt (`relatedWorkNote`), and they are a suggestion rather than a
 * closed set — a board is narrowed by tag and assignee, so the right container is
 * sometimes one the harness never listed. Refusing anything outside the list
 * would make the harness's own view of the board the limit of what can be
 * proposed. What stops a hallucinated id doing damage is that nothing acts on it:
 * a human sees the number, with a link to it, before anything is written.
 */
function checkParent(value: unknown): { ok: true; parent: number | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, parent: null };
  const n =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim().replace(/^#/, '')) : NaN;
  if (!Number.isInteger(n) || n <= 0)
    return {
      ok: false,
      error: `parent must be the number of an existing work item — "${String(value)}" is not one. Omit it if none of the containers you were shown fit.`,
    };
  return { ok: true, parent: n };
}

/**
 * The proposed area path, or why it is not one.
 *
 * **Closed over the offered set**, where the parent above is not, and the two
 * differ because the failure modes do. A parent is a number a human immediately
 * recognises as wrong; an area path is a string that has to match a node in the
 * project's tree exactly, and a plausible near-miss — the right team spelled the
 * wrong way, a node that was renamed last quarter — is not visibly wrong to
 * anyone until the write is refused. So the harness offers the tree and the
 * appraiser picks from it.
 *
 * Empty offer means this deployment has no tree the harness could read, and then
 * nothing is asked and nothing refused — the same shape an absent `agentModels`
 * gives the profile.
 */
function checkAreaPath(
  value: unknown,
  areaPaths: readonly string[],
): { ok: true; areaPath: string | null } | { ok: false; error: string } {
  if (areaPaths.length === 0) return { ok: true, areaPath: null };
  if (value === undefined || value === null || value === '') return { ok: true, areaPath: null };
  if (typeof value !== 'string')
    return { ok: false, error: `area_path must be one of this project's area paths: ${areaPaths.join(', ')}.` };
  // Matched on the provider's own normalisation, then answered with the
  // provider's own spelling: a path that came back differently cased or
  // slash-separated is one node, and storing the agent's spelling of it would
  // hand the write a string the tracker may not accept.
  const wanted = normalizeAreaPath(value);
  const match = areaPaths.find((p) => normalizeAreaPath(p) === wanted);
  if (match === undefined)
    return {
      ok: false,
      error: `area_path "${value}" is not one of this project's area paths: ${areaPaths.join(', ')}.`,
    };
  return { ok: true, areaPath: match };
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
 * Resolve a task's origin into the issue it may appraisal — or say why it may not.
 *
 * **Only an appraiser's own origin qualifies**, which is `assessmentOrigin`'s
 * discipline applied at the other end of the run: there, an agent that did the work
 * is refused because judging your own delivery is not an assessment; here, every
 * agent that is *doing* the work is refused because an agent already at work has
 * answered the question by starting. A verdict of `unclear` from one of them would
 * park an issue it is itself mid-way through.
 *
 * Refusing beats silently narrowing, for the reason `conclusionOrigin` gives: an
 * agent handed `{ok: true}` would believe it had parked the issue.
 */
export function appraiserOrigin(
  originRef: string | null,
): { ok: true; originRef: string; issueOrigin: string } | { ok: false; error: string } {
  const ref = originRef ?? '';
  const match = /^issue:(\d+):appraisal$/.exec(ref);
  if (match) return { ok: true, originRef: ref, issueOrigin: `issue:${match[1]}` };

  const assessor = /^issue:(\d+):assess$/.exec(ref);
  if (assessor) {
    return {
      ok: false,
      error:
        `appraise_issue says whether issue #${assessor[1]}'s goal can be worked from at all, and you were ` +
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
        `appraise_issue is for an agent dispatched to judge whether issue #${planner[1]}'s goal can be acted ` +
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
        `appraise_issue is for an agent dispatched to judge whether issue #${working[1]}'s goal can be acted ` +
        `on, before any work starts, and you were dispatched to do the work. If the goal is unclear to ` +
        `you now that you are in it, escalate — that reaches a human who can answer you, where this would ` +
        `only park the issue you are already working.`,
    };
  }
  return {
    ok: false,
    error:
      `appraise_issue says whether an issue's goal can be worked from, and this task's origin is ` +
      `${ref || '(none)'}, which is not an issue appraisal. Only the agent dispatched to appraise an issue casts ` +
      `this verdict.`,
  };
}
