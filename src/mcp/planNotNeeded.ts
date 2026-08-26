/**
 * The `plan_not_needed` tool's pure layer: what "this goal is already met" is
 * allowed to be, and whose origin may say it.
 *
 * ## Why a planner needs a second verdict
 *
 * `PlanDocumentSchema` requires at least one part, and that refusal is right for
 * every plan there is — work that is one pull request is a one-part plan, not a
 * separate shape (`docs/spec/08-planning.md`). What it cannot express is
 * the answer a planner sometimes arrives at after reading the repository: there is
 * nothing to build here, because what the ticket asks for is already true. Someone
 * fixed it by hand, another goal's part covered it, or the ticket was filed against
 * a version that predates the fix.
 *
 * With only `plan_submit` on offer, a planner in that position has three moves and
 * every one of them is worse than saying so. It invents a part — and an agent is
 * dispatched, cuts a branch, finds nothing to do and concludes it, at the price of
 * a whole run. It writes a part that re-does work already done, which is the
 * expensive version of the same mistake and lands a pull request nobody wanted. Or
 * it submits nothing, spends its attempts, and the issue fails open to
 * `unplanned` — where rule `issue-pickup` puts an implementation agent on it,
 * which is the first outcome again with the planner's finding thrown away.
 *
 * So the verdict is cast where it is known, by the agent that knows it.
 *
 * ## Why it lands as a delivery
 *
 * `issue_deliveries` already means exactly this — "what the issue asked for is
 * present; schedule nothing further" — and is already read by the one gate that
 * has to hear it: `deliveryHold` filters `eligibleIssues`, so a verdict here stops
 * rule `issue-plan` re-dispatching *and* rule `issue-pickup` from taking the issue
 * instead. It is reversible by the operator, and it expires on world signal, which
 * is the right lifetime for a claim about a goal nobody has worked: the moment the
 * ticket moves or something links to it, the question is open again.
 *
 * A fifth verdict table was the alternative and would have bought nothing but a
 * row in `src/store/verdicts.ts`' exclusion matrix reading "clears a delivery,
 * cleared by a delivery" — which is the definition of the same fact.
 */

import { planOriginIssue } from '../plans/planning.js';

/** One line, and short enough to be one. Matches the assessment's headline cap. */
const MAX_SUMMARY = 160;

/** Long enough to be prose, short of a pasted transcript. The assessment's cap again. */
const MAX_DETAIL = 2000;

/**
 * What the planner said, or why it is not sayable.
 *
 * **`detail` is required here where an assessment's is optional**, and that is the
 * one place the two shapes differ. An assessor is corroborating work the harness
 * watched happen: the record of what was done already exists, and its headline is
 * read against it. A planner saying this is contradicting the ticket with nothing
 * behind it — no run, no pull request, no agent's own account — so the evidence
 * *is* the verdict, and a bare "already done" is not reviewable by the operator who
 * has to decide whether to believe it.
 */
export function validatePlanNotNeeded(
  args: Record<string, unknown>,
): { ok: true; summary: string; detail: string } | { ok: false; error: string } {
  const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
  if (!summary) {
    return {
      ok: false,
      error:
        'summary is required. One line saying what the issue asked for and where it already is; the ' +
        'evidence goes in `detail`. An operator decides whether to believe you from these two alone.',
    };
  }
  // The same refusal `validateAssessment` makes, for the same reason: a verdict
  // written as sections inside one string reaches the operator as a paragraph with
  // no seams, hours later. Here it is an error the same agent fixes in its turn.
  if (/[\r\n]/.test(summary)) {
    return {
      ok: false,
      error:
        'summary is one line — what you found, in a sentence. Everything with a line break in it is ' +
        'evidence: put it in `detail`, which takes markdown and is rendered as the body of the card an ' +
        'operator reads.',
    };
  }
  if (summary.length > MAX_SUMMARY) {
    return {
      ok: false,
      error:
        `summary is too long (${summary.length} chars, max ${MAX_SUMMARY}) — it is the headline, not the ` +
        `account. Keep the claim and move the rest to \`detail\`.`,
    };
  }
  const detail = typeof args.detail === 'string' ? args.detail.trim() : '';
  if (!detail) {
    return {
      ok: false,
      error:
        'detail is required. You are saying a ticket is already satisfied by a repository the person who ' +
        'filed it has read differently, so show your working: the files, the commits or the pull requests ' +
        'that already do what it asks, and what you checked to be sure nothing is missing. Without that ' +
        'nobody can tell your verdict from a planner that did not look. If you cannot point at anything, ' +
        'you are not sure — plan the work instead.',
    };
  }
  if (detail.length > MAX_DETAIL) {
    return { ok: false, error: `detail is too long (${detail.length} chars, max ${MAX_DETAIL}). Summarise it.` };
  }
  return { ok: true, summary, detail };
}

/**
 * Resolve a task's origin into the issue it may report already met — or say why it
 * may not.
 *
 * **Only a planner's own origin qualifies.** Every other agent that could reach for
 * this already has the verdict that is its own: the assessor's `delivered`, the
 * part agent's `conclude_part` determination, the working agent's `conclude_work`.
 * A second route to a delivery row from any of them would be a second answer to a
 * question that already has one, cast by an agent whose own tool records more than
 * this one can.
 *
 * Refusing beats silently narrowing, for the reason `conclusionOrigin` gives: an
 * agent handed `{ok: true}` would believe it had parked the issue.
 */
export function plannerOrigin(
  originRef: string | null,
): { ok: true; originRef: string; issueOrigin: string } | { ok: false; error: string } {
  const ref = originRef ?? '';
  const number = planOriginIssue(ref);
  if (number !== null) return { ok: true, originRef: ref, issueOrigin: `issue:${number}` };

  const part = /^issue:(\d+):part:/.exec(ref);
  if (part) {
    return {
      ok: false,
      error:
        `plan_not_needed is the planner's verdict on a whole issue, and you are working one part of issue ` +
        `#${part[1]}'s plan. If there is nothing to build in your part, close it with conclude_part and ` +
        `kind "determination" — the plan already speaks for the issue.`,
    };
  }
  const assessor = /^issue:(\d+):assess$/.exec(ref);
  if (assessor) {
    return {
      ok: false,
      error:
        `plan_not_needed is for a planner deciding there is nothing to build, and you were dispatched to ` +
        `assess whether issue #${assessor[1]} was delivered. Cast your verdict with assess_issue — ` +
        `"delivered" records the same park with your account of the work behind it.`,
    };
  }
  const appraiser = /^issue:(\d+):appraisal$/.exec(ref);
  if (appraiser) {
    return {
      ok: false,
      error:
        `plan_not_needed says a goal is already met, and you were dispatched to judge whether issue ` +
        `#${appraiser[1]}'s goal can be worked from at all. Cast your verdict with appraise_issue: a ticket ` +
        `that contradicts what is already true of the repository is "unclear", which is the reading that ` +
        `puts it in front of the person who filed it.`,
    };
  }
  const issue = /^issue:(\d+)$/.exec(ref);
  if (issue) {
    return {
      ok: false,
      error:
        `plan_not_needed is a planner's verdict, and you were dispatched to deliver issue #${issue[1]}. If ` +
        `you found there is nothing to do because it is already done, say so with conclude_work — status ` +
        `"done" and a note saying what you found.`,
    };
  }
  return {
    ok: false,
    error:
      `plan_not_needed is available to a planning agent, and this task's origin is ${ref || '(none)'}, ` +
      `which is not a planning origin.`,
  };
}
