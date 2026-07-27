import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import type { WorkNodeObservation } from '../src/types.js';

function obs(over: Partial<WorkNodeObservation> & Pick<WorkNodeObservation, 'ref' | 'kind'>): WorkNodeObservation {
  return { title: over.ref, status: 'open', terminal: false, parentRef: null, ...over };
}

test('records nodes, reads a subtree and lists roots', () => {
  const store = new Store(':memory:');
  store.recordWorkGraph([
    obs({ ref: 'issue:12', kind: 'issue', title: 'Widget' }),
    obs({ ref: 'pr:40', kind: 'pr', parentRef: 'issue:12', title: 'PR #40' }),
    obs({ ref: 'pr:40:ci', kind: 'concern', parentRef: 'pr:40', title: 'CI fix', status: 'live' }),
    obs({ ref: 'issue:99', kind: 'issue', title: 'Unrelated' }),
  ]);

  assert.deepEqual(
    store.listWorkSubtree('issue:12').map((n) => n.ref),
    ['issue:12', 'pr:40', 'pr:40:ci'],
    'the subtree walks parent_ref down from the root',
  );
  assert.deepEqual(
    store
      .listWorkRoots()
      .map((n) => n.ref)
      .sort(),
    ['issue:12', 'issue:99'],
    'a root is a node with no parent',
  );
});

test('a parent is written once and never rewritten, but a null one can be filled', () => {
  const store = new Store(':memory:');
  store.recordWorkGraph([obs({ ref: 'pr:50', kind: 'pr', title: 'Stray PR' })]);
  store.recordWorkGraph([obs({ ref: 'pr:50', kind: 'pr', parentRef: 'issue:12', title: 'Stray PR' })]);
  assert.equal(store.listWorkSubtree('pr:50')[0]?.parentRef, 'issue:12', 'a null parent is adopted');

  store.recordWorkGraph([obs({ ref: 'pr:50', kind: 'pr', parentRef: 'issue:99', title: 'Stray PR' })]);
  assert.equal(store.listWorkSubtree('pr:50')[0]?.parentRef, 'issue:12', 'an existing parent is never rewritten');
});

test('a node not observed is left exactly as it was', () => {
  const store = new Store(':memory:');
  store.recordWorkGraph([
    obs({ ref: 'issue:12', kind: 'issue', title: 'Widget' }),
    obs({ ref: 'pr:40', kind: 'pr', parentRef: 'issue:12', title: 'PR #40', status: 'merged', terminal: true }),
  ]);
  store.recordWorkGraph([obs({ ref: 'issue:12', kind: 'issue', title: 'Widget' })]);

  const pr = store.listWorkSubtree('issue:12').find((n) => n.ref === 'pr:40');
  assert.equal(pr?.status, 'merged', 'an unobserved node keeps its status');
  assert.equal(pr?.terminal, true, 'and its terminal flag');
});
