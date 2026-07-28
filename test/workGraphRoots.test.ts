import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Issue, Job, PullRequest, WorkNodeObservation, WorldSnapshot } from '../src/types.js';
import { foldWorkGraph, type WorkGraphInput } from '../src/graph/workGraph.js';
import { jobBranch } from '../src/jobs.js';
import { Store } from '../src/store/store.js';

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
    stories: [],
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
    taskId: 't1',
    createdAt: '2026-07-28T09:00:00.000Z',
    updatedAt: '2026-07-28T09:00:00.000Z',
    ...over,
  };
}

function input(over: Partial<WorkGraphInput> = {}): WorkGraphInput {
  return { world: world(), tasks: [], plans: [], parts: [], jobs: [], existing: [], ...over };
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
  assert.equal(jobBranch(job()), 'job/j7', 'the derived branch is what rule 0 dispatches on');
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
