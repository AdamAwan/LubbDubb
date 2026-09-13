import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createPrepare } from '../src/store/context.js';
import { Store } from '../src/store/store.js';

test('the same SQL comes back as the same compiled statement', () => {
  const db = new Database(':memory:');
  try {
    const prep = createPrepare(db);
    const sql = `SELECT 1 AS one`;
    const first = prep(sql);
    const second = prep(sql);
    assert.equal(first, second, 'a second ask for the same SQL re-uses the compiled statement');
    assert.deepEqual(second.get(), { one: 1 }, 'the cached statement still runs');
  } finally {
    db.close();
  }
});

test('different SQL compiles separately', () => {
  const db = new Database(':memory:');
  try {
    const prep = createPrepare(db);
    assert.notEqual(prep(`SELECT 1 AS one`), prep(`SELECT 2 AS two`));
  } finally {
    db.close();
  }
});

test('two connections never share a compiled statement', () => {
  const a = new Database(':memory:');
  const b = new Database(':memory:');
  try {
    const sql = `SELECT 1 AS one`;
    assert.notEqual(
      createPrepare(a)(sql),
      createPrepare(b)(sql),
      'a statement belongs to the connection it compiled against',
    );
  } finally {
    a.close();
    b.close();
  }
});

test('closing one store leaves another store working', () => {
  const first = new Store(':memory:');
  const second = new Store(':memory:');
  const task = second.tasks.createTask({ kind: 'code', title: 'kept', prompt: 'p', branch: null, originRef: null });
  first.tasks.createTask({ kind: 'code', title: 'gone', prompt: 'p', branch: null, originRef: null });
  first.close();
  try {
    assert.equal(second.tasks.getTask(task.id)?.title, 'kept', 'the caches are per-connection, not global');
    assert.equal(second.tasks.listTasks().length, 1);
  } finally {
    second.close();
  }
});

test('a memoised statement is re-usable across calls on a live store', () => {
  const store = new Store(':memory:');
  try {
    const one = store.tasks.createTask({ kind: 'code', title: 't1', prompt: 'p', branch: null, originRef: null });
    const two = store.tasks.createTask({ kind: 'code', title: 't2', prompt: 'p', branch: null, originRef: null });
    assert.equal(store.tasks.getTask(one.id)?.title, 't1');
    assert.equal(store.tasks.getTask(two.id)?.title, 't2');
    assert.equal(store.tasks.getTask(one.id)?.title, 't1', 'a re-used statement is not left holding the last bind');
    assert.equal(store.tasks.getTask('task_missing'), null);
  } finally {
    store.close();
  }
});
