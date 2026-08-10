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

// Stage 3: the roots that had no work item behind them. Adoption first (this
// file's opening block) — the two arms that make "unparented PR" name one
// population instead of two — then the filing record that gives what is left a
// tracker item.

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

// ---------------------------------------------------------------------------
// jobBranch — one predicate, two callers
// ---------------------------------------------------------------------------

test('jobBranch derives job/<id> for a code job and refuses a desk one', () => {
  assert.equal(jobBranch(job()), 'job/j7', 'the derived branch is what rule `manual-job` dispatches on');
  assert.equal(jobBranch(job({ branch: 'chore/lint' })), 'chore/lint', "an operator's branch wins");
  assert.equal(jobBranch(job({ kind: 'desk' })), null, 'a desk job runs in a scratch dir and has no branch');
});

// ---------------------------------------------------------------------------
// Arm A — a job owns the PR its own branch carries
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Arm B — a job is adopted by the issue its own PR names
// ---------------------------------------------------------------------------

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
  // Both signals present. The branch match says what *caused* the PR;
  // `linkedPrNumber` says what it is *about*. Taking either alone loses an edge —
  // together they give the whole chain.
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
  // `issue/<n>` and `job/<id>` cannot collide, so the issue arm is untouched.
  const out = foldWorkGraph(
    input({
      world: world({ issues: [issue()], pullRequests: [pr({ branch: 'issue/12' })] }),
      jobs: [job()],
    }),
  );
  assert.equal(node(out, 'pr:41').parentRef, 'issue:12');
});

// ---------------------------------------------------------------------------
// The filing record
// ---------------------------------------------------------------------------

test('a filing is opened once per node — a second click is refused by the write', () => {
  const store = new Store(':memory:');
  const first = store.createWorkItemFiling({ targetRef: 'job:j7', jobId: 'job_file1' });
  assert.equal(first?.status, 'filing');
  assert.equal(first?.ticketRef, null, 'the ticket does not exist yet — that is what filing means');

  assert.equal(
    store.createWorkItemFiling({ targetRef: 'job:j7', jobId: 'job_file2' }),
    null,
    'the refusal is the primary key, not a caller remembering to look',
  );
  assert.equal(store.listWorkItemFilings().length, 1);
  store.close();
});

test('linking settles a filing exactly once', () => {
  const store = new Store(':memory:');
  store.createWorkItemFiling({ targetRef: 'job:j7', jobId: 'job_file1' });

  const linked = store.linkWorkItemFiling('job_file1', 'issue:314');
  assert.equal(linked?.status, 'filed');
  assert.equal(linked?.ticketRef, 'issue:314');

  assert.equal(
    store.linkWorkItemFiling('job_file1', 'issue:999'),
    null,
    'an agent that calls link_ticket twice links once',
  );
  assert.equal(store.findWorkItemFilingByJobId('job_file1')?.ticketRef, 'issue:314');
  store.close();
});

test('a job that is filing nothing resolves to no filing', () => {
  const store = new Store(':memory:');
  assert.equal(store.findWorkItemFilingByJobId('job_unrelated'), null);
  assert.equal(store.linkWorkItemFiling('job_unrelated', 'issue:314'), null);
  store.close();
});

test('listWorkNodes reads the whole table, roots and descendants alike', () => {
  const store = new Store(':memory:');
  store.recordWorkGraph(
    foldWorkGraph(
      input({ world: world({ issues: [issue({ linkedPrNumber: 41 })], pullRequests: [pr()] }), jobs: [job()] }),
    ),
  );
  assert.deepEqual(
    store
      .listWorkNodes()
      .map((n) => n.ref)
      .sort(),
    ['issue:12', 'job:j7', 'pr:41'],
    'the detector needs descendants, which listWorkRoots cannot give it',
  );
  store.close();
});

// ---------------------------------------------------------------------------
// The detector
// ---------------------------------------------------------------------------

/** Record a fold and read the whole table back — what the route hands the detector. */
function recorded(over: Partial<WorkGraphInput> = {}): { store: Store; nodes: WorkNode[] } {
  const store = new Store(':memory:');
  store.recordWorkGraph(foldWorkGraph(input(over)));
  return { store, nodes: store.listWorkNodes() };
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

  // Adopted by arm B: a work item for this work already exists.
  const { store, nodes } = recorded({
    world: world({ issues: [issue({ linkedPrNumber: 41 })], pullRequests: [pr()] }),
    jobs: [job()],
  });
  assert.deepEqual(unrecordedWork(nodes, [job()], []), [], 'a parented job has a work item already');
  store.close();
});

test('a filing in flight keeps the node listed, carrying its status', () => {
  const { store, nodes } = recorded({ jobs: [job()] });
  const filing = store.createWorkItemFiling({ targetRef: 'job:j7', jobId: 'job_file1' });
  assert.ok(filing);
  const found = unrecordedWork(nodes, [job()], store.listWorkItemFilings());
  assert.equal(found[0]?.filing, 'filing', 'dropping it would make the click look like it did nothing');
  store.close();
});

test('an ignored node stays in the set, carrying the verdict rather than being filtered out', () => {
  const { store, nodes } = recorded({ jobs: [job()] });
  store.ignoreWorkItem('job:j7');
  const found = unrecordedWork(nodes, [job()], [], store.listWorkItemIgnores());
  assert.equal(found.length, 1, 'filtering here would leave the panel and the file route disagreeing');
  assert.equal(found[0]?.ignored, true);
  assert.equal(found[0]?.title, 'Bump the linter', 'the row keeps its title, so the un-ignore has something to offer');

  store.unignoreWorkItem('job:j7');
  assert.equal(
    unrecordedWork(nodes, [job()], [], store.listWorkItemIgnores())[0]?.ignored,
    false,
    'the undo is a delete — one representation of "not ignored"',
  );
  store.close();
});

test('ignoring twice is one row, and un-ignoring what was never ignored is silent', () => {
  const store = new Store(':memory:');
  store.ignoreWorkItem('job:j7');
  store.ignoreWorkItem('job:j7');
  assert.deepEqual(store.listWorkItemIgnores(), ['job:j7'], 'the refusal lives in the write');
  store.unignoreWorkItem('job:nope');
  assert.deepEqual(store.listWorkItemIgnores(), ['job:j7']);
  store.close();
});

test('the ticket prompt names the tracker, the ref and what the work produced', () => {
  // Open first, then merged — a PR is parented while it is in the open list, and
  // the write-once parent is what carries the edge past the merge.
  const { store } = recorded({ world: world({ pullRequests: [pr()] }), jobs: [job()] });
  store.recordWorkGraph(
    foldWorkGraph(
      input({
        world: world({ closedPullRequests: [pr({ merged: true, state: 'merged' })] }),
        jobs: [job()],
        existing: store.listWorkNodes(),
      }),
    ),
  );
  const node = store.listWorkNodes().find((n) => n.ref === 'job:j7');
  assert.ok(node);
  const fields = workItemTicketFields(node, store.listWorkSubtree('job:j7'), 'the GitHub repository a/b');
  assert.match(fields.title, /Bump the linter/);
  assert.equal(fields.vars.ref, 'job:j7');
  assert.match(fields.vars.produced ?? '', /pr:41/, 'the PR it produced is in the body');
  assert.match(fields.vars.tracker ?? '', /the GitHub repository a\/b/);

  const rendered = defaultPromptTemplates().render('work-item-ticket', fields.vars);
  assert.match(rendered, /do not\s+do it again/i, 'the agent must record the work, not redo it');
  assert.match(rendered, /link_ticket/, 'and must close the loop');
  store.close();
});

test('a job that produced nothing says so in the prompt rather than leaving a blank', () => {
  const { store, nodes } = recorded({ jobs: [job()] });
  const node = nodes.find((n) => n.ref === 'job:j7');
  assert.ok(node);
  const fields = workItemTicketFields(node, store.listWorkSubtree('job:j7'), 'somewhere');
  assert.match(fields.vars.produced ?? '', /no pull request/i);
  store.close();
});

// ---------------------------------------------------------------------------
// The fold learns the parent from a linked filing
// ---------------------------------------------------------------------------

/** A filing row as the store hands one back, without needing a store. */
function filing(over: Partial<WorkItemFiling> = {}): WorkItemFiling {
  return {
    targetRef: 'job:j7',
    jobId: 'job_file1',
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
  // The issue provider lists open items in one repository; a ticket closed
  // straight away, or filed into another project, is never fetched. Without a
  // placeholder the adopted job would be reachable from nowhere at all.
  const store = new Store(':memory:');
  store.recordWorkGraph(foldWorkGraph(input({ jobs: [job()], filings: [filing()] })));

  assert.deepEqual(
    store
      .listWorkRoots()
      .map((n) => n.ref)
      .sort(),
    ['issue:314'],
    'the ticket is the root, and the job is no longer one',
  );
  assert.deepEqual(
    store.listWorkSubtree('issue:314').map((n) => n.ref),
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

test('a linked filing re-emits a node whose job has aged out of the fold', () => {
  // `listJobs` is windowed, so an old job emits nothing this pulse. The adoption
  // must not be lost with it — `existing` is already in the input and carries it.
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
  store.recordWorkGraph(foldWorkGraph(input({ jobs: [job()], filings: [filing()] })));
  store.recordWorkGraph(
    foldWorkGraph(input({ jobs: [job()], filings: [filing({ jobId: 'job_file2', ticketRef: 'issue:999' })] })),
  );
  assert.equal(
    store.listWorkNodes().find((n) => n.ref === 'job:j7')?.parentRef,
    'issue:314',
    'parent_ref is write-once once non-null, which is what stops this ever being redone',
  );
  store.close();
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

/** A harness with an issue tracker configured, so filing has somewhere to go. */
function buildServed(over: Record<string, unknown> = {}) {
  const config = loadConfig({
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

/**
 * Run `fn` with GITHUB_TOKEN present, then restore it — `buildIntegrations`
 * refuses the github provider without one, and these tests want its *coordinates*
 * (which is all `trackerCoordinates` reads), not its network.
 */
async function withGithubToken(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test-token';
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prev;
  }
}

/** Run a code job to `dispatched` — the state that makes it unrecorded work. */
async function dispatchedJob(system: ReturnType<typeof buildSystem>) {
  const job = system.store.createJob({ title: 'Bump the linter', prompt: 'bump it', kind: 'code' });
  system.store.markJobDispatched(job.id, 't-stub');
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

test('filing queues a desk job and opens the filing, and a second click is refused', async () => {
  // `fake` has no tracker to file into, so this is the github-configured path.
  await withGithubToken(async () => {
    const system = buildServed({
      integrations: { source: 'fake', issues: 'github' },
      github: { owner: 'a', repo: 'b' },
    });
    const job = await dispatchedJob(system);
    const ref = `job:${job.id}`;

    const { app } = await buildApp(system);
    const res = await app.inject({ method: 'POST', url: `/api/work/${ref}/file` });
    assert.equal(res.statusCode, 200);
    const filed = res.json() as { job: { kind: string; prompt: string }; filing: { status: string } };
    assert.equal(filed.job.kind, 'desk', 'filing touches no repository — and a desk job is never itself unrecorded');
    assert.match(filed.job.prompt, /a\/b/, 'the coordinates the agent cannot infer');
    assert.equal(filed.filing.status, 'filing');

    const again = await app.inject({ method: 'POST', url: `/api/work/${ref}/file` });
    assert.equal(again.statusCode, 409, 'an agent is already filing this one');

    const listed = await app.inject({ method: 'GET', url: '/api/work' });
    assert.equal(
      (listed.json() as { unrecorded: { filing: string | null }[] }).unrecorded.find((u) => u.filing !== null)?.filing,
      'filing',
      'the node stays listed so the click does not look like it did nothing',
    );
    await app.close();
    system.store.close();
  });
});

test('the route refuses an unknown ref, work that is already recorded, and a missing tracker', async () => {
  const system = buildServed();
  const job = await dispatchedJob(system);
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Widget' });
  await system.harness.runCycle('manual');
  const { app } = await buildApp(system);

  assert.equal((await app.inject({ method: 'POST', url: '/api/work/job:nope/file' })).statusCode, 404, 'no such node');

  // An issue is a work item; it is never unrecorded. Checked ahead of the tracker
  // arm, so this holds even on a deployment with nowhere to file.
  const recordedIssue = await app.inject({ method: 'POST', url: '/api/work/issue:12/file' });
  assert.equal(recordedIssue.statusCode, 409);
  assert.match((recordedIssue.json() as { error: string }).error, /not unrecorded work/);

  // The `fake` provider has nowhere to file into, which is the same predicate
  // `canFileTickets` hides the button on.
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

  // The file route reads the same predicate, so it refuses what the panel no
  // longer offers rather than filing a ticket for work the operator dismissed.
  const filed = await app.inject({ method: 'POST', url: `/api/work/${ref}/file` });
  assert.equal(filed.statusCode, 409);
  assert.match((filed.json() as { error: string }).error, /ignored/);

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/work/${ref}/ignore` })).statusCode, 200);
  const after = await app.inject({ method: 'GET', url: '/api/work' });
  assert.equal((after.json() as { unrecorded: { ignored: boolean }[] }).unrecorded[0]?.ignored, false);
  await app.close();
  system.store.close();
});

// ---------------------------------------------------------------------------
// link_ticket's second arm
// ---------------------------------------------------------------------------

test('a filing agent links its work item, and the next pulse parents the work to it', async () => {
  await withGithubToken(async () => {
    const system = buildServed({
      integrations: { source: 'fake', issues: 'github' },
      github: { owner: 'a', repo: 'b' },
    });
    const worked = await dispatchedJob(system);
    const { app } = await buildApp(system);
    const filed = await app.inject({ method: 'POST', url: `/api/work/job:${worked.id}/file` });
    const filingJob = (filed.json() as { job: { id: string; title: string; prompt: string } }).job;

    // The filing agent, on the filing job's own origin.
    const task = system.store.createTask({
      kind: 'desk',
      title: filingJob.title,
      prompt: filingJob.prompt,
      branch: null,
      originRef: `job:${filingJob.id}`,
    });
    const agent = system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));

    const res = system.agents.linkTicket(agent.id, 'issue:314');
    assert.equal(res.ok, true);
    assert.equal(system.store.findWorkItemFilingByJobId(filingJob.id)?.ticketRef, 'issue:314');

    await system.harness.runCycle('manual');
    assert.equal(
      system.store.listWorkNodes().find((n) => n.ref === `job:${worked.id}`)?.parentRef,
      'issue:314',
      'the fold writes the edge, not the tool',
    );
    await app.close();
    system.store.close();
  });
});

test('a work item must be an issue ref — there is no node kind to guess at', async () => {
  await withGithubToken(async () => {
    const system = buildServed({
      integrations: { source: 'fake', issues: 'github' },
      github: { owner: 'a', repo: 'b' },
    });
    const worked = await dispatchedJob(system);
    const { app } = await buildApp(system);
    const filed = await app.inject({ method: 'POST', url: `/api/work/job:${worked.id}/file` });
    const filingJob = (filed.json() as { job: { id: string } }).job;
    const task = system.store.createTask({
      kind: 'desk',
      title: 'file it',
      prompt: 'file it',
      branch: null,
      originRef: `job:${filingJob.id}`,
    });
    const agent = system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));

    const res = system.agents.linkTicket(agent.id, 'pr:42');
    assert.equal(res.ok, false);
    assert.equal(system.store.findWorkItemFilingByJobId(filingJob.id)?.status, 'filing', 'left awaiting a real item');
    await app.close();
    system.store.close();
  });
});

test('an agent on an unrelated job can link nothing, and is told both reasons', () => {
  const system = buildServed();
  const task = system.store.createTask({
    kind: 'code',
    title: 'Something else',
    prompt: 'do it',
    branch: 'issue/12',
    originRef: 'issue:12',
  });
  const agent = system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));

  const res = system.agents.linkTicket(agent.id, 'issue:314');
  assert.equal(res.ok, false);
  // Identity is the whole access check: there is no argument naming what to link.
  assert.match(res.ok === false ? res.error : '', /file a finding/);
  assert.match(res.ok === false ? res.error : '', /work item/);
  system.store.close();
});

test('adoption is write-once: a later fold never re-parents a job', () => {
  const store = new Store(':memory:');
  const adopted = foldWorkGraph(
    input({ world: world({ issues: [issue({ linkedPrNumber: 41 })], pullRequests: [pr()] }), jobs: [job()] }),
  );
  store.recordWorkGraph(adopted);
  assert.equal(store.listWorkSubtree('issue:12').find((n) => n.ref === 'job:j7')?.parentRef, 'issue:12');

  // The link vanishes from the world — the parent must not follow it.
  store.recordWorkGraph(foldWorkGraph(input({ world: world({ pullRequests: [pr()] }), jobs: [job()] })));
  assert.equal(
    store.listWorkSubtree('issue:12').find((n) => n.ref === 'job:j7')?.parentRef,
    'issue:12',
    'a null parent from the fold never undoes an adoption',
  );
  store.close();
});
