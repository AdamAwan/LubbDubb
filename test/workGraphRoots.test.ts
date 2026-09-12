import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  Issue,
  Job,
  PullRequest,
  WorkItemFiling,
  WorkNode,
  WorkNodeObservation,
  WorldSnapshot,
} from '../src/types.js';
import { foldWorkGraph, type WorkGraphInput } from '../src/graph/workGraph.js';
import { unrecordedWork, workItemTicketFields } from '../src/graph/unrecorded.js';
import { defaultPromptTemplates } from '../src/dispatcher/promptTemplates.js';
import { jobBranch } from '../src/jobs.js';
import { Store } from '../src/store/store.js';
import { buildSystem } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildApp } from '../src/server/app.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

function world(over: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    takenAt: '2026-07-28T09:00:00.000Z',
    pullRequests: [],
    closedPullRequests: [],
    issues: [],
    ...over,
  };
}

function issue(over: Partial<Issue> = {}): Issue {
  return { id: 'i12', number: 12, title: 'Widget', body: '', labels: [], state: 'open', linkedPrNumber: null, ...over };
}

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'p41',
    number: 41,
    title: 'PR #41',
    branch: 'job/j7',
    ciStatus: 'passing',
    unresolvedComments: [],
    ...over,
  };
}

function job(over: Partial<Job> = {}): Job {
  return {
    id: 'j7',
    title: 'Bump the linter',
    prompt: 'bump it',
    kind: 'code',
    branch: null,
    status: 'dispatched',
    originRef: null,
    taskId: 't1',
    createdAt: '2026-07-28T09:00:00.000Z',
    updatedAt: '2026-07-28T09:00:00.000Z',
    ...over,
  };
}

function input(over: Partial<WorkGraphInput> = {}): WorkGraphInput {
  return { world: world(), tasks: [], plans: [], parts: [], jobs: [], filings: [], existing: [], ...over };
}

function node(out: WorkNodeObservation[], ref: string): WorkNodeObservation {
  const found = out.find((n) => n.ref === ref);
  assert.ok(found, `expected a node ${ref}, got: ${out.map((n) => n.ref).join(', ')}`);
  return found;
}

test('jobBranch derives job/<id> for a code job and refuses a desk one', () => {
  assert.equal(jobBranch(job()), 'job/j7', 'the derived branch is what rule `manual-job` dispatches on');
  assert.equal(jobBranch(job({ branch: 'chore/lint' })), 'chore/lint', "an operator's branch wins");
  assert.equal(jobBranch(job({ kind: 'desk' })), null, 'a desk job runs in a scratch dir and has no branch');
});

test('a PR on a job’s derived branch is parented to the job', () => {
  const out = foldWorkGraph(input({ world: world({ pullRequests: [pr()] }), jobs: [job()] }));
  assert.equal(node(out, 'pr:41').parentRef, 'job:j7', 'the job caused this PR, so it owns it');
  assert.equal(node(out, 'job:j7').kind, 'job');
});

test('a PR on the branch an operator named for the job is parented to it too', () => {
  const out = foldWorkGraph(
    input({
      world: world({ pullRequests: [pr({ branch: 'chore/lint' })] }),
      jobs: [job({ branch: 'chore/lint' })],
    }),
  );
  assert.equal(node(out, 'pr:41').parentRef, 'job:j7');
});

test('a desk job adopts nothing — it has no branch to match on', () => {
  const out = foldWorkGraph(input({ world: world({ pullRequests: [pr()] }), jobs: [job({ kind: 'desk' })] }));
  assert.equal(node(out, 'pr:41').parentRef, null, 'a desk job touches no repository');
  assert.equal(node(out, 'job:j7').parentRef, null);
});

test("a hand-made PR is left unparented — it is not the harness's work", () => {
  const out = foldWorkGraph(input({ world: world({ pullRequests: [pr({ branch: 'someones-fix' })] }), jobs: [job()] }));
  assert.equal(node(out, 'pr:41').parentRef, null, 'filing a ticket for every drive-by PR would be noise');
});

test('a job whose PR links an issue is adopted by it, and needs no ticket filed', () => {
  const out = foldWorkGraph(
    input({
      world: world({ issues: [issue({ linkedPrNumber: 41 })], pullRequests: [pr()] }),
      jobs: [job()],
    }),
  );
  assert.equal(node(out, 'job:j7').parentRef, 'issue:12', 'a work item for this work already exists');
});

test('lineage beats aboutness: the PR belongs to the job, and the job to the issue', () => {
  const out = foldWorkGraph(
    input({
      world: world({ issues: [issue({ linkedPrNumber: 41 })], pullRequests: [pr()] }),
      jobs: [job()],
    }),
  );
  assert.equal(node(out, 'pr:41').parentRef, 'job:j7');
  assert.equal(node(out, 'job:j7').parentRef, 'issue:12');
  assert.equal(node(out, 'issue:12').parentRef, null, 'the issue is still the root');
});

test("an issue's own branch match is never displaced by a job", () => {
  const out = foldWorkGraph(
    input({
      world: world({ issues: [issue()], pullRequests: [pr({ branch: 'issue/12' })] }),
      jobs: [job()],
    }),
  );
  assert.equal(node(out, 'pr:41').parentRef, 'issue:12');
});

function stored(over: Partial<WorkNode> & { ref: string }): WorkNode {
  return {
    kind: 'issue',
    parentRef: null,
    baseRef: null,
    title: over.ref,
    status: 'open',
    terminal: false,
    provenance: null,
    firstSeenAt: '2026-07-01T09:00:00.000Z',
    lastSeenAt: '2026-07-01T09:00:00.000Z',
    ...over,
  };
}

test('a requeued job is adopted by the issue whose work it redoes', () => {
  const out = foldWorkGraph(
    input({
      world: world({ issues: [issue()] }),
      jobs: [job({ title: 'Requeued: Plan issue #12', originRef: 'issue:12:plan' })],
    }),
  );
  assert.equal(node(out, 'job:j7').parentRef, 'issue:12', 'the tracker item is named on the job itself');
});

test("a part's requeue lands on the part, not on the issue two levels up", () => {
  const out = foldWorkGraph(
    input({
      world: world({ issues: [issue()] }),
      jobs: [job({ originRef: 'issue:12:part:api' })],
      existing: [stored({ ref: 'issue:12:part:api', kind: 'part', parentRef: 'issue:12', title: 'API' })],
    }),
  );
  assert.equal(node(out, 'job:j7').parentRef, 'issue:12:part:api');
});

test('a requeue of a requeue collapses onto the job it redoes, not into a second row', () => {
  const out = foldWorkGraph(
    input({
      jobs: [job(), job({ id: 'j8', title: 'Requeued: Bump the linter', originRef: 'job:j7' })],
    }),
  );
  assert.equal(node(out, 'job:j8').parentRef, 'job:j7', 'one piece of work, one root');
  assert.equal(node(out, 'job:j7').parentRef, null, 'and the original is still that root');
});

test('an origin naming nothing the graph holds leaves the job a root', () => {
  const out = foldWorkGraph(input({ jobs: [job({ originRef: 'issue:99:plan' })] }));
  assert.equal(node(out, 'job:j7').parentRef, null, 'issue 99 is not in the graph');
});

test('a job never becomes its own parent', () => {
  const out = foldWorkGraph(input({ jobs: [job({ originRef: 'job:j7' })] }));
  assert.equal(node(out, 'job:j7').parentRef, null, 'the write-once parent would make a cycle permanent');
});

test('arm C only ever fills a null — arm B’s adoption stands', () => {
  const out = foldWorkGraph(
    input({
      world: world({ issues: [issue({ linkedPrNumber: 41 }), issue({ id: 'i13', number: 13 })], pullRequests: [pr()] }),
      jobs: [job({ originRef: 'issue:13:plan' })],
    }),
  );
  assert.equal(node(out, 'job:j7').parentRef, 'issue:12', "what the job's own PR names is the stronger signal");
});

test('an origin adopts from a node the world has since forgotten', () => {
  const out = foldWorkGraph(
    input({
      jobs: [job({ originRef: 'issue:12:retro' })],
      existing: [stored({ ref: 'issue:12', kind: 'issue', title: 'Widget', status: 'closed', terminal: true })],
    }),
  );
  assert.equal(node(out, 'job:j7').parentRef, 'issue:12');
});

test('an adopted job is not unrecorded, and an origin-less one still is', () => {
  const adopted = recorded({
    world: world({ issues: [issue()] }),
    jobs: [job({ originRef: 'issue:12:assess' })],
  });
  assert.deepEqual(
    unrecordedWork(adopted.nodes, [job({ originRef: 'issue:12:assess' })], []),
    [],
    'the tracker already accounts for it',
  );
  adopted.store.close();

  const bare = recorded({ jobs: [job()] });
  assert.deepEqual(
    unrecordedWork(bare.nodes, [job()], []).map((u) => u.ref),
    ['job:j7'],
  );
  bare.store.close();
});

test('a filing is claimed once per node — a second click is refused by the write', () => {
  const store = new Store(':memory:');
  const first = store.graph.createWorkItemFiling({ targetRef: 'job:j7' });
  assert.equal(first?.status, 'filing');
  assert.equal(first?.ticketRef, null, 'the ticket does not exist yet — that is what filing means');

  assert.equal(
    store.graph.createWorkItemFiling({ targetRef: 'job:j7' }),
    null,
    'the refusal is the primary key, not a caller remembering to look',
  );
  assert.equal(store.graph.listWorkItemFilings().length, 1);
  store.close();
});

test('linking settles a filing exactly once', () => {
  const store = new Store(':memory:');
  store.graph.createWorkItemFiling({ targetRef: 'job:j7' });

  const linked = store.graph.linkWorkItemFiling('job:j7', 'issue:314');
  assert.equal(linked?.status, 'filed');
  assert.equal(linked?.ticketRef, 'issue:314');

  assert.equal(store.graph.linkWorkItemFiling('job:j7', 'issue:999'), null, 'a settled filing is not re-settled');
  assert.equal(store.graph.listWorkItemFilings()[0]?.ticketRef, 'issue:314');
  store.close();
});

test('a claim whose create failed is released, so the button comes back', () => {
  const store = new Store(':memory:');
  store.graph.createWorkItemFiling({ targetRef: 'job:j7' });
  store.graph.dropWorkItemFiling('job:j7');
  assert.equal(store.graph.listWorkItemFilings().length, 0, 'no filing stands for a ticket that was never created');
  assert.equal(store.graph.createWorkItemFiling({ targetRef: 'job:j7' })?.status, 'filing');

  store.graph.linkWorkItemFiling('job:j7', 'issue:314');
  store.graph.dropWorkItemFiling('job:j7');
  assert.equal(store.graph.listWorkItemFilings()[0]?.ticketRef, 'issue:314');
  store.close();
});

test('a node that is filing nothing resolves to no filing', () => {
  const store = new Store(':memory:');
  assert.equal(store.graph.linkWorkItemFiling('job:unrelated', 'issue:314'), null);
  store.close();
});

test('listWorkNodes reads the whole table, roots and descendants alike', () => {
  const store = new Store(':memory:');
  store.graph.recordWorkGraph(
    foldWorkGraph(
      input({ world: world({ issues: [issue({ linkedPrNumber: 41 })], pullRequests: [pr()] }), jobs: [job()] }),
    ),
  );
  assert.deepEqual(
    store.graph
      .listWorkNodes()
      .map((n) => n.ref)
      .sort(),
    ['issue:12', 'job:j7', 'pr:41'],
    'the detector needs descendants, which listWorkRoots cannot give it',
  );
  store.close();
});

function recorded(over: Partial<WorkGraphInput> = {}): { store: Store; nodes: WorkNode[] } {
  const store = new Store(':memory:');
  store.graph.recordWorkGraph(foldWorkGraph(input(over)));
  return { store, nodes: store.graph.listWorkNodes() };
}

test('a dispatched code job with no work item behind it is unrecorded', () => {
  const { store, nodes } = recorded({ world: world({ pullRequests: [pr()] }), jobs: [job()] });
  const found = unrecordedWork(nodes, [job()], []);
  assert.deepEqual(
    found.map((u) => u.ref),
    ['job:j7'],
  );
  assert.equal(found[0]?.prCount, 1, 'the evidence rides beside the verdict');
  assert.equal(found[0]?.filing, null, 'nothing in flight, so the button is live');
  store.close();
});

test('a job that produced no PR is still unrecorded — the evidence is not the predicate', () => {
  const { store, nodes } = recorded({ jobs: [job()] });
  const found = unrecordedWork(nodes, [job()], []);
  assert.deepEqual(
    found.map((u) => u.ref),
    ['job:j7'],
    'requiring a PR would only ever record work already visible',
  );
  assert.equal(found[0]?.prCount, 0);
  store.close();
});

test('the narrowings: desk, queued, cancelled and adopted jobs are not unrecorded', () => {
  for (const [label, j] of [
    ['a desk job touches no repository', job({ kind: 'desk' })],
    ['a queued job has done nothing yet', job({ status: 'queued' })],
    ['a cancelled job never will', job({ status: 'cancelled' })],
  ] as const) {
    const { store, nodes } = recorded({ jobs: [j] });
    assert.deepEqual(unrecordedWork(nodes, [j], []), [], label);
    store.close();
  }

  const { store, nodes } = recorded({
    world: world({ issues: [issue({ linkedPrNumber: 41 })], pullRequests: [pr()] }),
    jobs: [job()],
  });
  assert.deepEqual(unrecordedWork(nodes, [job()], []), [], 'a parented job has a work item already');
  store.close();
});

test('a filing in flight keeps the node listed, carrying its status', () => {
  const { store, nodes } = recorded({ jobs: [job()] });
  const filing = store.graph.createWorkItemFiling({ targetRef: 'job:j7' });
  assert.ok(filing);
  const found = unrecordedWork(nodes, [job()], store.graph.listWorkItemFilings());
  assert.equal(found[0]?.filing, 'filing', 'dropping it would make the click look like it did nothing');
  store.close();
});

test('an ignored node stays in the set, carrying the verdict rather than being filtered out', () => {
  const { store, nodes } = recorded({ jobs: [job()] });
  store.graph.ignoreWorkItem('job:j7');
  const found = unrecordedWork(nodes, [job()], [], store.graph.listWorkItemIgnores());
  assert.equal(found.length, 1, 'filtering here would leave the panel and the file route disagreeing');
  assert.equal(found[0]?.ignored, true);
  assert.equal(found[0]?.title, 'Bump the linter', 'the row keeps its title, so the un-ignore has something to offer');

  store.graph.unignoreWorkItem('job:j7');
  assert.equal(
    unrecordedWork(nodes, [job()], [], store.graph.listWorkItemIgnores())[0]?.ignored,
    false,
    'the undo is a delete — one representation of "not ignored"',
  );
  store.close();
});

test('ignoring twice is one row, and un-ignoring what was never ignored is silent', () => {
  const store = new Store(':memory:');
  store.graph.ignoreWorkItem('job:j7');
  store.graph.ignoreWorkItem('job:j7');
  assert.deepEqual(store.graph.listWorkItemIgnores(), ['job:j7'], 'the refusal lives in the write');
  store.graph.unignoreWorkItem('job:nope');
  assert.deepEqual(store.graph.listWorkItemIgnores(), ['job:j7']);
  store.close();
});

test('the ticket prompt names the tracker, the ref and what the work produced', () => {
  const { store } = recorded({ world: world({ pullRequests: [pr()] }), jobs: [job()] });
  store.graph.recordWorkGraph(
    foldWorkGraph(
      input({
        world: world({ closedPullRequests: [pr({ merged: true, state: 'merged' })] }),
        jobs: [job()],
        existing: store.graph.listWorkNodes(),
      }),
    ),
  );
  const node = store.graph.listWorkNodes().find((n) => n.ref === 'job:j7');
  assert.ok(node);
  const fields = workItemTicketFields(node, store.graph.listWorkSubtree('job:j7'));
  assert.match(fields.title, /Bump the linter/);
  assert.equal(fields.vars.ref, 'job:j7');
  assert.match(fields.vars.produced ?? '', /pr:41/, 'the PR it produced is in the body');

  const rendered = defaultPromptTemplates().render('work-item-ticket-body', fields.vars);
  assert.match(rendered, /records work the harness has already done/i);
  assert.match(rendered, /pr:41/);
  assert.doesNotMatch(rendered, /link_ticket|do not do it again/i);
  store.close();
});

test('a job that produced nothing says so in the prompt rather than leaving a blank', () => {
  const { store, nodes } = recorded({ jobs: [job()] });
  const node = nodes.find((n) => n.ref === 'job:j7');
  assert.ok(node);
  const fields = workItemTicketFields(node, store.graph.listWorkSubtree('job:j7'));
  assert.match(fields.vars.produced ?? '', /no pull request/i);
  store.close();
});

function filing(over: Partial<WorkItemFiling> = {}): WorkItemFiling {
  return {
    targetRef: 'job:j7',
    status: 'filed',
    ticketRef: 'issue:314',
    createdAt: '2026-07-28T09:00:00.000Z',
    updatedAt: '2026-07-28T09:00:00.000Z',
    ...over,
  };
}

test('a linked filing parents its node to the ticket', () => {
  const out = foldWorkGraph(input({ jobs: [job()], filings: [filing()] }));
  assert.equal(node(out, 'job:j7').parentRef, 'issue:314');
});

test('a filing still in flight attaches nothing', () => {
  const out = foldWorkGraph(input({ jobs: [job()], filings: [filing({ status: 'filing', ticketRef: null })] }));
  assert.equal(node(out, 'job:j7').parentRef, null, 'the ticket does not exist yet');
});

test('a ticket the world never lists still leaves its work reachable', () => {
  const store = new Store(':memory:');
  store.graph.recordWorkGraph(foldWorkGraph(input({ jobs: [job()], filings: [filing()] })));

  assert.deepEqual(
    store.graph
      .listWorkRoots()
      .map((n) => n.ref)
      .sort(),
    ['issue:314'],
    'the ticket is the root, and the job is no longer one',
  );
  assert.deepEqual(
    store.graph.listWorkSubtree('issue:314').map((n) => n.ref),
    ['issue:314', 'job:j7'],
    'the whole tree hangs off the filed work item',
  );
  store.close();
});

test("the world's own issue row wins the title over a placeholder", () => {
  const out = foldWorkGraph(
    input({
      world: world({ issues: [issue({ id: 'i314', number: 314, title: 'Bump the linter' })] }),
      jobs: [job()],
      filings: [filing()],
    }),
  );
  assert.equal(node(out, 'issue:314').title, 'Bump the linter', 'a placeholder must never clobber the real reading');
  assert.equal(out.filter((n) => n.ref === 'issue:314').length, 1, 'and only one node is emitted for it');
});

test('the placeholder is first sight only: a stored ticket node is never overwritten', () => {
  const store = new Store(':memory:');
  const listed = issue({ id: 'i314', number: 314, title: 'Bump the linter' });
  const pulse = (over: Partial<WorkGraphInput> = {}) =>
    store.graph.recordWorkGraph(
      foldWorkGraph(input({ jobs: [job()], filings: [filing()], existing: store.graph.listWorkNodes(), ...over })),
    );

  pulse({ world: world({ issues: [listed] }) });
  pulse({ world: world({ issues: [issue({ id: 'i314', number: 314, title: 'Bump the linter', state: 'closed' })] }) });
  pulse();
  pulse();

  const node314 = store.graph.listWorkNodes().find((n) => n.ref === 'issue:314');
  assert.equal(node314?.title, 'Bump the linter', 'the observed title survives every later absence');
  assert.equal(node314?.status, 'closed', 'as does the tracker status the harness read and never computes');
  assert.equal(node314?.terminal, true);
  store.close();
});

test('a linked filing re-emits a node whose job has aged out of the fold', () => {
  const prior: WorkNode = {
    ref: 'job:j7',
    kind: 'job',
    parentRef: null,
    baseRef: null,
    title: 'Bump the linter',
    status: 'dispatched',
    terminal: false,
    provenance: null,
    firstSeenAt: '2026-07-28T09:00:00.000Z',
    lastSeenAt: '2026-07-28T09:00:00.000Z',
  };
  const out = foldWorkGraph(input({ jobs: [], filings: [filing()], existing: [prior] }));
  assert.equal(node(out, 'job:j7').parentRef, 'issue:314');
  assert.equal(node(out, 'job:j7').title, 'Bump the linter', 're-emitted verbatim, not invented');
});

test('the fold is the only writer: a second filing cannot re-parent an adopted node', () => {
  const store = new Store(':memory:');
  store.graph.recordWorkGraph(foldWorkGraph(input({ jobs: [job()], filings: [filing()] })));
  store.graph.recordWorkGraph(foldWorkGraph(input({ jobs: [job()], filings: [filing({ ticketRef: 'issue:999' })] })));
  assert.equal(
    store.graph.listWorkNodes().find((n) => n.ref === 'job:j7')?.parentRef,
    'issue:314',
    'parent_ref is write-once once non-null, which is what stops this ever being redone',
  );
  store.close();
});

function buildServed(over: Record<string, unknown> = {}) {
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    dbPath: ':memory:',
    labelPrefix: '',
    agentMode: 'raw',
    heartbeatIntervalMs: 999_999,
    startPaused: true,
    ...over,
  });
  return buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
}

function buildWithTracker(): ReturnType<typeof buildSystem> {
  const system = buildServed();
  system.config.integrations.issues = 'github';
  system.config.github = { owner: 'a', repo: 'b' };
  return system;
}

async function dispatchedJob(system: ReturnType<typeof buildSystem>) {
  const job = system.store.jobs.createJob({ title: 'Bump the linter', prompt: 'bump it', kind: 'code' });
  system.store.jobs.markJobDispatched(job.id, 't-stub');
  await system.harness.runCycle('manual');
  return job;
}

test('the roots route reports unrecorded work beside the roots', async () => {
  const system = buildServed();
  const job = await dispatchedJob(system);

  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'GET', url: '/api/work' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { unrecorded: { ref: string; filing: string | null }[] };
  assert.deepEqual(
    body.unrecorded.map((u) => u.ref),
    [`job:${job.id}`],
  );
  assert.equal(body.unrecorded[0]?.filing, null);
  await app.close();
  system.store.close();
});

test('filing creates the work item there and then, and a second click is refused', async () => {
  const system = buildWithTracker();
  const job = await dispatchedJob(system);
  const ref = `job:${job.id}`;

  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'POST', url: `/api/work/${ref}/file` });
  assert.equal(res.statusCode, 200);
  const filed = res.json() as { job?: unknown; filing: { status: string; ticketRef: string | null } };

  assert.equal(filed.job, undefined);
  assert.equal(system.store.jobs.listJobs().filter((j) => j.kind === 'desk').length, 0);
  assert.equal(filed.filing.status, 'filed');
  assert.ok(filed.filing.ticketRef?.startsWith('issue:'));

  const again = await app.inject({ method: 'POST', url: `/api/work/${ref}/file` });
  assert.equal(again.statusCode, 409, 'the node already has a work item');

  const listed = await app.inject({ method: 'GET', url: '/api/work' });
  assert.deepEqual((listed.json() as { unrecorded: { ref: string }[] }).unrecorded, []);
  assert.equal(system.store.graph.listWorkNodes().find((n) => n.ref === ref)?.parentRef, filed.filing.ticketRef);
  await app.close();
  system.store.close();
});

test('the route refuses an unknown ref, work that is already recorded, and a missing tracker', async () => {
  const system = buildServed();
  const job = await dispatchedJob(system);
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Widget' });
  await system.harness.runCycle('manual');
  const { app } = await buildApp(system);

  assert.equal((await app.inject({ method: 'POST', url: '/api/work/job:nope/file' })).statusCode, 404, 'no such node');

  const recordedIssue = await app.inject({ method: 'POST', url: '/api/work/issue:12/file' });
  assert.equal(recordedIssue.statusCode, 409);
  assert.match((recordedIssue.json() as { error: string }).error, /not unrecorded work/);

  const res = await app.inject({ method: 'POST', url: `/api/work/job:${job.id}/file` });
  assert.equal(res.statusCode, 409);
  assert.match((res.json() as { error: string }).error, /no issue tracker is configured/);
  await app.close();
  system.store.close();
});

test('ignoring a node clears it from the list, survives a re-read, and refuses a filing', async () => {
  const system = buildServed();
  const job = await dispatchedJob(system);
  const ref = `job:${job.id}`;
  const { app } = await buildApp(system);

  assert.equal((await app.inject({ method: 'POST', url: '/api/work/job:nope/ignore' })).statusCode, 404);

  assert.equal((await app.inject({ method: 'POST', url: `/api/work/${ref}/ignore` })).statusCode, 200);
  const listed = await app.inject({ method: 'GET', url: '/api/work' });
  const body = listed.json() as { unrecorded: { ref: string; ignored: boolean }[] };
  assert.deepEqual(
    body.unrecorded.map((u) => [u.ref, u.ignored]),
    [[ref, true]],
    'still reported, so the panel can offer the un-ignore — it is the panel that hides it',
  );

  const filed = await app.inject({ method: 'POST', url: `/api/work/${ref}/file` });
  assert.equal(filed.statusCode, 409);
  assert.match((filed.json() as { error: string }).error, /ignored/);

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/work/${ref}/ignore` })).statusCode, 200);
  const after = await app.inject({ method: 'GET', url: '/api/work' });
  assert.equal((after.json() as { unrecorded: { ignored: boolean }[] }).unrecorded[0]?.ignored, false);
  await app.close();
  system.store.close();
});

test('filing parents the work to its new item on the next pulse', async () => {
  const system = buildWithTracker();
  const worked = await dispatchedJob(system);
  const { app } = await buildApp(system);
  const filed = await app.inject({ method: 'POST', url: `/api/work/job:${worked.id}/file` });
  const { filing } = filed.json() as { filing: { ticketRef: string } };

  await system.harness.runCycle('manual');
  assert.equal(
    system.store.graph.listWorkNodes().find((n) => n.ref === `job:${worked.id}`)?.parentRef,
    filing.ticketRef,
    'the fold writes the edge, not the route',
  );
  await app.close();
  system.store.close();
});

test('an agent on an unrelated job can link nothing, and is told which jobs can', () => {
  const system = buildServed();
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: 'Something else',
    prompt: 'do it',
    branch: 'issue/12',
    originRef: 'issue:12',
  });
  const agent = system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));

  const res = system.agents.linkTicket(agent.id, 'issue:314');
  assert.equal(res.ok, false);
  assert.match(res.ok === false ? res.error : '', /raise a bug/);
  system.store.close();
});

test('adoption is write-once: a later fold never re-parents a job', () => {
  const store = new Store(':memory:');
  const adopted = foldWorkGraph(
    input({ world: world({ issues: [issue({ linkedPrNumber: 41 })], pullRequests: [pr()] }), jobs: [job()] }),
  );
  store.graph.recordWorkGraph(adopted);
  assert.equal(store.graph.listWorkSubtree('issue:12').find((n) => n.ref === 'job:j7')?.parentRef, 'issue:12');

  store.graph.recordWorkGraph(foldWorkGraph(input({ world: world({ pullRequests: [pr()] }), jobs: [job()] })));
  assert.equal(
    store.graph.listWorkSubtree('issue:12').find((n) => n.ref === 'job:j7')?.parentRef,
    'issue:12',
    'a null parent from the fold never undoes an adoption',
  );
  store.close();
});
