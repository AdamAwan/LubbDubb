import type {
  Issue,
  IssueConclusion,
  IssueDelivery,
  IssueRun,
  IssueShortfall,
  Plan,
  PlanPart,
  Task,
} from '../types.js';
import { issueConclusionOrigin, resolveIssueConclusion } from '../issueConclusion.js';
import { hasPriorWork } from '../delivery/assessment.js';

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
 * The gate is on **stamping a completion, never on keeping one.** Nothing here
 * deletes a row, `Store.recordIssueRun` never clears a completion instant or
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
  /** The plans' parts — a plan's shape, which the conclusion resolver reads. */
  planParts: readonly PlanPart[];
}

export function isGoalComplete(issueNumber: number, signals: CompletionSignals): boolean {
  const origin = issueConclusionOrigin(issueNumber);
  const plan = signals.plans.find((p) => p.originRef === origin) ?? null;
  const resolved = resolveIssueConclusion(
    signals.conclusions.find((c) => c.originRef === origin) ?? null,
    plan,
    plan ? signals.planParts.filter((p) => p.planId === plan.id) : [],
    signals.shortfalls.find((s) => s.originRef === origin) ?? null,
  );
  if (resolved.verdict === 'more_work') return false;
  if (signals.retrospectiveOrigins.includes(origin)) return true;
  if (signals.deliveries.some((d) => d.originRef === origin)) return true;
  return resolved.verdict === 'done';
}

/** One live issue's run record, as this pulse would write it. */
interface RunRecord {
  originRef: string;
  issueNumber: number;
  title: string;
  body: string;
  labels: string[];
  linkedPrNumber: number | null;
  workItemState: string | null;
  /** Whether the signals say the goal is finished *now* — see {@link isGoalComplete}. */
  complete: boolean;
}

/**
 * The runs worth recording this pulse: one per live world issue the harness has
 * either **worked** or **finished** (issue #234).
 *
 * Minted at pickup rather than at completion, which is the change #203's shape
 * could not make. A record written only for a finished goal is never written for
 * an abandoned one — so the goal whose ticket someone closed mid-flight left the
 * floor with nothing to dismiss, and left the dispatcher with no subject at all.
 * `hasPriorWork` is the pickup signal, and it is the same predicate `issue-assess`
 * uses to tell "nothing has started" from "something finished", so the run and the
 * assessment agree on when a goal entered production.
 *
 * The second arm keeps #203's behaviour exactly: a goal the operator declared
 * done without the harness ever staffing it is still a finished goal worth
 * retaining. Everything is captured while the issue is live, because a retained
 * run is *dispatched from* once the tracker forgets the issue — see {@link IssueRun}.
 */
export function runsToRecord(issues: readonly Issue[], tasks: Task[], signals: CompletionSignals): RunRecord[] {
  const records: RunRecord[] = [];
  for (const issue of issues) {
    const complete = isGoalComplete(issue.number, signals);
    if (!complete && !hasPriorWork(issue.number, tasks)) continue;
    records.push({
      originRef: issueConclusionOrigin(issue.number),
      issueNumber: issue.number,
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
      linkedPrNumber: issue.linkedPrNumber,
      workItemState: issue.workItemState ?? null,
      complete,
    });
  }
  return records;
}

/**
 * The runs the tracker no longer returns, as issues again (issue #234).
 *
 * This is what the dispatcher's issue list is unioned with, and what the cockpit
 * draws a forgotten goal's card from — one function, so the harness and
 * `/api/state` cannot hold different opinions about which runs are still live.
 * Two things take a run out of it and only two: the operator's dismissal, which
 * is terminal, and the issue coming back into the world, where it is the live
 * issue rather than this stub that everything reads.
 *
 * `state: 'closed'` is not a guess: an issue absent from a tracker's open list is
 * closed or untagged, and every rule that must not act on a retained run is gated
 * on the run itself, never on this field. The rest is the snapshot the row kept —
 * so a retained run carries the body its assessor's prompt needs and the labels
 * its watch gate reads, which a `body: ''` stub did not.
 */
export function retainedRunIssues(runs: readonly IssueRun[], live: readonly Issue[]): Issue[] {
  const present = new Set(live.map((i) => i.number));
  return runs
    .filter((r) => r.dismissedAt === null && !present.has(r.issueNumber))
    .map((r) => ({
      id: `issue-${r.issueNumber}`,
      number: r.issueNumber,
      title: r.title,
      body: r.body,
      labels: r.labels,
      state: 'closed' as const,
      linkedPrNumber: r.linkedPrNumber,
      ...(r.workItemState !== null ? { workItemState: r.workItemState } : {}),
    }));
}
