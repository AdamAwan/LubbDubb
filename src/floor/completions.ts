import type { Issue, IssueConclusion, IssueDelivery, IssueShortfall, Plan } from '../types.js';
import { issueConclusionOrigin, resolveIssueConclusion } from '../issueConclusion.js';

/**
 * Deciding a goal is finished, for retention on the Goal Floor (issue #203).
 *
 * The signals are the same ones the floor already draws completion from, read
 * once here so the record and the picture cannot drift. A goal is complete when
 * any of them says so — its plan rolled up, the assessor parked it delivered, the
 * agent declared it done, or its run was written up:
 *
 * - **the run's write-up exists** — rule `issue-retro` writes one only after the work is
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
 *
 * ## Evidence adds; a standing verdict subtracts
 *
 * The conclusion and the plan are not read here as two more raw signals, and
 * reading them that way was a defect with two faces. An operator's `more_work`
 * toggle was argued with by a `complete` plan — the exact contradiction
 * {@link resolveIssueConclusion}'s first arm exists to forbid — and a standing
 * shortfall was not consulted at all, so the assessor's "nothing was delivered"
 * lost to the stale `done` of the agent it was assessing. Both are questions that
 * module already answers, so it is asked rather than re-answered here.
 *
 * That leaves two kinds of input and one rule between them. The retrospective and
 * the delivery are **evidence**: each says the goal was reached at least once, and
 * each is why the resolver alone is not enough (a finished goal nobody declared
 * resolves to `undeclared`). A resolved `more_work` is a **standing verdict** —
 * the operator, the assessor, the working agent, or a plan the harness is actively
 * re-drawing — and it is the one thing that outranks the evidence, because every
 * one of those parties is saying, now, that work remains.
 *
 * The gate is on **minting a completion, never on keeping one.** Nothing here
 * deletes a row, `Store.recordFloorCompletion` is upsert-only and never
 * resurrects a dismissal, and a genuinely finished goal resolves to `done` or
 * `undeclared` — never `more_work` — so it cannot fall off the floor on its own.
 * What no longer happens is the harness recording that a goal is finished on the
 * same pulse its own scheduler is putting agents on it.
 */
interface CompletionSignals {
  retrospectiveOrigins: readonly string[];
  conclusions: readonly IssueConclusion[];
  deliveries: readonly IssueDelivery[];
  shortfalls: readonly IssueShortfall[];
  plans: readonly Plan[];
}

export function isGoalComplete(issueNumber: number, signals: CompletionSignals): boolean {
  const origin = issueConclusionOrigin(issueNumber);
  const resolved = resolveIssueConclusion(
    signals.conclusions.find((c) => c.originRef === origin) ?? null,
    signals.plans.find((p) => p.originRef === origin) ?? null,
    signals.shortfalls.find((s) => s.originRef === origin) ?? null,
  );
  if (resolved.verdict === 'more_work') return false;
  if (signals.retrospectiveOrigins.includes(origin)) return true;
  if (signals.deliveries.some((d) => d.originRef === origin)) return true;
  return resolved.verdict === 'done';
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
