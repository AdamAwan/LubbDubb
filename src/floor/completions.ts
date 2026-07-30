import type { Issue, IssueConclusion, IssueDelivery, Plan } from '../types.js';
import { issueConclusionOrigin } from '../issueConclusion.js';

/**
 * Deciding a goal is finished, for retention on the Goal Floor (issue #203).
 *
 * The signals are the same ones the floor already draws completion from, read
 * once here so the record and the picture cannot drift. A goal is complete when
 * any of them says so — its plan rolled up, the assessor parked it delivered, the
 * agent declared it done, or its run was written up:
 *
 * - **the run's write-up exists** — rule 3h writes one only after the work is
 *   over, and it is the report the operator wants to keep, so it is the surest
 *   "done, with something to read";
 * - **a `delivered` verdict** — the assessor's or the operator's park;
 * - **a `done` conclusion** — the working agent's or the operator's declaration;
 * - **a `complete` plan** — every part of a decomposition merged or concluded.
 *
 * `more_work` is deliberately not enough: a conclusion that says work remains is
 * not a finished goal, and the pickup gate will keep it in play. This reads the
 * *presence* of a delivery row rather than whether it still stands — retention is
 * a one-way record the operator ends, not a gate, so a delivery the world later
 * overtook has still been reached once and is worth keeping until dismissed.
 */
interface CompletionSignals {
  retrospectiveOrigins: readonly string[];
  conclusions: readonly IssueConclusion[];
  deliveries: readonly IssueDelivery[];
  plans: readonly Plan[];
}

export function isGoalComplete(issueNumber: number, signals: CompletionSignals): boolean {
  const origin = issueConclusionOrigin(issueNumber);
  if (signals.retrospectiveOrigins.includes(origin)) return true;
  if (signals.deliveries.some((d) => d.originRef === origin)) return true;
  if (signals.conclusions.some((c) => c.originRef === origin && c.verdict === 'done')) return true;
  if (signals.plans.some((p) => p.originRef === origin && p.status === 'complete')) return true;
  return false;
}

/**
 * The completions worth recording this pulse: one per live world issue the
 * signals say is finished. Recorded while the issue is still in the world so the
 * title survives the tracker forgetting it — the whole reason the row exists.
 */
export function completionsToRecord(
  issues: readonly Issue[],
  signals: CompletionSignals,
): { originRef: string; issueNumber: number; title: string }[] {
  return issues
    .filter((issue) => isGoalComplete(issue.number, signals))
    .map((issue) => ({
      originRef: issueConclusionOrigin(issue.number),
      issueNumber: issue.number,
      title: issue.title,
    }));
}
