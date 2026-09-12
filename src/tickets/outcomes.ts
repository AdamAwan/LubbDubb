import { issueOriginNumber } from '../issueOrigins.js';
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

// → docs/spec/13-jobs-and-tickets.md

type TicketOutcome = 'delivered' | 'fell short' | 'concluded' | 'abandoned';

interface OutcomeSignals {
  runs: readonly IssueRun[];
  conclusions: readonly IssueConclusion[];
  deliveries: readonly IssueDelivery[];
  shortfalls: readonly IssueShortfall[];
  plans: readonly Plan[];
  planParts: readonly PlanPart[];
}

export function ticketOutcomes(signals: OutcomeSignals): Map<number, TicketOutcome> {
  const byNumber = new Map<number, TicketOutcome>();
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

function wordFor(
  verdict: string,
  by: ConclusionAuthor | 'plan' | null,
  delivered: boolean,
  run: IssueRun | null,
): TicketOutcome | null {
  if (verdict === 'more_work') {
    if (by !== 'plan') return 'fell short';
  } else {
    if (delivered) return 'delivered';
    if (verdict === 'done') return 'concluded';
  }
  return run?.outcome === 'abandoned' ? 'abandoned' : null;
}

function issueNumberOf(originRef: string): number[] {
  const number = issueOriginNumber('root', originRef);
  return number === null ? [] : [number];
}
