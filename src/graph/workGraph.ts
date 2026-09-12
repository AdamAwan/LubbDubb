import { issueOriginNumber } from '../issueOrigins.js';
import type {
  Job,
  Plan,
  PlanPart,
  TaskSummary,
  WorkItemFiling,
  WorkNode,
  WorkNodeObservation,
  WorldSnapshot,
} from '../types.js';
import { planIssueNumber, partOrigin, partSettled } from '../plans/parts.js';
import { issueOrigin, planOrigin } from '../plans/planning.js';
import { basePrOf, prState } from '../pr/prHealth.js';
import { issueBranch } from '../dispatcher/issuePickup.js';
import { jobBranch } from '../jobs.js';

// → docs/spec/14-persistence.md#the-work-graph

export interface WorkGraphInput {
  world: WorldSnapshot;
  tasks: TaskSummary[];
  plans: Plan[];
  parts: PlanPart[];
  jobs: Job[];
  filings: WorkItemFiling[];
  existing: WorkNode[];
}

export function foldWorkGraph(input: WorkGraphInput): WorkNodeObservation[] {
  const out: WorkNodeObservation[] = [];

  for (const issue of input.world.issues) {
    const closed = issue.state === 'closed';
    out.push({
      ref: issueOrigin(issue.number),
      kind: 'issue',
      parentRef: null,
      title: issue.title,
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
    if (n === undefined) continue;
    out.push({
      ref: partOrigin(n, part.slug),
      kind: 'part',
      parentRef: issueOrigin(n),
      title: part.title,
      status: part.status,
      terminal: partSettled(part) || part.status === 'retired',
    });
  }

  const prParent = new Map<number, string>();
  for (const part of input.parts) {
    const n = issueOfPlan.get(part.planId);
    if (n === undefined) continue;
    if (part.prNumber !== null) prParent.set(part.prNumber, partOrigin(n, part.slug));
  }
  const jobOfBranch = new Map<string, string>();
  for (const job of input.jobs) {
    const branch = jobBranch(job);
    if (branch !== null) jobOfBranch.set(branch, `job:${job.id}`);
  }
  const allPrs = [...input.world.pullRequests, ...(input.world.closedPullRequests ?? [])];
  for (const pr of allPrs) {
    const owner = jobOfBranch.get(pr.branch);
    if (owner !== undefined && !prParent.has(pr.number)) prParent.set(pr.number, owner);
  }

  for (const issue of input.world.issues) {
    const branch = issueBranch(issue.number);
    for (const pr of allPrs) {
      const mine = pr.branch === branch || issue.linkedPrNumber === pr.number;
      if (mine && !prParent.has(pr.number)) prParent.set(pr.number, issueOrigin(issue.number));
    }
  }

  const jobParent = new Map<string, string>();
  for (const issue of input.world.issues) {
    if (issue.linkedPrNumber === null || issue.linkedPrNumber === undefined) continue;
    for (const pr of allPrs) {
      if (pr.number !== issue.linkedPrNumber) continue;
      const owner = jobOfBranch.get(pr.branch);
      if (owner !== undefined && !jobParent.has(owner)) jobParent.set(owner, issueOrigin(issue.number));
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
      status: merged ? 'merged' : 'open',
      terminal: merged,
      provenance: merged ? 'observed' : null,
    });
  }

  for (const pr of input.world.closedPullRequests ?? []) {
    const ref = `pr:${pr.number}`;
    if (seen.has(ref)) continue;
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

  for (const job of input.jobs) {
    const ref = `job:${job.id}`;
    out.push({
      ref,
      kind: 'job',
      parentRef: jobParent.get(ref) ?? null,
      title: job.title,
      status: job.status,
      terminal: job.status === 'cancelled',
    });
  }

  const assessTasks = new Map<string, TaskSummary[]>();
  for (const task of input.tasks) {
    if (task.originRef === null) continue;
    if (issueOriginNumber('assess', task.originRef) === null) continue;
    const bucket = assessTasks.get(task.originRef);
    if (bucket) bucket.push(task);
    else assessTasks.set(task.originRef, [task]);
  }
  for (const [ref, attempts] of assessTasks) {
    const issueRef = ref.slice(0, ref.lastIndexOf(':'));
    const live = attempts.some((t) => t.status === 'queued' || t.status === 'running' || t.status === 'waiting');
    out.push({
      ref,
      kind: 'assess',
      parentRef: issueRef,
      title: attempts[0]?.title ?? ref,
      status: live ? 'live' : 'done',
      terminal: false,
    });
  }

  const concernTasks = new Map<string, TaskSummary[]>();
  for (const task of input.tasks) {
    if (task.originRef === null) continue;
    if (!/^pr:\d+:.+$/.test(task.originRef)) continue;
    const bucket = concernTasks.get(task.originRef);
    if (bucket) bucket.push(task);
    else concernTasks.set(task.originRef, [task]);
  }
  for (const [ref, attempts] of concernTasks) {
    const prRef = ref.slice(0, ref.indexOf(':', 3));
    if (!seen.has(prRef)) continue;
    const live = attempts.some((t) => t.status === 'queued' || t.status === 'running' || t.status === 'waiting');
    out.push({
      ref,
      kind: 'concern',
      parentRef: prRef,
      title: attempts[0]?.title ?? ref,
      status: live ? 'live' : 'done',
      terminal: false,
    });
  }

  const emitted = new Map(out.map((o) => [o.ref, o]));

  const nodeRefs = new Set([...emitted.keys(), ...input.existing.map((n) => n.ref)]);
  for (const job of input.jobs) {
    if (job.originRef === null) continue;
    const ref = `job:${job.id}`;
    const node = emitted.get(ref);
    if (!node || node.parentRef !== null) continue;
    const parent = originAncestor(job.originRef, ref, nodeRefs);
    if (parent !== null) node.parentRef = parent;
  }

  for (const filing of input.filings) {
    if (filing.ticketRef === null) continue;

    const target = emitted.get(filing.targetRef);
    if (target) target.parentRef = filing.ticketRef;
    else {
      const prior = input.existing.find((n) => n.ref === filing.targetRef);
      if (!prior) continue;
      out.push({ ...prior, parentRef: filing.ticketRef });
    }

    if (filing.ticketRef.startsWith('issue:') && !nodeRefs.has(filing.ticketRef)) {
      const placeholder: WorkNodeObservation = {
        ref: filing.ticketRef,
        kind: 'issue',
        parentRef: null,
        title: filing.ticketRef,
        status: 'open',
        terminal: false,
      };
      out.push(placeholder);
      emitted.set(placeholder.ref, placeholder);
      nodeRefs.add(placeholder.ref);
    }
  }

  return out;
}

function originAncestor(originRef: string, self: string, nodeRefs: ReadonlySet<string>): string | null {
  let ref = originRef;
  for (;;) {
    if (ref !== self && nodeRefs.has(ref)) return ref;
    const cut = ref.lastIndexOf(':');
    if (cut <= 0) return null;
    ref = ref.slice(0, cut);
  }
}
