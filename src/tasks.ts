import type { Task } from './types.js';

/**
 * What "the fleet is still working this" means, in one place.
 *
 * The set had six representations: an identical private `isActiveTask` in
 * `harness.ts`, `prAttention.ts` and `dispatcher/issuePickup.ts`, and three
 * `status IN ('queued','running','waiting')` literals in `Store`. They agreed,
 * and nothing made them agree — `listOutstandingTasks`' own doc comment had to
 * say "the same set the two `findActiveTask*` gates below treat as active",
 * which is a coupling stated in prose because it could not be stated in code.
 *
 * It is worth one module because of what reads it. These are the gates that hold
 * an origin and a branch shut: `findActiveTaskByOrigin` is the origin
 * de-duplication every dispatch rule relies on, `findActiveTaskByBranch` is the
 * enforcement half of the origin↔branch 1:1 property (issue #116), and
 * `listOutstandingTasks` is how crash recovery finds a `queued` task with no
 * agent behind it. A copy that drifted by one member would not fail anything
 * loudly: dropping `queued` from one reader re-opens the window the executor
 * writes the task row in, and two agents land on one branch.
 */

/**
 * The statuses a task is still outstanding in. Typed against `Task['status']`, so
 * renaming a member of the union fails to compile here rather than silently
 * narrowing what counts as active.
 */
const ACTIVE_TASK_STATUSES: readonly Task['status'][] = ['queued', 'running', 'waiting'];

/**
 * `queued` is deliberately active. The executor writes the task row and *then*
 * spawns, so a task with no agent yet is still a claim the harness is holding on
 * its origin and branch — treating it as inactive is what would let a second
 * dispatch through the window between the two.
 */
export function isActiveTask(t: Task): boolean {
  return ACTIVE_TASK_STATUSES.includes(t.status);
}

/**
 * The same set as a SQL `IN` list, for the three `Store` queries that ask this
 * question of the table rather than of a loaded row. Built from
 * {@link ACTIVE_TASK_STATUSES} so the predicate and the queries cannot answer
 * differently; interpolating it is safe because it is derived entirely from that
 * constant and never from input.
 */
export const ACTIVE_TASK_STATUS_SQL = `(${ACTIVE_TASK_STATUSES.map((s) => `'${s}'`).join(',')})`;
