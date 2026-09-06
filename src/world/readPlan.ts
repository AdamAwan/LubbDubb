import type { TaskSummary, WorldEvent, WorldSnapshot } from '../types.js';
import { isActiveTask } from '../tasks.js';

// → docs/spec/03-world-model.md

export interface ReadPlan {
  hot: ReadonlySet<string> | 'all';
  hotMaxAgeMs: number;
  coldMaxAgeMs: number;
  fresh?: ReadonlySet<string>;
}

export interface ReadLanes {
  hotMaxAgeMs: number;
  coldMaxAgeMs: number;
}

export const DEFAULT_READ_LANES: ReadLanes = { hotMaxAgeMs: 60_000, coldMaxAgeMs: 5 * 60_000 };

export function prReadRef(number: number): string {
  return `pr:${number}`;
}

export function issueReadRef(number: number): string {
  return `issue:${number}`;
}

interface ReadPlanInputs {
  previous: WorldSnapshot | null;
  tasks: TaskSummary[];
  events: WorldEvent[];
  now: number;
  lanes: ReadLanes;
  fresh?: readonly string[];
}

export function buildReadPlan(input: ReadPlanInputs): ReadPlan {
  const { previous, lanes } = input;
  const fresh = new Set(input.fresh ?? []);
  if (previous === null) return { hot: 'all', fresh, ...lanes };

  for (const ref of refsFinishedSince(input.tasks, previous.pullRequests, previous.takenAt)) fresh.add(ref);

  const hot = new Set<string>();
  for (const pr of previous.pullRequests) {
    if (pr.ciStatus !== 'passing' && pr.ciStatus !== 'failing') hot.add(prReadRef(pr.number));
    else if (pr.approved === true) hot.add(prReadRef(pr.number));
    else if (pr.mergeableState === 'behind' || pr.mergeableState === 'dirty') hot.add(prReadRef(pr.number));
  }

  const branches = new Set<string>();
  for (const task of input.tasks) {
    if (!isActiveTask(task)) continue;
    if (task.branch) branches.add(task.branch);
    const origin = task.originRef;
    if (origin === null) continue;
    const root = origin.split(':').slice(0, 2).join(':');
    hot.add(root);
  }
  for (const pr of previous.pullRequests) if (branches.has(pr.branch)) hot.add(prReadRef(pr.number));

  const since = input.now - lanes.coldMaxAgeMs;
  for (const event of input.events) {
    if (event.ref === null) continue;
    if (Date.parse(event.createdAt) < since) continue;
    hot.add(event.ref);
  }

  return { hot, fresh, ...lanes };
}

export function hydrationMaxAgeMs(plan: ReadPlan | undefined, ref: string): number {
  if (plan === undefined) return DEFAULT_READ_LANES.hotMaxAgeMs;
  if (plan.fresh?.has(ref) === true) return 0;
  if (plan.hot === 'all' || plan.hot.has(ref)) return plan.hotMaxAgeMs;
  return plan.coldMaxAgeMs;
}

export function refsFinishedSince(
  tasks: readonly TaskSummary[],
  pullRequests: readonly { number: number; branch: string }[],
  since: string,
): ReadonlySet<string> {
  const refs = new Set<string>();
  const at = Date.parse(since);
  if (Number.isNaN(at)) return refs;

  const branches = new Set<string>();
  for (const task of tasks) {
    if (isActiveTask(task)) continue;
    const ended = Date.parse(task.updatedAt);
    if (Number.isNaN(ended) || ended <= at) continue;
    if (task.branch) branches.add(task.branch);
    const origin = task.originRef;
    if (origin !== null) refs.add(origin.split(':').slice(0, 2).join(':'));
  }
  for (const pr of pullRequests) if (branches.has(pr.branch)) refs.add(prReadRef(pr.number));
  return refs;
}
