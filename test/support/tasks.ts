import type { Store } from '../../src/store/store.js';
import type { Task, TaskSummary } from '../../src/types.js';

/**
 * The whole task a predicate picks out of the store — **prompt included**.
 *
 * `Store.listTasks` ships {@link TaskSummary} rows, without the rendered prompt:
 * it is the reading `/api/state` is built from, and the prompts were 17.4 MB of
 * the 20.2 MB it returned. A test that asserts on what an agent was actually
 * handed therefore reads the one row back by id, which is what every production
 * prompt reader does too — so the assertion exercises the same path the launch
 * does rather than a wider one kept alive for the tests.
 */
export function findTask(store: Store, pred: (t: TaskSummary) => boolean): Task | undefined {
  const found = store.listTasks().find(pred);
  return found ? (store.getTask(found.id) ?? undefined) : undefined;
}
