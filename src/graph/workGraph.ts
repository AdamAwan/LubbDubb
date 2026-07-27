import type { Job, Plan, PlanPart, Task, WorkNode, WorkNodeObservation, WorldSnapshot } from '../types.js';
import { planIssueNumber, partOrigin } from '../plans/parts.js';
import { issueOrigin, planOrigin } from '../plans/planning.js';
import { basePrOf, prState } from '../prHealth.js';
import { issueBranch } from '../dispatcher/issuePickup.js';

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

  // Which node owns each PR. Filled part-first because work lineage is what the
  // parent means: a part's PR belongs to the part, not to the issue two levels up.
  const prParent = new Map<number, string>();
  for (const part of input.parts) {
    const n = issueOfPlan.get(part.planId);
    if (n === undefined) continue;
    if (part.prNumber !== null) prParent.set(part.prNumber, partOrigin(n, part.slug));
  }
  for (const issue of input.world.issues) {
    const branch = issueBranch(issue.number);
    for (const pr of input.world.pullRequests) {
      const mine = pr.branch === branch || issue.linkedPrNumber === pr.number;
      if (mine && !prParent.has(pr.number)) prParent.set(pr.number, issueOrigin(issue.number));
    }
  }

  const priorPr = new Map(input.existing.filter((n) => n.kind === 'pr').map((n) => [n.ref, n]));
  const seen = new Set<string>();

  for (const pr of input.world.pullRequests) {
    const ref = `pr:${pr.number}`;
    seen.add(ref);
    const base = basePrOf(pr, input.world.pullRequests);
    const merged = pr.merged === true;
    out.push({
      ref,
      kind: 'pr',
      parentRef: prParent.get(pr.number) ?? null,
      baseRef: base ? `pr:${base.number}` : null,
      title: pr.title,
      // An observation of it being open clears a stale terminal — a reopened PR
      // corrects itself rather than being stuck on a guess.
      status: merged ? 'merged' : 'open',
      terminal: merged,
      provenance: merged ? 'observed' : null,
    });
  }

  for (const pr of input.world.closedPullRequests ?? []) {
    const ref = `pr:${pr.number}`;
    if (seen.has(ref)) continue; // in both lists: the open reading wins, it is fresher
    seen.add(ref);
    out.push({
      ref,
      kind: 'pr',
      parentRef: prParent.get(pr.number) ?? null,
      title: pr.title,
      status: prState(pr),
      terminal: true,
      provenance: 'observed',
    });
  }

  // A PR the graph knew as open and the world no longer mentions. Absence-means-
  // merged stays the deliberate fallback it is everywhere else here — but it is
  // recorded as an inference, and never overwrites something actually observed.
  for (const [ref, prior] of priorPr) {
    if (seen.has(ref) || prior.terminal) continue;
    out.push({
      ref,
      kind: 'pr',
      parentRef: prior.parentRef,
      baseRef: prior.baseRef,
      title: prior.title,
      status: 'merged',
      terminal: true,
      provenance: 'inferred',
    });
  }

  return out;
}
