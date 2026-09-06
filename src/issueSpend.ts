import type { Agent, IssueSpend, LocalRun, TaskSummary, WorkNode } from './types.js';
import { issueOrigin } from './plans/planning.js';

// → docs/spec/18-observability.md

interface SpendInput {
  agents: readonly Agent[];
  tasks: readonly TaskSummary[];
  nodes: readonly WorkNode[];
  localRuns: readonly LocalRun[];
}

interface SpendRollup {
  byIssue: Map<string, IssueSpend>;
  unattributedCostUsd: number;
  localRunAttribution: Map<string, number | null>;
  attribution: Map<string, number | null>;
}

const ISSUE_SUBTREE = /^issue:(\d+)(?::|$)/;

const PR_NODE = /^(pr:\d+)(?::|$)/;

export function prNodeRefOf(originRef: string): string | null {
  return PR_NODE.exec(originRef)?.[1] ?? null;
}

const MAX_HOPS = 12;

export function rollUpIssueSpend(input: SpendInput): SpendRollup {
  const originOfTask = new Map(input.tasks.map((t) => [t.id, t.originRef]));
  const parentOf = new Map(input.nodes.map((n) => [n.ref, n.parentRef]));
  const byIssue = new Map<string, IssueSpend>();
  const attribution = new Map<string, number | null>();
  const localRunAttribution = new Map<string, number | null>();
  let unattributedCostUsd = 0;

  const rowFor = (issueNumber: number): IssueSpend => {
    const ref = issueOrigin(issueNumber);
    const spend = byIssue.get(ref) ?? {
      originRef: ref,
      issueNumber,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      agents: 0,
      localRuns: 0,
    };
    byIssue.set(ref, spend);
    return spend;
  };

  for (const agent of input.agents) {
    if (unmeasured(agent)) continue;
    const cost = agent.costUsd ?? 0;
    const issueNumber = issueBehind(originOfTask.get(agent.taskId) ?? null, parentOf);
    attribution.set(agent.id, issueNumber);
    if (issueNumber === null) {
      unattributedCostUsd = roundUsd(unattributedCostUsd + cost);
      continue;
    }
    const spend = rowFor(issueNumber);
    spend.costUsd = roundUsd(spend.costUsd + cost);
    spend.inputTokens += agent.inputTokens ?? 0;
    spend.outputTokens += agent.outputTokens ?? 0;
    spend.agents += 1;
  }

  for (const run of input.localRuns) {
    if (unmeasured(run)) continue;
    const issueNumber = issueBehind(run.originRef, parentOf);
    localRunAttribution.set(run.id, issueNumber);
    if (issueNumber === null) {
      unattributedCostUsd = roundUsd(unattributedCostUsd + (run.costUsd ?? 0));
      continue;
    }
    const spend = rowFor(issueNumber);
    spend.costUsd = roundUsd(spend.costUsd + (run.costUsd ?? 0));
    spend.inputTokens += run.inputTokens ?? 0;
    spend.outputTokens += run.outputTokens ?? 0;
    spend.localRuns += 1;
  }
  return { byIssue, unattributedCostUsd, attribution, localRunAttribution };
}

export function issueBehind(originRef: string | null, parentOf: ReadonlyMap<string, string | null>): number | null {
  let ref = originRef === null ? null : (prNodeRefOf(originRef) ?? originRef);
  for (let hop = 0; ref !== null && hop < MAX_HOPS; hop++) {
    const named = ISSUE_SUBTREE.exec(ref);
    if (named) return Number(named[1]);
    ref = parentOf.get(ref) ?? null;
  }
  return null;
}

export function roundUsd(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function unmeasured(run: {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}): boolean {
  return run.costUsd === null && run.inputTokens === null && run.outputTokens === null;
}
