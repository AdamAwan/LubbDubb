import type { Store } from '../../src/store/store.js';
import type { Task, TaskSummary } from '../../src/types.js';

export function findTask(store: Store, pred: (t: TaskSummary) => boolean): Task | undefined {
  const found = store.tasks.listTasks().find(pred);
  return found ? (store.tasks.getTask(found.id) ?? undefined) : undefined;
}
