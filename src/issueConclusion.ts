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
 * Left unresolved, that ambiguity had a concrete cost. Rule 3b's inverse arm
 * moved a reviewed item back to a pickup state whenever no PR was open for it —
 * and `openPrForIssue` reads only the *open* list, so "the PR merged" and "there
 * was never a PR" are one observation. A merged PR therefore bounced its ticket
 * back to `Ready`, and rule 4 put a fresh agent on work already sitting on the
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
 * bug and make the fix contingent on model diligence. Rule 3b acts only on an
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
 * 3. **The agent's declaration**, from `conclude_work`.
 * 4. **The plan derivation**: `complete` → done, an in-flight plan → more work.
 *    This is what keeps a decomposed issue behaving exactly as it does today
 *    without rule 3b needing a separate `decomposed` branch.
 * 5. Otherwise undeclared.
 *
 * Arms 2 and 3 being separate is the fix for a bug that predates the feature: the
 * assessor used to write `more_work` into `issue_conclusions`, which is keyed
 * `origin_ref PRIMARY KEY` and is the row `conclude_work` writes — so an
 * assessment **overwrote the working agent's own declaration**, its note, its
 * author and its timestamp, and the resolver read `by: 'assessor'` and
 * `by: 'agent'` through one arm with no precedence between them. Two records, one
 * resolver, and rule 3b needs no new branch.
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
  if (stored) {
    return { verdict: stored.verdict, by: stored.by, note: stored.note, at: stored.updatedAt };
  }
  const derived = planDerivedVerdict(plan);
  if (derived) return derived;
  return UNDECLARED;
}

/**
 * The plan roll-up read as a conclusion.
 *
 * `single` is deliberately **not** derived from: a `single` verdict says the issue
 * is delivered as one PR, which is a statement about *shape*, not about whether
 * that PR has been written. Treating it as `more_work` would be harmless but
 * dishonest, and treating it as `done` would be catastrophic — so a `single` plan
 * leaves the issue exactly where an unplanned one sits, waiting on its agent to
 * declare. `planning`/`abandoned` say nothing about completeness either.
 */
function planDerivedVerdict(plan: Plan | null): ResolvedConclusion | null {
  if (!plan) return null;
  if (plan.status === 'complete') {
    return { verdict: 'done', by: 'plan', note: 'every part of the plan merged', at: null };
  }
  if (plan.status === 'active' || plan.status === 'awaiting_approval') {
    return { verdict: 'more_work', by: 'plan', note: 'the plan still has parts in flight', at: null };
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
