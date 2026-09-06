import type { TaskSummary, WorldEvent, WorldSnapshot } from '../types.js';
import { isActiveTask } from '../tasks.js';

/**
 * Which entities this pulse is prepared to pay to re-read, and how stale a
 * hydration it will reuse for the rest. A lane governs only the age
 * backstop — the change gate itself is never suppressed. Cold is never
 * invisible: a cold entity is still in the snapshot the dispatcher reasons
 * over, it just gets no per-entity fan-out until its token moves or its
 * backstop comes due. → `docs/spec/04-harness-cycle.md#hot-and-cold`
 */
export interface ReadPlan {
  /**
   * The refs (`pr:42`, `issue:7`) on the fast lane, or `'all'` for a read
   * taken outside the pulse (a route, or the cockpit's own snapshot) with no
   * fleet state to classify against.
   */
  hot: ReadonlySet<string> | 'all';
  /** Longest a **hot** entity's hydration may be reused while its token sits still. */
  hotMaxAgeMs: number;
  /** The same bound for a **cold** one: the slow lane's re-read interval. */
  coldMaxAgeMs: number;
  /**
   * The refs an inbound delivery has said are stale — re-read regardless of
   * lane or change token, via an age bound of zero. Optional: a read taken
   * outside the pulse has no inbox to drain.
   * → `docs/spec/30-ingress.md#invalidating-precisely`
   */
  fresh?: ReadonlySet<string>;
}

/** The two backstops, as the operator sets them. */
export interface ReadLanes {
  hotMaxAgeMs: number;
  coldMaxAgeMs: number;
}

/**
 * The defaults for {@link ReadLanes}. The cold lane is deliberately the
 * backstop every entity used to have, so nothing is staler than before. Zero
 * is meaningful on either lane: nothing is reused, and that lane pays its
 * fan-out every pulse.
 */
export const DEFAULT_READ_LANES: ReadLanes = { hotMaxAgeMs: 60_000, coldMaxAgeMs: 5 * 60_000 };

/** How a pull request is named in the plan and in `world_events`. */
export function prReadRef(number: number): string {
  return `pr:${number}`;
}

/** How an issue / work item is named in the plan and in `world_events`. */
export function issueReadRef(number: number): string {
  return `issue:${number}`;
}

/** What the pulse knows about the fleet when it decides which entities are moving. */
interface ReadPlanInputs {
  /** The world the last real cycle read, or null before there has been one.
   * Null makes everything hot, matching what the empty cache would do anyway. */
  previous: WorldSnapshot | null;
  /** The task rows, for the entities the fleet is actually working on. */
  tasks: TaskSummary[];
  /** A tail of `world_events`, newest first — what has moved lately. */
  events: WorldEvent[];
  now: number;
  lanes: ReadLanes;
  /**
   * What an inbound delivery has invalidated since the last plan was built —
   * `IngressInbox.drain()`, or nothing on a deployment with no ingress.
   */
  fresh?: readonly string[];
}

/**
 * Classify every entity in the last reading as hot or cold. Hot is "plausibly
 * moving", deliberately generous — a wrong hot costs one fan-out, a wrong
 * cold costs freshness on work the fleet is about to act on. Everything else
 * is cold; an entity the previous reading did not contain is absent and
 * needs no lane. → `docs/spec/04-harness-cycle.md#hot-and-cold`
 */
export function buildReadPlan(input: ReadPlanInputs): ReadPlan {
  const { previous, lanes } = input;
  const fresh = new Set(input.fresh ?? []);
  // `fresh` defeats the age backstop rather than widening it, so it's carried
  // on this arm too.
  if (previous === null) return { hot: 'all', fresh, ...lanes };

  // The fleet's own work is an invalidation no change token reports; `fresh`
  // because what's needed is no reuse at all, not a bound on it.
  for (const ref of refsFinishedSince(input.tasks, previous.pullRequests, previous.takenAt)) fresh.add(ref);

  const hot = new Set<string>();
  for (const pr of previous.pullRequests) {
    if (pr.ciStatus !== 'passing' && pr.ciStatus !== 'failing') hot.add(prReadRef(pr.number));
    else if (pr.approved === true) hot.add(prReadRef(pr.number));
    else if (pr.mergeableState === 'behind' || pr.mergeableState === 'dirty') hot.add(prReadRef(pr.number));
  }

  // Branch is the one field a task and a PR share; origin ref is how a task
  // names its issue (prefix match, since a plan part sits below it).
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

/**
 * How stale a hydration this read may reuse for one entity — the number the
 * hydration cache is asked with. A caller with no plan reads on the hot
 * lane's terms: a route knows nothing about the fleet and must not declare a
 * cold entity.
 */
export function hydrationMaxAgeMs(plan: ReadPlan | undefined, ref: string): number {
  if (plan === undefined) return DEFAULT_READ_LANES.hotMaxAgeMs;
  // Zero is always past, so the cache re-hydrates. Asked before the lanes,
  // since anything short of overriding reuse would change nothing here.
  if (plan.fresh?.has(ref) === true) return 0;
  if (plan.hot === 'all' || plan.hot.has(ref)) return plan.hotMaxAgeMs;
  return plan.coldMaxAgeMs;
}

/**
 * The entities the fleet **itself** finished work on since a given reading
 * was taken. Never judge an entity by a reading older than the fleet's own
 * last act on it — {@link buildReadPlan} marks them `fresh`, and the
 * dispatcher holds the pull-request concerns off them. Terminal tasks only:
 * an active task holds its own origin and branch, so including one would say
 * "behind the fleet" about everything being worked. Derived, not remembered,
 * so it self-clears on the next real read.
 */
export function refsFinishedSince(
  tasks: readonly TaskSummary[],
  pullRequests: readonly { number: number; branch: string }[],
  since: string,
): ReadonlySet<string> {
  const refs = new Set<string>();
  const at = Date.parse(since);
  // An unparseable reading is no evidence anything is behind it; guessing the other
  // way would hold every concern.
  if (Number.isNaN(at)) return refs;

  const branches = new Set<string>();
  for (const task of tasks) {
    if (isActiveTask(task)) continue;
    const ended = Date.parse(task.updatedAt);
    if (Number.isNaN(ended) || ended <= at) continue;
    if (task.branch) branches.add(task.branch);
    // The root the read plan names an entity by: a task's origin is finer than an
    // entity (`pr:42:comments`). A root naming nothing the world reads is unmatched.
    const origin = task.originRef;
    if (origin !== null) refs.add(origin.split(':').slice(0, 2).join(':'));
  }
  // A code agent names its pull request by the branch it worked, not by an origin.
  for (const pr of pullRequests) if (branches.has(pr.branch)) refs.add(prReadRef(pr.number));
  return refs;
}
