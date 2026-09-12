import type {
  Issue,
  IssueConclusion,
  IssueDelivery,
  IssueRun,
  IssueShortfall,
  Plan,
  PlanPart,
  TaskSummary,
} from '../types.js';
import { issueConclusionOrigin, resolveIssueConclusion } from '../issueConclusion.js';
import { hasPriorWork } from '../delivery/assessment.js';

// → docs/spec/22-pets.md

export interface CompletionSignals {
  retrospectiveOrigins: readonly string[];
  conclusions: readonly IssueConclusion[];
  deliveries: readonly IssueDelivery[];
  shortfalls: readonly IssueShortfall[];
  plans: readonly Plan[];
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

interface RunRecord {
  originRef: string;
  issueNumber: number;
  title: string;
  body: string;
  labels: string[];
  linkedPrNumber: number | null;
  workItemState: string | null;
  complete: boolean;
}

export function runsToRecord(issues: readonly Issue[], tasks: TaskSummary[], signals: CompletionSignals): RunRecord[] {
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
