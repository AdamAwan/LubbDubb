import { issueOriginNumber } from '../issueOrigins.js';
import type {
  Job,
  Plan,
  PlanPart,
  PullRequest,
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
import { jobBranch } from '../jobs/naming.js';

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

function foldIssues(input: WorkGraphInput, out: WorkNodeObservation[]): void {
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
}

function foldPlansAndParts(input: WorkGraphInput, out: WorkNodeObservation[]): Map<string, number> {
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
  return issueOfPlan;
}

function jobsByBranch(jobs: Job[]): Map<string, string> {
  const jobOfBranch = new Map<string, string>();
  for (const job of jobs) {
    const branch = jobBranch(job);
    if (branch !== null) jobOfBranch.set(branch, `job:${job.id}`);
  }
  return jobOfBranch;
}

function prParents(
  input: WorkGraphInput,
  issueOfPlan: ReadonlyMap<string, number>,
  jobOfBranch: ReadonlyMap<string, string>,
  allPrs: PullRequest[],
): Map<number, string> {
  const prParent = new Map<number, string>();
  for (const part of input.parts) {
    const n = issueOfPlan.get(part.planId);
    if (n === undefined) continue;
    if (part.prNumber !== null) prParent.set(part.prNumber, partOrigin(n, part.slug));
  }
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
  return prParent;
}

function jobParents(
  input: WorkGraphInput,
  jobOfBranch: ReadonlyMap<string, string>,
  allPrs: PullRequest[],
): Map<string, string> {
  const jobParent = new Map<string, string>();
  for (const issue of input.world.issues) {
    if (issue.linkedPrNumber === null || issue.linkedPrNumber === undefined) continue;
    for (const pr of allPrs) {
      if (pr.number !== issue.linkedPrNumber) continue;
      const owner = jobOfBranch.get(pr.branch);
      if (owner !== undefined && !jobParent.has(owner)) jobParent.set(owner, issueOrigin(issue.number));
    }
  }
  return jobParent;
}

function foldPrs(
  input: WorkGraphInput,
  prParent: ReadonlyMap<number, string>,
  out: WorkNodeObservation[],
): Set<string> {
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
  return seen;
}

function tasksByOrigin(tasks: TaskSummary[], matches: (originRef: string) => boolean): Map<string, TaskSummary[]> {
  const byOrigin = new Map<string, TaskSummary[]>();
  for (const task of tasks) {
    if (task.originRef === null) continue;
    if (!matches(task.originRef)) continue;
    const bucket = byOrigin.get(task.originRef);
    if (bucket) bucket.push(task);
    else byOrigin.set(task.originRef, [task]);
  }
  return byOrigin;
}

function attemptsLive(attempts: TaskSummary[]): boolean {
  return attempts.some((t) => t.status === 'queued' || t.status === 'running' || t.status === 'waiting');
}

function foldAttempts(input: WorkGraphInput, seen: ReadonlySet<string>, out: WorkNodeObservation[]): void {
  const assessTasks = tasksByOrigin(input.tasks, (ref) => issueOriginNumber('assess', ref) !== null);
  for (const [ref, attempts] of assessTasks) {
    const issueRef = ref.slice(0, ref.lastIndexOf(':'));
    out.push({
      ref,
      kind: 'assess',
      parentRef: issueRef,
      title: attempts[0]?.title ?? ref,
      status: attemptsLive(attempts) ? 'live' : 'done',
      terminal: false,
    });
  }

  const concernTasks = tasksByOrigin(input.tasks, (ref) => /^pr:\d+:.+$/.test(ref));
  for (const [ref, attempts] of concernTasks) {
    const prRef = ref.slice(0, ref.indexOf(':', 3));
    if (!seen.has(prRef)) continue;
    out.push({
      ref,
      kind: 'concern',
      parentRef: prRef,
      title: attempts[0]?.title ?? ref,
      status: attemptsLive(attempts) ? 'live' : 'done',
      terminal: false,
    });
  }
}

function applyFilings(
  input: WorkGraphInput,
  out: WorkNodeObservation[],
  emitted: Map<string, WorkNodeObservation>,
  nodeRefs: Set<string>,
): void {
  const existingByRef = new Map(input.existing.map((n) => [n.ref, n]));

  for (const filing of input.filings) {
    if (filing.ticketRef === null) continue;

    const target = emitted.get(filing.targetRef);
    if (target) target.parentRef = filing.ticketRef;
    else {
      const prior = existingByRef.get(filing.targetRef);
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
}

export function foldWorkGraph(input: WorkGraphInput): WorkNodeObservation[] {
  const out: WorkNodeObservation[] = [];

  foldIssues(input, out);
  const issueOfPlan = foldPlansAndParts(input, out);

  const allPrs = [...input.world.pullRequests, ...(input.world.closedPullRequests ?? [])];
  const jobOfBranch = jobsByBranch(input.jobs);
  const prParent = prParents(input, issueOfPlan, jobOfBranch, allPrs);
  const jobParent = jobParents(input, jobOfBranch, allPrs);
  const seen = foldPrs(input, prParent, out);

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

  foldAttempts(input, seen, out);

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

  applyFilings(input, out, emitted, nodeRefs);

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
