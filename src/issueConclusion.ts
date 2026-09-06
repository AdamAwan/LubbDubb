import type {
  ConclusionAuthor,
  IssueConclusion,
  IssueConclusionVerdict,
  IssueShortfall,
  Plan,
  PlanPart,
} from './types.js';
import { planInFlight } from './plans/parts.js';

// → docs/spec/06-issue-pickup.md#concluding-an-issue

type ResolvedVerdict = IssueConclusionVerdict | 'undeclared';

interface ResolvedConclusion {
  verdict: ResolvedVerdict;
  by: ConclusionAuthor | 'plan' | null;
  note: string;
  at: string | null;
}

const UNDECLARED: ResolvedConclusion = { verdict: 'undeclared', by: null, note: '', at: null };

export function resolveIssueConclusion(
  stored: IssueConclusion | null,
  plan: Plan | null,
  planParts: readonly PlanPart[],
  shortfall: IssueShortfall | null = null,
): ResolvedConclusion {
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

export function issueConclusionOrigin(issueNumber: number): string {
  return `issue:${issueNumber}`;
}

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
