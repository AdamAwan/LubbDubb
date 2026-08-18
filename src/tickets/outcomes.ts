import { issueConclusionOrigin, resolveIssueConclusion } from '../issueConclusion.js';
import type {
  ConclusionAuthor,
  IssueDelivery,
  IssueRun,
  IssueShortfall,
  IssueConclusion,
  Plan,
  PlanPart,
} from '../types.js';

/**
 * The harness's own word for how it left a goal, for the Tickets tab's row
 * (issue #329).
 *
 * Four words, folded **on the server** from the verdicts that already exist rather
 * than shipped as four nullable objects for the browser to prioritise. Precedence
 * is a rule, and a second implementation of it drawn in a component is a second
 * opinion about it — the argument `ciVerdict` already makes.
 *
 * The precedence itself is not invented here either: which of a conclusion, a
 * delivery and a shortfall stands is {@link resolveIssueConclusion}'s answer, and
 * this only names the result. What it adds is the one reading that module has no
 * view on — a run the operator ended without the harness ever judging it finished,
 * which the run row already stamps `abandoned`.
 *
 * Null for a ticket the fleet never reached a verdict on, which is most of them:
 * the mirror holds every assigned item, and the great majority have never been
 * worked at all. Null too while a plan is **in flight** — see {@link wordFor}: the
 * resolver reads that as `more_work`, and it is the harness still working the goal
 * rather than anything having judged it.
 */
type TicketOutcome = 'delivered' | 'fell short' | 'concluded' | 'abandoned';

interface OutcomeSignals {
  runs: readonly IssueRun[];
  conclusions: readonly IssueConclusion[];
  deliveries: readonly IssueDelivery[];
  shortfalls: readonly IssueShortfall[];
  plans: readonly Plan[];
  planParts: readonly PlanPart[];
}

/** One outcome word per issue number that has one. Absent = no verdict was ever reached. */
export function ticketOutcomes(signals: OutcomeSignals): Map<number, TicketOutcome> {
  const byNumber = new Map<number, TicketOutcome>();
  // Every number any verdict touches — the union rather than the run list, because
  // an operator can declare a goal done the harness never staffed and never minted
  // a run for.
  const numbers = new Set<number>([
    ...signals.runs.map((r) => r.issueNumber),
    ...[...signals.conclusions, ...signals.deliveries, ...signals.shortfalls].flatMap((v) =>
      issueNumberOf(v.originRef),
    ),
  ]);

  for (const number of numbers) {
    const origin = issueConclusionOrigin(number);
    const plan = signals.plans.find((p) => p.originRef === origin) ?? null;
    const resolved = resolveIssueConclusion(
      signals.conclusions.find((c) => c.originRef === origin) ?? null,
      plan,
      plan ? signals.planParts.filter((p) => p.planId === plan.id) : [],
      signals.shortfalls.find((s) => s.originRef === origin) ?? null,
    );
    const outcome = wordFor(
      resolved.verdict,
      resolved.by,
      signals.deliveries.some((d) => d.originRef === origin),
      signals.runs.find((r) => r.issueNumber === number) ?? null,
    );
    if (outcome) byNumber.set(number, outcome);
  }
  return byNumber;
}

/**
 * The word, given the standing verdict, who it came from, whether a delivery was
 * ever parked, and the run row.
 *
 * A standing `more_work` outranks the delivery, which is the whole reason the
 * resolver is asked rather than the rows read directly: an assessor's shortfall
 * *deletes* the delivery row for that origin, so a later re-judgement is visible
 * here as "fell short" rather than as a goal that silently stops being delivered.
 * A delivery with no contradiction is `delivered`; a `done` conclusion with no
 * delivery behind it is the agent's own word, so `concluded`.
 *
 * ## Why `by` is read and not just the verdict
 *
 * `more_work` is two statements wearing one word, and only one of them is an
 * outcome. `by: 'plan'` is {@link resolveIssueConclusion}'s *derivation* — a plan
 * `planning`, `awaiting_approval` or `active`, which says the harness is still
 * working the goal and nothing has judged anything. Every other author has
 * actually said it: an assessor's shortfall, the operator's toggle, or the working
 * agent's own `conclude_work`.
 *
 * Folding the derivation in put "fell short" on every goal with a plan in flight —
 * which on a running fleet is most of the ones being worked, so the chip appeared
 * in bulk and told an operator that work in progress had failed. An in-flight plan
 * yields **no word at all**, the same as a ticket nobody has judged: the row
 * already says where the goal is from its state and the dispatcher's own pickup
 * reasons, and this column is for how the harness *left* a goal.
 */
function wordFor(
  verdict: string,
  by: ConclusionAuthor | 'plan' | null,
  delivered: boolean,
  run: IssueRun | null,
): TicketOutcome | null {
  if (verdict === 'more_work') {
    if (by !== 'plan') return 'fell short';
    // A plan in flight, so nothing below applies either: the delivery and the
    // `done` are what the resolver has already ranked *under* it.
  } else {
    if (delivered) return 'delivered';
    if (verdict === 'done') return 'concluded';
  }
  // Nothing judged it finished, and the operator ended the run anyway. The run row
  // has already decided this word at dismissal, off `completed_at` — read, not
  // re-derived, so the floor and this list cannot disagree about what was abandoned.
  return run?.outcome === 'abandoned' ? 'abandoned' : null;
}

/** `issue:14` → `[14]`; anything else → `[]`, so a `pr:` origin never invents a ticket. */
function issueNumberOf(originRef: string): number[] {
  const match = /^issue:(\d+)$/.exec(originRef);
  return match ? [Number(match[1])] : [];
}
