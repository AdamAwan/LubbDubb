import type { ConclusionAuthor, IssueConclusion, IssueConclusionVerdict, IssueShortfall, Plan } from './types.js';

/**
 * Whether an issue is finished — one resolved verdict, from the standing
 * declaration and the plan graph.
 *
 * ## The gap this closes
 *
 * A work item parked in a review state is ambiguous in a way no provider field
 * resolves: it sits there when work remains, **and** when everything has been
 * delivered and it is waiting on test. Nothing outside the harness distinguishes
 * the two, and the only party that knows is the agent that did the work.
 *
 * Left unresolved, that ambiguity had a concrete cost. Rule `work-item-back-to-pickup`
 * moved a reviewed item back to a pickup state whenever no PR was open for it —
 * and `openPrForIssue` reads only the *open* list, so "the PR merged" and "there
 * was never a PR" are one observation. A merged PR therefore bounced its ticket
 * back to `Ready`, and rule `issue-pickup` put a fresh agent on work already sitting on the
 * default branch.
 *
 * ## Asked of whoever owns the whole issue
 *
 * The decomposed path already answered this, and this module generalises what it
 * does rather than adding a parallel notion. A plan's roll-up **derives** the
 * verdict — every live part merged means the issue is finished — which is why
 * `partsPlanFor` treats a `complete` plan as still owning its issue and why
 * `planComment` tells the operator that closing it is theirs to do.
 *
 * So the rule is: the verdict is asked of whoever owns the whole issue. When a
 * plan owns it, the roll-up derives it. When one agent owns it, that agent
 * declares it through `conclude_work`. A part agent is never asked — its scope is
 * a part, and the roll-up already speaks for the issue. That is what makes "done"
 * mean *the issue is finished* rather than *my slice is finished*, and
 * {@link conclusionOrigin} enforces it structurally rather than by asking agents
 * to be careful.
 *
 * ## Silence is a third answer
 *
 * {@link ResolvedConclusion.verdict} has an `undeclared` member that is never
 * stored: it is what a missing row resolves to. Keeping it distinct from
 * `more_work` is the entire fix. Folding the two would restore today's behaviour
 * for every agent that forgets to declare — which is to say it would preserve the
 * bug and make the fix contingent on model diligence. Rule `work-item-back-to-pickup` acts only on an
 * explicit `more_work`, so an undeclared item stays parked and the cockpit says
 * that nobody vouched for it.
 */

/** The verdict as resolved, including the value that is never persisted. */
type ResolvedVerdict = IssueConclusionVerdict | 'undeclared';

interface ResolvedConclusion {
  verdict: ResolvedVerdict;
  /**
   * Where the verdict came from. `plan` is the derivation off the roll-up; the
   * other two are a stored row's author. Null when undeclared.
   */
  by: ConclusionAuthor | 'plan' | null;
  /** The declared note, or the derivation's own words. Empty when undeclared. */
  note: string;
  /** When it was declared. Null for a derived or undeclared verdict. */
  at: string | null;
}

const UNDECLARED: ResolvedConclusion = { verdict: 'undeclared', by: null, note: '', at: null };

/**
 * Fold an issue's stored declaration, its shortfall and its plan into one verdict.
 *
 * Precedence, first match wins:
 *
 * 1. **The operator's toggle.** Always wins, on any item — it is the escape hatch,
 *    and the only thing that can contradict a plan roll-up *or* an assessment. An
 *    operator looking at a complete plan and saying "there is more to do here"
 *    must not be argued with by a derivation.
 * 2. **A standing shortfall** — the assessor's "worked, and the goal is not
 *    reached" (issue #159). It outranks the working agent's own declaration
 *    because the assessor is later and better informed than the agent that
 *    declared its own run, which is the sentence already in
 *    `Store.recordDelivery`'s doc comment, applied consistently.
 * 3. **A plan in flight** — `planning`, `active` or `awaiting_approval` — reads as
 *    more work, *above* the stored declaration rather than below it. See
 *    {@link planInFlightVerdict} for why that order is the one this module's own
 *    doctrine asks for.
 * 4. **The agent's declaration**, from `conclude_work`.
 * 5. **A `complete` plan** → done. Below the declaration, because an agent saying
 *    work remains on an issue whose parts all merged is telling the roll-up
 *    something it cannot see, and `more_work` is the safe direction besides.
 * 6. Otherwise undeclared.
 *
 * Arms 2 and 3 being separate is the fix for a bug that predates the feature: the
 * assessor used to write `more_work` into `issue_conclusions`, which is keyed
 * `origin_ref PRIMARY KEY` and is the row `conclude_work` writes — so an
 * assessment **overwrote the working agent's own declaration**, its note, its
 * author and its timestamp, and the resolver read `by: 'assessor'` and
 * `by: 'agent'` through one arm with no precedence between them. Two records, one
 * resolver, and rule `work-item-back-to-pickup` needs no new branch.
 *
 * Pure over its arguments — no store, no world — so the one question the
 * dispatcher, the cockpit chip and the tool layer all ask has exactly one answer.
 */
export function resolveIssueConclusion(
  stored: IssueConclusion | null,
  plan: Plan | null,
  shortfall: IssueShortfall | null = null,
): ResolvedConclusion {
  // The operator's toggle is the only thing that may contradict an assessment, so
  // it is asked before the shortfall rather than with the other stored verdicts.
  if (stored?.by === 'operator') {
    return { verdict: stored.verdict, by: stored.by, note: stored.note, at: stored.updatedAt };
  }
  if (shortfall) {
    return {
      verdict: 'more_work',
      by: shortfall.by === 'operator' ? 'operator' : 'assessor',
      note: shortfall.summary,
      at: shortfall.updatedAt,
    };
  }
  // Above the stored declaration, not below it: a plan in flight has taken the
  // issue back, and a declaration made before it did is about a delivery attempt
  // the harness has since superseded.
  const inFlight = planInFlightVerdict(plan);
  if (inFlight) return inFlight;
  if (stored) {
    return { verdict: stored.verdict, by: stored.by, note: stored.note, at: stored.updatedAt };
  }
  if (plan?.status === 'complete') {
    return { verdict: 'done', by: 'plan', note: 'every part of the plan merged', at: null };
  }
  return UNDECLARED;
}

/**
 * A plan that still owns its issue, read as a conclusion.
 *
 * ## Why this outranks a stored declaration
 *
 * The doctrine above — *the verdict is asked of whoever owns the whole issue* —
 * was enforced by making the two arms unreachable together: a part agent, a
 * planner and an assessor are all refused by {@link conclusionOrigin}, so on a
 * decomposed issue nothing could write a declaration at all. The arm order below
 * it therefore never had to decide anything, and encoded an assumption instead of
 * a rule.
 *
 * A **replan breaks that assumption**, and it is the one path that does. An issue
 * worked `single` has one agent, that agent declares through `conclude_work`, and
 * then an accepted shortfall hands the issue to a plan (`shortfallArm`'s arm A
 * flips it to `planning`). Now both exist — and with the declaration ranked first,
 * a spent `done` outranked the plan that had just taken the issue back, which is
 * ownership read exactly backwards. The observed cost was a goal shown finished on
 * the Goal Floor while its only PR sat open and its plan sat in `planning`.
 *
 * So the rule the doctrine always stated is applied rather than assumed: while a
 * plan is in flight, the plan speaks.
 *
 * ## Why `planning` is in flight
 *
 * It reads as `more_work` here where it used to say nothing, and the two ways to
 * reach it are both unsettled decompositions: a plan awaiting its planner's
 * verdict, and a replan. Nobody re-plans a finished goal — and an operator who
 * did by mistake has arm 1, which outranks every derivation. A discussion is the
 * same status (`isPlanInDiscussion`) and 409s unless the plan was
 * `awaiting_approval`, so it is in flight on arrival and stays so.
 *
 * `single` is deliberately **not** derived from: it says the issue is delivered as
 * one PR, which is a statement about *shape*, not about whether that PR has been
 * written. Treating it as `more_work` would be harmless but dishonest, and
 * treating it as `done` would be catastrophic — so a `single` plan leaves the
 * issue exactly where an unplanned one sits, waiting on its agent to declare.
 * `abandoned` says nothing about completeness either.
 */
function planInFlightVerdict(plan: Plan | null): ResolvedConclusion | null {
  if (!plan) return null;
  if (plan.status === 'planning' || plan.status === 'active' || plan.status === 'awaiting_approval') {
    return {
      verdict: 'more_work',
      by: 'plan',
      note: plan.status === 'planning' ? 'the plan is being drawn up' : 'the plan still has parts in flight',
      at: null,
    };
  }
  return null;
}

/** How an issue number becomes the key a conclusion is stored under. */
export function issueConclusionOrigin(issueNumber: number): string {
  return `issue:${issueNumber}`;
}

/**
 * Resolve a task's origin into the issue it may conclude — or say why it may not.
 *
 * **Only a whole-issue origin qualifies.** This is the structural half of "done
 * means the issue is finished, not my bit of it": rather than asking a part agent
 * to scope its verdict correctly, it simply has no verdict to cast. The refusals
 * are separated by case because they mean genuinely different things to the caller
 * — a part agent is being told the plan already speaks for the issue, while a PR
 * or job agent is being told it is on the wrong kind of task entirely.
 *
 * Refusing beats silently narrowing: an agent that called this and got back
 * `{ok: true}` would reasonably believe it had concluded the issue.
 */
export function conclusionOrigin(
  originRef: string | null,
): { ok: true; originRef: string } | { ok: false; error: string } {
  const ref = originRef ?? '';
  const match = /^issue:(\d+)$/.exec(ref);
  if (match) return { ok: true, originRef: ref };

  const part = /^issue:(\d+):part:/.exec(ref);
  if (part) {
    return {
      ok: false,
      error:
        `conclude_work is for the whole issue, and you are working one part of issue #${part[1]}'s plan. ` +
        `The harness concludes a decomposed issue from its plan — when every part has finished, the issue ` +
        `is done, and no part agent has to say so. Finish your part: open its pull request, or if it ` +
        `finished without one (it was a write-up, or you found nothing needs building) close it with ` +
        `conclude_part. If you believe the *plan* is wrong (a part is missing, or one is no longer ` +
        `needed), use report_finding.`,
    };
  }
  const planner = /^issue:(\d+):plan$/.exec(ref);
  if (planner) {
    return {
      ok: false,
      error:
        `conclude_work is for an agent that did the work, and you are planning issue #${planner[1]}, ` +
        `not delivering it. Submit your decomposition with plan_submit instead.`,
    };
  }
  const assessor = /^issue:(\d+):assess$/.exec(ref);
  if (assessor) {
    return {
      ok: false,
      error:
        `conclude_work is for an agent that did the work, and you were dispatched to *assess* issue ` +
        `#${assessor[1]} rather than to deliver it. Cast your verdict with assess_issue instead — it ` +
        `carries the extra answer yours needs ("delivered"), which parks the issue without claiming an ` +
        `agent finished a turn on it.`,
    };
  }
  const assayer = /^issue:(\d+):assay$/.exec(ref);
  if (assayer) {
    return {
      ok: false,
      error:
        `conclude_work is for an agent that did the work, and you were dispatched to judge whether issue ` +
        `#${assayer[1]}'s goal can be worked from at all — before anything was started. Cast your verdict ` +
        `with assay_issue instead.`,
    };
  }
  return {
    ok: false,
    error:
      `conclude_work says whether an issue is finished, and this task's origin is ${ref || '(none)'}, ` +
      `which is not an issue. Only the agent dispatched for an issue itself concludes it.`,
  };
}
