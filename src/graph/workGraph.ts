import type { Job, Plan, PlanPart, Task, WorkNode, WorkNodeObservation, WorldSnapshot } from '../types.js';
import { planIssueNumber, partOrigin } from '../plans/parts.js';
import { issueOrigin, planOrigin } from '../plans/planning.js';
import { basePrOf, prState } from '../prHealth.js';
import { issueBranch } from '../dispatcher/issuePickup.js';
import { jobBranch } from '../jobs.js';

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
  // **Arm A — a job owns the PR its own branch carries.** Before the issue loop,
  // because `parentRef` follows work lineage and a branch match is a statement
  // about what *caused* the PR, where an issue's `linkedPrNumber` is a statement
  // about what it is *about*. The aboutness is not lost: arm B recovers it one
  // level up, giving `issue:12 -> job:7 -> pr:41` rather than either edge alone.
  // An issue's own branch match (`issue/<n>`) can never collide with `job/<id>`,
  // so only the fuzzy arm is ever displaced by this.
  const jobOfBranch = new Map<string, string>();
  for (const job of input.jobs) {
    const branch = jobBranch(job);
    if (branch !== null) jobOfBranch.set(branch, `job:${job.id}`);
  }
  for (const pr of input.world.pullRequests) {
    const owner = jobOfBranch.get(pr.branch);
    if (owner !== undefined && !prParent.has(pr.number)) prParent.set(pr.number, owner);
  }

  for (const issue of input.world.issues) {
    const branch = issueBranch(issue.number);
    for (const pr of input.world.pullRequests) {
      const mine = pr.branch === branch || issue.linkedPrNumber === pr.number;
      if (mine && !prParent.has(pr.number)) prParent.set(pr.number, issueOrigin(issue.number));
    }
  }

  // **Arm B — a job is adopted by the issue its own PR names.** When the job's PR
  // links back to an issue, a work item for this work already exists and somebody
  // already said so, so there is nothing for stage 3 to file. This is the
  // write-once parent's own intended case one level up: null is adopted when
  // `linkedPrNumber` appears, and never re-parented afterwards.
  const jobParent = new Map<string, string>();
  for (const issue of input.world.issues) {
    if (issue.linkedPrNumber === null || issue.linkedPrNumber === undefined) continue;
    const pr = input.world.pullRequests.find((p) => p.number === issue.linkedPrNumber);
    if (!pr) continue;
    const owner = jobOfBranch.get(pr.branch);
    if (owner !== undefined && !jobParent.has(owner)) jobParent.set(owner, issueOrigin(issue.number));
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

  for (const job of input.jobs) {
    const ref = `job:${job.id}`;
    out.push({
      ref,
      kind: 'job',
      // Null unless arm B found the issue this job's PR names. A null here never
      // undoes an adoption — `recordWorkGraph` coalesces onto the stored parent —
      // so the fold may go on emitting one forever.
      parentRef: jobParent.get(ref) ?? null,
      title: job.title,
      status: job.status,
      terminal: job.status === 'cancelled',
    });
  }

  // Assessments — the `assess` kind stage 1 reserved in the schema and left
  // unwritten. Keyed on the origin like a concern, so repeated attempts on one
  // issue are one node, and parented to the issue rather than to whatever
  // delivered it: an assessment is about the issue as a whole, which is the same
  // reason `assessmentOrigin` refuses every working agent.
  //
  // **Never terminal**, for a concern's reason. An assessment is a step toward a
  // verdict, not a leaf — an issue with a live assessor is not finished, and the
  // verdict it produces lives in `issue_deliveries`, which the tracker's `closed`
  // still outranks. Terminality on this node would be the graph starting to hold
  // an opinion about completion, which is exactly what it must not do.
  const assessTasks = new Map<string, Task[]>();
  for (const task of input.tasks) {
    if (task.originRef === null) continue;
    if (!/^issue:\d+:assess$/.test(task.originRef)) continue;
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

  // Concerns, keyed on the **origin** rather than the task: two CI attempts on one
  // PR are two `tasks` rows but one node, so the graph does not grow a node every
  // time an agent restarts. The attempts stay reachable by `origin_ref`.
  //
  // A concern is never terminal. It is a step on the way to a merge, not a leaf —
  // while one is live its PR simply is not terminal yet, and a PR that sits red
  // forever correctly keeps its issue unfinished.
  const concernTasks = new Map<string, Task[]>();
  for (const task of input.tasks) {
    if (task.originRef === null) continue;
    if (!/^pr:\d+:.+$/.test(task.originRef)) continue;
    const bucket = concernTasks.get(task.originRef);
    if (bucket) bucket.push(task);
    else concernTasks.set(task.originRef, [task]);
  }
  for (const [ref, attempts] of concernTasks) {
    const prRef = ref.slice(0, ref.indexOf(':', 3));
    if (!seen.has(prRef)) continue; // its PR is not in the graph, so neither is it
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

  return out;
}
