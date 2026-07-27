import type { Job, Plan, PlanPart, Task, WorkNode, WorkNodeObservation, WorldSnapshot } from '../types.js';
import { planIssueNumber, partOrigin } from '../plans/parts.js';
import { issueOrigin, planOrigin } from '../plans/planning.js';

/**
 * Everything the fold reads: this pulse's world, the store rows that hold intent,
 * and the graph as it already stands. `existing` is what lets the fold apply
 * "observed beats inferred" without the store needing an opinion about it.
 */
export interface WorkGraphInput {
  world: WorldSnapshot;
  tasks: Task[];
  plans: Plan[];
  parts: PlanPart[];
  jobs: Job[];
  existing: WorkNode[];
}

/**
 * Turn this pulse into node observations.
 *
 * Pure over its input, and **emits only what it observed** — a node absent from the
 * result is not deleted, it is left alone by `Store.recordWorkGraph`. That is the
 * property the record exists for: `closedPullRequests` remembers a merge for
 * `closedPrWindowMs` and then forgets, and the graph must not.
 *
 * Every edge here is already computed somewhere in the pulse (`observePartPr`,
 * `openPrForIssue`, `basePrOf`); this is where they stop being thrown away.
 */
export function foldWorkGraph(input: WorkGraphInput): WorkNodeObservation[] {
  const out: WorkNodeObservation[] = [];

  for (const issue of input.world.issues) {
    const closed = issue.state === 'closed';
    out.push({
      ref: issueOrigin(issue.number),
      kind: 'issue',
      parentRef: null,
      title: issue.title,
      // The tracker's own word, kept raw when it has a richer model than open/closed
      // — the harness reads completion here and never computes it.
      status: closed ? 'closed' : (issue.workItemState ?? 'open'),
      terminal: closed,
    });
  }

  const issueOfPlan = new Map<string, number>();
  for (const plan of input.plans) {
    const n = planIssueNumber(plan.originRef);
    if (n === null) continue;
    issueOfPlan.set(plan.id, n);
    out.push({
      ref: planOrigin(n),
      kind: 'plan',
      parentRef: issueOrigin(n),
      title: plan.title,
      status: plan.status,
      terminal: plan.status === 'complete' || plan.status === 'abandoned',
    });
  }

  for (const part of input.parts) {
    const n = issueOfPlan.get(part.planId);
    if (n === undefined) continue; // a part whose plan names no issue schedules nothing
    out.push({
      ref: partOrigin(n, part.slug),
      kind: 'part',
      parentRef: issueOrigin(n),
      title: part.title,
      status: part.status,
      // Retired is terminal in the same way merged is: the row stays so the graph
      // remains readable after a replan, and nothing schedules it again.
      terminal: part.status === 'merged' || part.status === 'retired',
    });
  }

  return out;
}
