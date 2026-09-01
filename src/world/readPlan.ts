import type { TaskSummary, WorldEvent, WorldSnapshot } from '../types.js';
import { isActiveTask } from '../tasks.js';

/**
 * Which entities this pulse is prepared to pay to re-read, and how stale a
 * hydration it will reuse for the rest.
 *
 * The world read is change-gated (`src/integrations/hydrationCache.ts`): what the
 * last fan-out derived per entity is reused while a **change token** off the cheap
 * list payload says nothing moved. That gate is never suppressed — a token that
 * moved is a hydration that would contradict the cheap fields fetched on the same
 * pulse, and serving it is how a cache starts lying. What a lane governs is the
 * other half: the **age backstop**, the bound on reuse for the fields no token
 * covers at all — a base branch advancing under a pull request, an administrator
 * reconfiguring a branch policy, a cross-reference an issue gained elsewhere.
 *
 * That backstop is worth a different number for different entities, and before
 * this it was one constant for all of them — which is why the pulse could not
 * simply be run more often. A pull request with a build running is worth re-reading
 * within the minute; a two-week-old issue nobody has touched is worth reading on
 * the same slow clock everything used to be on, because a thirty-second heartbeat
 * that re-read it on the pulse would spend a hundred and twenty fan-outs an hour
 * on an answer that has not changed since the fleet booted.
 *
 * **Cold is never invisible.** A cold entity is still listed by the cheap payload
 * every pulse, still carries its title, state, labels and head commit fresh, and
 * still appears in the snapshot the dispatcher reasons over — the whole world is
 * read every pulse. What it does not get is a per-entity fan-out it has no reason
 * to need, until its token moves or its lane's backstop comes due.
 * → `docs/spec/04-harness-cycle.md#hot-and-cold`
 */
export interface ReadPlan {
  /**
   * The refs (`pr:42`, `issue:7`) on the fast lane, or `'all'` for a read taken
   * outside the pulse — a route, or the cockpit's own snapshot — which has no
   * fleet state to classify against and must not be the thing that decides an
   * entity is cold.
   */
  hot: ReadonlySet<string> | 'all';
  /** Longest a **hot** entity's hydration may be reused while its token sits still. */
  hotMaxAgeMs: number;
  /** The same bound for a **cold** one: the slow lane's re-read interval. */
  coldMaxAgeMs: number;
  /**
   * The refs an inbound delivery has said are stale — re-read whatever lane they
   * are on and whatever their change token says.
   *
   * This is how event-driven ingress invalidates *precisely* one entity
   * (`src/ingress/inbox.ts`): a ref here is asked for with an age bound of **zero**,
   * which is always past, so the hydration cache drops that one entry and hydrates
   * it again. Nothing else in the cache is touched, and no integration needs a
   * method to be told.
   *
   * Optional, because a read taken outside the pulse — a route, the cockpit's own
   * snapshot — has no inbox to drain and nothing to invalidate.
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
 * The defaults for {@link ReadLanes}, owned here rather than in `config.ts` — the
 * repo's rule that a policy's own module states its default.
 *
 * A minute for the hot lane, because that is what the fields no token covers are
 * worth on an entity something is happening to.
 *
 * **Five minutes for the cold one, deliberately equal to the backstop every entity
 * used to have** — which was itself the heartbeat the fleet ran at before any of
 * this existed. So the slowest thing this fleet reads is read exactly as often as
 * *everything* was before: no entity is staler than it was, the hot handful are
 * five times fresher, and the pulse itself is ten times faster. A cold lane longer
 * than that would be the first blind spot this effort actually introduced, and it
 * would arrive silently.
 *
 * Zero is meaningful on either: an age bound of zero is always past, so nothing is
 * ever reused and that lane pays its fan-out every pulse.
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

/**
 * What the pulse knows about the fleet when it decides which entities are moving.
 *
 * Unexported: `buildReadPlan` is the one caller, and the shape is its argument
 * rather than a vocabulary anything else names.
 */
interface ReadPlanInputs {
  /**
   * The world the last real cycle read, or null before there has been one. Null
   * makes **everything** hot, which is also what the empty cache would do — there
   * is nothing to reuse, so the lanes have nothing to govern.
   */
  previous: WorldSnapshot | null;
  /** The task rows, for the entities the fleet is actually working on. */
  tasks: TaskSummary[];
  /** A tail of `world_events`, newest first — what has moved lately. */
  events: WorldEvent[];
  now: number;
  lanes: ReadLanes;
  /**
   * What an inbound delivery has invalidated since the last plan was built —
   * `IngressInbox.drain()`, or nothing at all on a deployment with no ingress.
   */
  fresh?: readonly string[];
}

/**
 * Classify every entity in the last reading as hot or cold.
 *
 * Hot is "something about this is plausibly moving", and it is deliberately
 * generous: a wrong *hot* costs one entity's fan-out on one pulse, and a wrong
 * *cold* costs freshness on something the fleet is about to act on. The rules,
 * each of which is a thing the harness already knows:
 *
 * - **CI is not settled.** Anything short of `passing`/`failing` is a build that
 *   will finish with no token moving, and finishing it usually moves the merge
 *   state too — which nothing on the list payload reports.
 * - **Merge-readiness is in flux**: approved (so the harness may be about to merge
 *   it), or already reported `behind`/`dirty`, which is exactly the field the base
 *   branch advances underneath.
 * - **The fleet is on it** — an active task naming its ref as an origin, or
 *   working its branch. That covers a just-dispatched issue, whose linked pull
 *   request is the next thing to appear on it.
 * - **It moved recently** — a `world_event` about that ref inside the cold lane's
 *   own interval. An entity a person is in the middle of doing something to stays
 *   hot until it has been quiet for as long as the slow lane is.
 *
 * Everything else is cold. An entity the previous reading did not contain is not
 * in the set at all, and does not need to be: the cache holds nothing for it, so
 * the first read hydrates it whatever lane it is nominally on.
 */
export function buildReadPlan(input: ReadPlanInputs): ReadPlan {
  const { previous, lanes } = input;
  const fresh = new Set(input.fresh ?? []);
  // `all` is already the strongest lane there is, but the fresh set is stronger
  // still — it is the one thing that defeats the age backstop rather than widening
  // it — so it is carried on this arm too.
  if (previous === null) return { hot: 'all', fresh, ...lanes };

  // The fleet's own work is an invalidation exactly as a delivery is, and a
  // stronger one: an agent that answered a review thread changed the very field
  // the concern is gated on, and changed it in a way no change token reports. On
  // `fresh` rather than merely hot, because the hot lane is a *bound on reuse* and
  // what is needed here is no reuse at all. → {@link refsFinishedSince}
  for (const ref of refsFinishedSince(input.tasks, previous.pullRequests, previous.takenAt)) fresh.add(ref);

  const hot = new Set<string>();
  for (const pr of previous.pullRequests) {
    if (pr.ciStatus !== 'passing' && pr.ciStatus !== 'failing') hot.add(prReadRef(pr.number));
    else if (pr.approved === true) hot.add(prReadRef(pr.number));
    else if (pr.mergeableState === 'behind' || pr.mergeableState === 'dirty') hot.add(prReadRef(pr.number));
  }

  // Branch, because that is the one field a task and a pull request share; and the
  // origin ref, which is how a task names the issue it is under (`issue:12`, or a
  // plan part below it — hence the prefix match rather than equality).
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
 * hydration cache is asked with, and the only shape a lane reaches an integration
 * in.
 *
 * A caller with no plan reads on the **hot** lane's terms. That is the safe
 * direction and the honest one: a route or the cockpit snapshot knows nothing
 * about what the fleet is doing, so it must not be the thing that declares an
 * entity cold — and on a hot lane a read taken moments after the pulse's still
 * costs nothing, because every token is where the pulse left it.
 */
export function hydrationMaxAgeMs(plan: ReadPlan | undefined, ref: string): number {
  if (plan === undefined) return DEFAULT_READ_LANES.hotMaxAgeMs;
  // Zero is always past, so the cache drops this entry and re-hydrates it. Asked
  // before the lanes, because that is what "a webhook said this moved" has to beat:
  // an entity a delivery names is usually one whose *token has not moved* either —
  // a review left on a pull request does not touch its `updatedAt` — so anything
  // short of overriding the reuse entirely would change nothing.
  if (plan.fresh?.has(ref) === true) return 0;
  if (plan.hot === 'all' || plan.hot.has(ref)) return plan.hotMaxAgeMs;
  return plan.coldMaxAgeMs;
}

/**
 * The entities the fleet **itself** finished work on since a given reading was
 * taken — a pull request whose review-comment agent has just exited, an issue
 * whose planner has.
 *
 * Two callers, and they are the two halves of one rule: *never judge an entity by
 * a reading older than the fleet's own last act on it.*
 *
 * - {@link buildReadPlan} puts these on the `fresh` set, so the next real read
 *   re-hydrates them whatever their change token says. It has to be told, because
 *   the token cannot tell it: **resolving a review thread moves no `updated_at`**,
 *   and the agent's own reply may not either, so the one fact that would retire
 *   the concern is the one fact the gate cannot see.
 * - The dispatcher asks the same question of the world it is deciding against, and
 *   holds the pull-request concerns off an entity whose answer is yes
 *   ({@link StageContext.readingBehindFleet}).
 *
 * **Terminal tasks only.** A task still active holds its own origin and branch —
 * that is what `isActiveTask` is for, and the dispatcher's own de-dup — so
 * including one would say "behind the fleet" about every entity being worked right
 * now, which is every entity the fleet is on.
 *
 * Self-clearing, and that is why it is derived rather than remembered: a real read
 * moves `takenAt` past the task's `updatedAt` and the entity drops out on its own.
 * A restart loses nothing for the same reason — the rows outlive the process.
 */
export function refsFinishedSince(
  tasks: readonly TaskSummary[],
  pullRequests: readonly { number: number; branch: string }[],
  since: string,
): ReadonlySet<string> {
  const refs = new Set<string>();
  const at = Date.parse(since);
  // An unparseable reading is not evidence that anything is behind it. Refusing to
  // guess costs a pulse of latency; guessing the other way holds every concern.
  if (Number.isNaN(at)) return refs;

  const branches = new Set<string>();
  for (const task of tasks) {
    if (isActiveTask(task)) continue;
    const ended = Date.parse(task.updatedAt);
    if (Number.isNaN(ended) || ended <= at) continue;
    if (task.branch) branches.add(task.branch);
    // The same root the read plan names an entity by: a task's origin is finer
    // than an entity (`pr:42:comments`, `issue:12:plan`), and what was read is the
    // entity. A root naming nothing the world reads through — a job, a plan — is
    // simply never matched by either caller.
    const origin = task.originRef;
    if (origin !== null) refs.add(origin.split(':').slice(0, 2).join(':'));
  }
  // A code agent names its pull request by the branch it worked, not by an origin:
  // the comment concern's origin is `pr:<n>:comments`, but a part's is its issue.
  for (const pr of pullRequests) if (branches.has(pr.branch)) refs.add(prReadRef(pr.number));
  return refs;
}
