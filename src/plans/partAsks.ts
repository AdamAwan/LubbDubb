import type { Store } from '../store/store.js';
import type { PlanPart } from '../types.js';

// → docs/spec/08-planning.md

export function withdrawPartAsks(store: Store, retired: readonly PlanPart[], resolution: string): void {
  if (retired.length === 0) return;
  for (const task of store.humanTasks.listHumanTasksForParts(retired.map((p) => p.id))) {
    if (task.status === 'open') store.humanTasks.settleHumanTask(task.id, 'declined', resolution);
  }
}

export const AMENDED_PART_RESOLUTION = 'An amended plan no longer includes this step.';

export const REFUSED_PART_RESOLUTION = 'The plan this step belonged to was sent back to a planner.';
