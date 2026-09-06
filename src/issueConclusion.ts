import type {
  ConclusionAuthor,
  IssueConclusion,
  IssueConclusionVerdict,
  IssueShortfall,
  Plan,
  PlanPart,
} from './types.js';
import { planInFlight } from './plans/parts.js';

/**
 * Whether an issue is finished — one resolved verdict, from the standing declaration and
 * the plan graph. The verdict is asked of whoever owns the *whole* issue: a plan derives
 * it from its roll-up, a single agent declares it through `conclude_work`, and a part
 * agent is refused by {@link conclusionOrigin}. `undeclared` is never stored and is never
 * folded into `more_work` — silence is a third answer, and only an explicit `more_work`
 * moves an item back to pickup. → `docs/spec/06-issue-pickup.md`
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
 * Precedence, first match wins: operator toggle, standing shortfall, plan in flight,
 * the agent's declaration, a `complete` plan, otherwise undeclared. Shortfall and
 * declaration are separate records deliberately — one row for both let an assessment
 * overwrite the working agent's declaration. Pure over its arguments, so the dispatcher,
 * cockpit and tool layer all get one answer. → `docs/spec/06-issue-pickup.md`
 */
export function resolveIssueConclusion(
  stored: IssueConclusion | null,
  plan: Plan | null,
  /**
   * The plan's parts — its shape, which the status no longer carries. Required rather
   * than defaulted, because either default is the wrong answer for some plan.
   */
  planParts: readonly PlanPart[],
  shortfall: IssueShortfall | null = null,
): ResolvedConclusion {
  // The operator's toggle may contradict an assessment, so it is asked before the
  // shortfall rather than with the other stored verdicts.
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
  // Above the stored declaration: a plan in flight has taken the issue back, so an
  // earlier declaration is about a superseded delivery attempt.
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
 * A plan that still owns its issue, read as a conclusion. While a plan is in flight the
 * plan speaks, above any stored declaration — a replan takes the issue back, so an
 * earlier `done` must not outrank it. `complete` and `abandoned` are the only statuses
 * not in flight. → `docs/spec/06-issue-pickup.md`
 */
function planInFlightVerdict(plan: Plan | null): ResolvedConclusion | null {
  if (!plan) return null;
  if (planInFlight(plan)) {
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
 * Resolve a task's origin into the issue it may conclude — or say why it may not. Only a
 * whole-issue origin qualifies; the per-case refusals point each caller at the tool it
 * should have used. Never silently narrow: an `ok` here means the issue was concluded.
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
        `needed), raise it.`,
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
  const appraiser = /^issue:(\d+):appraisal$/.exec(ref);
  if (appraiser) {
    return {
      ok: false,
      error:
        `conclude_work is for an agent that did the work, and you were dispatched to judge whether issue ` +
        `#${appraiser[1]}'s goal can be worked from at all — before anything was started. Cast your verdict ` +
        `with appraise_issue instead.`,
    };
  }
  return {
    ok: false,
    error:
      `conclude_work says whether an issue is finished, and this task's origin is ${ref || '(none)'}, ` +
      `which is not an issue. Only the agent dispatched for an issue itself concludes it.`,
  };
}
