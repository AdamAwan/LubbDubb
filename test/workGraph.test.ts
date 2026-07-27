import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import type { Issue, Plan, PlanPart, WorkNodeObservation, WorldSnapshot } from '../src/types.js';
import { foldWorkGraph, type WorkGraphInput } from '../src/graph/workGraph.js';

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

function world(over: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    takenAt: '2026-07-28T09:00:00.000Z',
    pullRequests: [],
    closedPullRequests: [],
    issues: [],
    stories: [],
    ...over,
  };
}

function issue(over: Partial<Issue> = {}): Issue {
  return { id: 'i12', number: 12, title: 'Widget', body: '', labels: [], state: 'open', linkedPrNumber: null, ...over };
}

function plan(over: Partial<Plan> = {}): Plan {
  return {
    id: 'pl1',
    originRef: 'issue:12',
    title: 'Widget plan',
    status: 'active',
    reason: null,
    statusCommentRef: null,
    createdAt: '2026-07-28T09:00:00.000Z',
    updatedAt: '2026-07-28T09:00:00.000Z',
    ...over,
  };
}

function part(over: Partial<PlanPart> = {}): PlanPart {
  return {
    id: 'pl1:schema',
    planId: 'pl1',
    slug: 'schema',
    seq: 1,
    title: 'Schema',
    scope: 'the tables',
    dependsOn: [],
    branch: null,
    prNumber: null,
    status: 'ready',
    taskId: null,
    createdAt: '2026-07-28T09:00:00.000Z',
    updatedAt: '2026-07-28T09:00:00.000Z',
    ...over,
  };
}

function input(over: Partial<WorkGraphInput> = {}): WorkGraphInput {
  return { world: world(), tasks: [], plans: [], parts: [], jobs: [], existing: [], ...over };
}

/** The observation for `ref`, or a failed assertion naming what was produced. */
function node(out: WorkNodeObservation[], ref: string): WorkNodeObservation {
  const found = out.find((n) => n.ref === ref);
  assert.ok(found, `expected a node ${ref}, got: ${out.map((n) => n.ref).join(', ')}`);
  return found;
}

test('an open issue is a root, and a closed one is terminal', () => {
  const open = foldWorkGraph(input({ world: world({ issues: [issue()] }) }));
  assert.equal(node(open, 'issue:12').parentRef, null);
  assert.equal(node(open, 'issue:12').kind, 'issue');
  assert.equal(node(open, 'issue:12').terminal, false);

  const closed = foldWorkGraph(input({ world: world({ issues: [issue({ state: 'closed' })] }) }));
  assert.equal(node(closed, 'issue:12').terminal, true, 'the tracker status is the only terminal marker');
  assert.equal(node(closed, 'issue:12').status, 'closed');
});

test("an issue's native workflow state is its status when it has one", () => {
  const out = foldWorkGraph(input({ world: world({ issues: [issue({ workItemState: 'In Review' })] }) }));
  assert.equal(node(out, 'issue:12').status, 'In Review');
  assert.equal(node(out, 'issue:12').terminal, false, 'a review state is not terminal');
});

test('a plan and its parts hang off the issue', () => {
  const out = foldWorkGraph(
    input({
      world: world({ issues: [issue()] }),
      plans: [plan()],
      parts: [part(), part({ id: 'pl1:api', slug: 'api', seq: 2, title: 'API', status: 'merged' })],
    }),
  );
  assert.equal(node(out, 'issue:12:plan').parentRef, 'issue:12');
  assert.equal(node(out, 'issue:12:plan').kind, 'plan');
  assert.equal(node(out, 'issue:12:part:schema').parentRef, 'issue:12');
  assert.equal(node(out, 'issue:12:part:schema').kind, 'part');
  assert.equal(node(out, 'issue:12:part:schema').terminal, false);
  assert.equal(node(out, 'issue:12:part:api').terminal, true, 'a merged part is terminal');
});

test('a retired part stays in the graph and is terminal', () => {
  const out = foldWorkGraph(
    input({ world: world({ issues: [issue()] }), plans: [plan()], parts: [part({ status: 'retired' })] }),
  );
  assert.equal(node(out, 'issue:12:part:schema').status, 'retired');
  assert.equal(node(out, 'issue:12:part:schema').terminal, true);
});

test('the fold is idempotent — the same input twice produces the same output', () => {
  const args = input({ world: world({ issues: [issue()] }), plans: [plan()], parts: [part()] });
  assert.deepEqual(foldWorkGraph(args), foldWorkGraph(args));
});
