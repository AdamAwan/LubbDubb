import type { Store } from '../store/store.js';
import type { PlanPart } from '../types.js';

/**
 * A retired part's ask goes with it.
 *
 * Declined rather than deleted or a third terminal of its own: "this is not going
 * to be done, and here is why" is exactly what declining means, and the
 * alternative — an open task pointing at a part no plan schedules — is an
 * obligation on the operator that nothing will ever settle. The bench is their own
 * to-do list, so a row on it nothing can settle is what makes the bench stop being
 * read.
 *
 * One function rather than the line repeated at each retiring site, for
 * `IssueVerdictStore.recordVerdict`'s reason: a retirer that settles its own asks
 * compiles and passes while leaving the bench holding a step no plan schedules,
 * and the row it leaves looks exactly like one the operator still owes.
 */
export function withdrawPartAsks(store: Store, retired: readonly PlanPart[], resolution: string): void {
  if (retired.length === 0) return;
  for (const task of store.listHumanTasksForParts(retired.map((p) => p.id))) {
    if (task.status === 'open') store.settleHumanTask(task.id, 'declined', resolution);
  }
}

/** An amendment dropped the step. */
export const AMENDED_PART_RESOLUTION = 'An amended plan no longer includes this step.';

/** A refusal sent the whole plan back, so the step it belonged to is not scheduled by anything. */
export const REFUSED_PART_RESOLUTION = 'The plan this step belonged to was sent back to a planner.';
