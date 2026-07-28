import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Store } from '../src/store/store.js';
import type {
  Issue,
  Job,
  Plan,
  PlanPart,
  PullRequest,
  Task,
  WorkNode,
  WorkNodeObservation,
  WorldSnapshot,
} from '../src/types.js';
import { foldWorkGraph, type WorkGraphInput } from '../src/graph/workGraph.js';
import { buildSystem } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorldStore } from '../src/integrations/fake/fakeWorld.js';
import { buildApp } from '../src/server/app.js';

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

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'p40',
    number: 40,
    title: 'PR #40',
    branch: 'issue/12',
    ciStatus: 'passing',
    unresolvedComments: [],
    ...over,
  };
}

test('a PR is parented to the issue whose branch it is on', () => {
  const out = foldWorkGraph(input({ world: world({ issues: [issue()], pullRequests: [pr()] }) }));
  assert.equal(node(out, 'pr:40').parentRef, 'issue:12');
  assert.equal(node(out, 'pr:40').kind, 'pr');
  assert.equal(node(out, 'pr:40').status, 'open');
  assert.equal(node(out, 'pr:40').terminal, false);
});

test('a PR is parented to the plan part that produced it, in preference to the issue', () => {
  const out = foldWorkGraph(
    input({
      world: world({ issues: [issue()], pullRequests: [pr({ number: 41, branch: 'issue/12/schema' })] }),
      plans: [plan()],
      parts: [part({ prNumber: 41, branch: 'issue/12/schema', status: 'in_review' })],
    }),
  );
  assert.equal(node(out, 'pr:41').parentRef, 'issue:12:part:schema', 'work lineage, not the nearest ancestor');
});

test('a PR seen in the closed list is terminal, and says it was observed', () => {
  const merged = foldWorkGraph(
    input({ world: world({ issues: [issue()], closedPullRequests: [pr({ state: 'merged' })] }) }),
  );
  assert.equal(node(merged, 'pr:40').status, 'merged');
  assert.equal(node(merged, 'pr:40').terminal, true);
  assert.equal(node(merged, 'pr:40').provenance, 'observed');

  const abandoned = foldWorkGraph(
    input({ world: world({ issues: [issue()], closedPullRequests: [pr({ state: 'closed' })] }) }),
  );
  assert.equal(node(abandoned, 'pr:40').status, 'closed');
  assert.equal(node(abandoned, 'pr:40').terminal, true);
});

test('a PR that was open and is now absent is inferred merged', () => {
  const existing: WorkNode[] = [
    {
      ref: 'pr:40',
      kind: 'pr',
      parentRef: 'issue:12',
      baseRef: null,
      title: 'PR #40',
      status: 'open',
      terminal: false,
      provenance: null,
      firstSeenAt: '2026-07-28T09:00:00.000Z',
      lastSeenAt: '2026-07-28T09:00:00.000Z',
    },
  ];
  const out = foldWorkGraph(input({ world: world({ issues: [issue()] }), existing }));
  assert.equal(node(out, 'pr:40').status, 'merged');
  assert.equal(node(out, 'pr:40').terminal, true);
  assert.equal(node(out, 'pr:40').provenance, 'inferred', 'absence-means-merged stays, but says so');
});

test('an observed terminal is never downgraded to an inference', () => {
  const existing: WorkNode[] = [
    {
      ref: 'pr:40',
      kind: 'pr',
      parentRef: 'issue:12',
      baseRef: null,
      title: 'PR #40',
      status: 'merged',
      terminal: true,
      provenance: 'observed',
      firstSeenAt: '2026-07-28T09:00:00.000Z',
      lastSeenAt: '2026-07-28T09:00:00.000Z',
    },
  ];
  const out = foldWorkGraph(input({ world: world({ issues: [issue()] }), existing }));
  assert.equal(
    out.find((n) => n.ref === 'pr:40'),
    undefined,
    'nothing to say, so nothing is emitted',
  );
});

test('a PR observed open again clears a stale terminal', () => {
  const existing: WorkNode[] = [
    {
      ref: 'pr:40',
      kind: 'pr',
      parentRef: 'issue:12',
      baseRef: null,
      title: 'PR #40',
      status: 'merged',
      terminal: true,
      provenance: 'inferred',
      firstSeenAt: '2026-07-28T09:00:00.000Z',
      lastSeenAt: '2026-07-28T09:00:00.000Z',
    },
  ];
  const out = foldWorkGraph(input({ world: world({ issues: [issue()], pullRequests: [pr()] }), existing }));
  assert.equal(node(out, 'pr:40').status, 'open');
  assert.equal(node(out, 'pr:40').terminal, false);
  assert.equal(node(out, 'pr:40').provenance, null);
});

test('a stacked PR records its base as a cross-link, not as its parent', () => {
  const out = foldWorkGraph(
    input({
      world: world({
        issues: [issue()],
        pullRequests: [
          pr({ number: 41, branch: 'issue/12/schema' }),
          pr({ number: 42, branch: 'issue/12/api', baseBranch: 'issue/12/schema' }),
        ],
      }),
      plans: [plan()],
      parts: [
        part({ prNumber: 41, branch: 'issue/12/schema', status: 'in_review' }),
        part({
          id: 'pl1:api',
          slug: 'api',
          seq: 2,
          title: 'API',
          prNumber: 42,
          branch: 'issue/12/api',
          status: 'in_review',
        }),
      ],
    }),
  );
  assert.equal(node(out, 'pr:42').baseRef, 'pr:41', 'stacking is its own relation');
  assert.equal(node(out, 'pr:42').parentRef, 'issue:12:part:api', 'and does not become the parent');
});

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    kind: 'code',
    title: 'Fix CI on PR #40',
    prompt: 'fix it',
    branch: 'issue/12',
    originRef: 'pr:40:ci',
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'running',
    agentId: 'a1',
    createdAt: '2026-07-28T09:00:00.000Z',
    updatedAt: '2026-07-28T09:00:00.000Z',
    ...over,
  };
}

function job(over: Partial<Job> = {}): Job {
  return {
    id: 'j7',
    title: 'Bump the linter',
    prompt: 'bump it',
    kind: 'code',
    branch: 'chore/lint',
    status: 'queued',
    taskId: null,
    createdAt: '2026-07-28T09:00:00.000Z',
    updatedAt: '2026-07-28T09:00:00.000Z',
    ...over,
  };
}

test('a concern hangs off its PR and is live while a task is active', () => {
  const out = foldWorkGraph(input({ world: world({ issues: [issue()], pullRequests: [pr()] }), tasks: [task()] }));
  assert.equal(node(out, 'pr:40:ci').parentRef, 'pr:40');
  assert.equal(node(out, 'pr:40:ci').kind, 'concern');
  assert.equal(node(out, 'pr:40:ci').status, 'live');
  assert.equal(node(out, 'pr:40:ci').terminal, false, 'a concern is never terminal — the PR is');
});

test('a concern whose attempts have all ended is done but stays in the graph', () => {
  const out = foldWorkGraph(
    input({ world: world({ issues: [issue()], pullRequests: [pr()] }), tasks: [task({ status: 'done' })] }),
  );
  assert.equal(node(out, 'pr:40:ci').status, 'done');
  assert.equal(node(out, 'pr:40:ci').terminal, false);
});

test('two attempts on one concern are one node', () => {
  const out = foldWorkGraph(
    input({
      world: world({ issues: [issue()], pullRequests: [pr()] }),
      tasks: [task({ id: 't1', status: 'done' }), task({ id: 't2', status: 'running' })],
    }),
  );
  assert.equal(out.filter((n) => n.ref === 'pr:40:ci').length, 1, 'keyed on the origin, not the task');
  assert.equal(node(out, 'pr:40:ci').status, 'live', 'one live attempt makes the node live');
});

test('a task on an origin with no PR in the graph produces no orphan concern', () => {
  const out = foldWorkGraph(input({ world: world({ issues: [issue()] }), tasks: [task()] }));
  assert.equal(
    out.find((n) => n.ref === 'pr:40:ci'),
    undefined,
  );
});

test('a job is its own root, and a cancelled one is terminal', () => {
  const queued = foldWorkGraph(input({ jobs: [job()] }));
  assert.equal(node(queued, 'job:j7').parentRef, null);
  assert.equal(node(queued, 'job:j7').kind, 'job');
  assert.equal(node(queued, 'job:j7').terminal, false);

  const cancelled = foldWorkGraph(input({ jobs: [job({ status: 'cancelled' })] }));
  assert.equal(node(cancelled, 'job:j7').terminal, true);
});

test('a merged PR stays merged in the graph long after the world forgets it', async () => {
  // The headline property, in three moves: the merge is *observed* while the PR is
  // still in `closedPullRequests`, then the PR leaves both lists the way the 6h
  // `closedPrWindowMs` retires it, and the graph is asked again.
  const config = loadConfig({
    auth: { enabled: false } as never,
    dbPath: ':memory:',
    labelPrefix: '',
    agentMode: 'raw',
    heartbeatIntervalMs: 999_999,
    // Nothing here needs an agent; a paused fleet keeps the pulse to the world.
    startPaused: true,
  });
  const system = buildSystem(config, { backend: new FakePtyBackend(), errorMirror: () => {} });

  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Widget' });
  system.connector.inject({ kind: 'new_pr', number: 40, title: 'Add the widget', branch: 'issue/12' });
  await system.harness.runCycle('manual');

  const open = system.store.listWorkSubtree('issue:12').find((n) => n.ref === 'pr:40');
  assert.equal(open?.status, 'open');
  assert.equal(open?.parentRef, 'issue:12');

  // The fake models a merge as a `pr_closed` that moves the row into the closed
  // list — there is no `pr_merged` event, and `mergePr` leaves the PR in place.
  system.connector.inject({ kind: 'pr_closed', prNumber: 40, merged: true });
  await system.harness.runCycle('manual');
  const merged = system.store.listWorkSubtree('issue:12').find((n) => n.ref === 'pr:40');
  assert.equal(merged?.status, 'merged', 'the merge is observed while it is still in the world');
  assert.equal(merged?.terminal, true);
  assert.equal(merged?.provenance, 'observed');

  // Age the row out of the retention window. The fake never expires its closed
  // list, so emptying the shared world document by hand is what standing past
  // `closedPrWindowMs` does on a real provider: PR #40 is in neither list.
  new FakeWorldStore(system.store).mutate((world) => {
    world.closedPullRequests = [];
  });
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');

  const after = system.store.listWorkSubtree('issue:12').find((n) => n.ref === 'pr:40');
  assert.equal(after?.status, 'merged', 'the graph still knows PR #40 merged');
  assert.equal(after?.terminal, true);
  // The distinction that makes this durability rather than a lucky re-derivation:
  // absence-means-merged would have rewritten this to `inferred`.
  assert.equal(after?.provenance, 'observed', 'the record was kept, not re-guessed');
  assert.equal(after?.parentRef, 'issue:12', 'and still knows which issue it delivered');
  system.store.close();
});

test('the routes serve roots and one subtree, and refuse an unknown root', async () => {
  const config = loadConfig({
    auth: { enabled: false } as never,
    dbPath: ':memory:',
    labelPrefix: '',
    agentMode: 'raw',
    heartbeatIntervalMs: 999_999,
    startPaused: true,
  });
  const system = buildSystem(config, { backend: new FakePtyBackend(), errorMirror: () => {} });
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Widget' });
  system.connector.inject({ kind: 'new_pr', number: 40, title: 'Add the widget', branch: 'issue/12' });
  await system.harness.runCycle('manual');

  const { app } = await buildApp(system);
  const roots = await app.inject({ method: 'GET', url: '/api/work' });
  assert.equal(roots.statusCode, 200);
  assert.ok(
    (roots.json() as { roots: { ref: string }[] }).roots.some((r) => r.ref === 'issue:12'),
    'the issue is a root',
  );

  // A ref carries colons (`issue:12`, `pr:41:ci`), so the route has to survive one
  // in a path segment — the whole vocabulary is unusable otherwise.
  const sub = await app.inject({ method: 'GET', url: '/api/work/issue:12' });
  assert.equal(sub.statusCode, 200);
  assert.deepEqual((sub.json() as { nodes: { ref: string }[] }).nodes.map((n) => n.ref).sort(), ['issue:12', 'pr:40']);

  const missing = await app.inject({ method: 'GET', url: '/api/work/issue:999' });
  assert.equal(missing.statusCode, 404);

  await app.close();
  system.store.close();
});

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...srcFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out.sort();
}

test('stage 1 is a lens: nothing in the dispatcher reads the graph', () => {
  // Structural, the way prAttention's single-importer property is kept. The moment
  // a rule consults the graph, an agent can suppress another's dispatch and a
  // second opinion about a gate starts living nowhere near the gate it duplicates.
  const readers = srcFiles('src')
    .filter((f) => !f.startsWith('src/graph/'))
    .filter((f) => readFileSync(f, 'utf8').includes('graph/workGraph'));
  assert.deepEqual(
    readers,
    ['src/harness.ts', 'src/system.ts'],
    'only the pulse and the composition root may reach the graph in stage 1',
  );
});
