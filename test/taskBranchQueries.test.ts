import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { isActiveTask } from '../src/tasks.js';
import type { Task } from '../src/types.js';

const STATUSES: Task['status'][] = ['queued', 'running', 'waiting', 'done', 'interrupted', 'failed'];

function seed(store: Store): Task[] {
  return STATUSES.map((status) =>
    store.tasks.createTask({
      kind: 'code',
      title: `task in ${status}`,
      prompt: 'p',
      branch: 'feature/one',
      originRef: null,
      status,
    }),
  );
}

test('hasActiveTaskOnBranch answers what a scan-and-filter answered', () => {
  const store = new Store(':memory:', () => new Date().toISOString());
  try {
    const seeded = seed(store);
    store.tasks.createTask({
      kind: 'code',
      title: 'elsewhere',
      prompt: 'p',
      branch: 'feature/two',
      originRef: null,
      status: 'running',
    });
    const all = store.tasks.listTasks();
    const scan = (branch: string, exceptId: string): boolean =>
      all.some((t) => t.id !== exceptId && t.branch === branch && isActiveTask(t));

    for (const task of seeded)
      assert.equal(
        store.tasks.hasActiveTaskOnBranch('feature/one', task.id),
        scan('feature/one', task.id),
        `excluding the ${task.status} task reads the same as the scan it replaces`,
      );

    const lone = store.tasks.createTask({
      kind: 'code',
      title: 'lone',
      prompt: 'p',
      branch: 'feature/three',
      originRef: null,
      status: 'running',
    });
    assert.equal(
      store.tasks.hasActiveTaskOnBranch('feature/three', lone.id),
      false,
      'the task being asked about never counts as company on its own branch',
    );
    assert.equal(
      store.tasks.hasActiveTaskOnBranch('feature/two', lone.id),
      true,
      "another branch's active task is company on that branch",
    );
    assert.equal(
      store.tasks.hasActiveTaskOnBranch('feature/none', lone.id),
      false,
      'a branch no task names has nothing active on it',
    );
  } finally {
    store.close();
  }
});
