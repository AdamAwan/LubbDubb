import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { PlanReconciler } from '../src/plans/planReconciler.js';
import { renderPlanComment } from '../src/plans/planComment.js';
import { DEFAULT_PLANNING } from '../src/plans/planning.js';
import type { ActionSink, IssueCommentInput, SendResult } from '../src/sink/actionSink.js';
import type { ErrorLogEntry, ErrorLogInput, PullRequest, WorldSnapshot } from '../src/types.js';

/** A sink that records the plan's status comment and refuses everything else. */
function recordingSink(): { sink: ActionSink; comments: IssueCommentInput[] } {
  const comments: IssueCommentInput[] = [];
  const unused = async (): Promise<SendResult> => {
    throw new Error('not used by reconciliation');
  };
  return {
    comments,
    sink: {
      postPrReply: unused,
      mergePr: unused,
      setPrLabel: unused,
      setIssueLabel: unused,
      setStoryLabel: unused,
      setWorkItemState: unused,
      async upsertIssueComment(input): Promise<SendResult> {
        comments.push(input);
        // The provider hands back a stable id; the reconciler must reuse it.
        return { ok: true, ref: input.commentRef ?? 'comment_1' };
      },
    },
  };
}

function world(pullRequests: PullRequest[] = []): WorldSnapshot {
  return { takenAt: '2026-07-25T12:00:00.000Z', pullRequests, issues: [], stories: [] };
}

function pr(number: number, branch: string, overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: `pr_${number}`,
    number,
    title: `PR ${number}`,
    branch,
    ciStatus: 'passing',
    unresolvedComments: [],
    ...overrides,
  };
}

interface Harness {
  store: Store;
  git: FakeGitObserver;
  comments: IssueCommentInput[];
  errors: ErrorLogInput[];
  reconciler: PlanReconciler;
  planId: string;
}

/** A plan for issue 12 with a two-part stack: `api` depends on `schema`. */
function setup(): Harness {
  const store = new Store(':memory:');
  const git = new FakeGitObserver();
  const { sink, comments } = recordingSink();
  const errors: ErrorLogInput[] = [];
  const plan = store.upsertPlan({
    originRef: 'issue:12',
    title: 'Big thing',
    status: 'active',
    reason: 'Schema first.',
  });
  store.upsertPlanParts(plan.id, [
    { slug: 'schema', seq: 1, title: 'Schema', scope: 'src/store/', dependsOn: [], rationale: null, acceptance: null },
    {
      slug: 'api',
      seq: 2,
      title: 'API',
      scope: 'src/server/',
      dependsOn: ['schema'],
      rationale: null,
      acceptance: null,
    },
  ]);
  const reconciler = new PlanReconciler({
    store,
    git,
    sink,
    planning: { ...DEFAULT_PLANNING, enabled: true },
    defaultBranch: 'main',
    errors: { record: (entry) => (errors.push(entry), {}) as ErrorLogEntry },
  });
  return { store, git, comments, errors, reconciler, planId: plan.id };
}

function statuses(h: Harness): [string, string][] {
  return h.store.listPlanParts(h.planId).map((p) => [p.slug, p.status]);
}

test('a part with no dependency is ready; its dependent waits until the branch carries work', async () => {
  const h = setup();
  await h.reconciler.reconcile(world());
  assert.deepEqual(statuses(h), [
    ['schema', 'ready'],
    ['api', 'pending'],
  ]);

  // The dependency is dispatched but has pushed nothing — basing on an empty
  // branch gains nothing, so the dependent stays pending.
  const schema = h.store.listPlanParts(h.planId)[0]!;
  const agentTask = h.store.createTask({
    kind: 'code',
    title: 'Schema',
    prompt: 'p',
    branch: 'issue/12/schema',
    originRef: 'issue:12:part:schema',
  });
  h.store.markPartDispatched(schema.id, agentTask.id, 'issue/12/schema');
  await h.reconciler.reconcile(world());
  assert.deepEqual(
    statuses(h).find(([slug]) => slug === 'api'),
    ['api', 'pending'],
  );

  // Git — the only source that sees a branch before a PR exists — says it has
  // commits now. That is what a stacked part waits on.
  h.git.setDivergence('issue/12/schema', 'main', { ahead: 2, behind: 0 });
  await h.reconciler.reconcile(world());
  assert.deepEqual(
    statuses(h).find(([slug]) => slug === 'api'),
    ['api', 'ready'],
  );
});

test('the provider decides PR and merge state; git never claims a merge', async () => {
  const h = setup();
  h.git.setDivergence('issue/12/schema', 'main', { ahead: 1, behind: 0 });
  await h.reconciler.reconcile(world([pr(40, 'issue/12/schema')]));
  const [schema] = h.store.listPlanParts(h.planId);
  assert.equal(schema?.status, 'in_review');
  assert.equal(schema?.prNumber, 40);
  assert.equal(schema?.branch, 'issue/12/schema', 'the branch is backfilled from the PR that appeared on it');

  // A squash-merged branch has no ancestry link to its base, so `hasCommitsBeyond`
  // still reads true — merge has to come from the provider, and does.
  await h.reconciler.reconcile(world([pr(40, 'issue/12/schema', { merged: true })]));
  assert.equal(h.store.listPlanParts(h.planId)[0]?.status, 'merged');
});

test('a PR that has left the open list is read as merged', async () => {
  // Both real providers list only open PRs, so a merged PR simply disappears —
  // the same reading `openPrForIssue` already relies on.
  const h = setup();
  await h.reconciler.reconcile(world([pr(40, 'issue/12/schema')]));
  assert.equal(h.store.listPlanParts(h.planId)[0]?.status, 'in_review');
  await h.reconciler.reconcile(world());
  assert.equal(h.store.listPlanParts(h.planId)[0]?.status, 'merged');
});

test('a dispatched part whose agent is gone without a PR goes back to ready', async () => {
  const h = setup();
  await h.reconciler.reconcile(world());
  const schema = h.store.listPlanParts(h.planId)[0]!;
  const task = h.store.createTask({
    kind: 'code',
    title: 'part',
    prompt: 'p',
    branch: 'issue/12/schema',
    originRef: 'issue:12:part:schema',
  });
  h.store.markPartDispatched(schema.id, task.id, 'issue/12/schema');

  await h.reconciler.reconcile(world());
  assert.equal(h.store.listPlanParts(h.planId)[0]?.status, 'dispatched', 'a live task keeps the part staffed');

  h.store.updateTask(task.id, { status: 'done' });
  await h.reconciler.reconcile(world());
  assert.equal(
    h.store.listPlanParts(h.planId)[0]?.status,
    'ready',
    'so the per-part cooldown governs the retry, and the attempt cap eventually escalates',
  );
});

test('every part merged rolls the plan up to complete', async () => {
  const h = setup();
  const [schema, api] = h.store.listPlanParts(h.planId);
  h.store.updatePlanPart(schema!.id, { status: 'merged' });
  await h.reconciler.reconcile(world());
  assert.equal(h.store.getPlanByOrigin('issue:12')?.status, 'active');

  h.store.updatePlanPart(api!.id, { status: 'merged' });
  await h.reconciler.reconcile(world());
  assert.equal(h.store.getPlanByOrigin('issue:12')?.status, 'complete');
  // Completion goes no further than review: no issue close, ever.
  const body = h.comments.at(-1)?.body ?? '';
  assert.match(body, /Plan complete/);
  assert.match(body, /Closing it is a human decision/);
});

test('the status comment is written once and then edited in place, only when there is news', async () => {
  const h = setup();
  await h.reconciler.reconcile(world());
  assert.equal(h.comments.length, 1, 'the plan appearing is news');
  assert.equal(h.comments[0]?.commentRef, null, 'the first write creates the comment');

  // Nothing changed — reconciliation is idempotent, so it must not rewrite.
  await h.reconciler.reconcile(world());
  assert.equal(h.comments.length, 1);

  await h.reconciler.reconcile(world([pr(40, 'issue/12/schema')]));
  assert.equal(h.comments.length, 2, 'a part moving is news');
  assert.equal(h.comments[1]?.commentRef, 'comment_1', 'edited in place — one living comment, not a stream');
  assert.equal(h.store.getPlanByOrigin('issue:12')?.statusCommentRef, 'comment_1');
});

test('an existing issue/<n> branch blocks the parts, and says so', async () => {
  // Refs are files: `refs/heads/issue/12` and `refs/heads/issue/12/schema` cannot
  // coexist. An issue worked as `single` first and later replanned hits exactly this.
  const h = setup();
  h.git.setPresence('issue/12', { local: true });
  await h.reconciler.reconcile(world());
  assert.deepEqual(statuses(h), [
    ['schema', 'blocked'],
    ['api', 'blocked'],
  ]);
  assert.match(h.errors[0]?.message ?? '', /the branch issue\/12 exists/);
  assert.equal(h.errors.length, 1, 'said once, on the transition — not every pulse');

  // Recovery is just deleting the branch; the next pulse un-blocks the parts.
  h.git.setPresence('issue/12', { local: false });
  await h.reconciler.reconcile(world());
  assert.deepEqual(statuses(h), [
    ['schema', 'ready'],
    ['api', 'pending'],
  ]);
});

test('reconciliation is inert with the funnel off', async () => {
  const store = new Store(':memory:');
  const { sink, comments } = recordingSink();
  const plan = store.upsertPlan({ originRef: 'issue:12', title: 'Big thing', status: 'active', reason: null });
  store.upsertPlanParts(plan.id, [
    { slug: 'a', seq: 1, title: 'A', scope: 'src/', dependsOn: [], rationale: null, acceptance: null },
  ]);
  const reconciler = new PlanReconciler({
    store,
    git: new FakeGitObserver(),
    sink,
    planning: DEFAULT_PLANNING,
    defaultBranch: 'main',
  });
  await reconciler.reconcile(world());
  assert.equal(store.listPlanParts(plan.id)[0]?.status, 'pending');
  assert.equal(comments.length, 0);
  store.close();
});

test('the rendered comment reports progress and the PR numbers', () => {
  const store = new Store(':memory:');
  const plan = store.upsertPlan({
    originRef: 'issue:12',
    title: 'Big thing',
    status: 'active',
    reason: 'Schema first.',
  });
  const parts = store.upsertPlanParts(plan.id, [
    { slug: 'schema', seq: 1, title: 'Schema', scope: 'src/store/', dependsOn: [], rationale: null, acceptance: null },
    {
      slug: 'api',
      seq: 2,
      title: 'API',
      scope: 'src/server/',
      dependsOn: ['schema'],
      rationale: null,
      acceptance: null,
    },
  ]);
  store.updatePlanPart(parts[0]!.id, { status: 'merged', prNumber: 40 });
  const body = renderPlanComment(plan, store.listPlanParts(plan.id));
  assert.match(body, /1\/2 parts merged/);
  assert.match(body, /Schema first\./);
  assert.match(body, /\[x\] \*\*Schema\*\* \(`schema`\) — merged · PR #40/);
  assert.match(body, /\[ \] \*\*API\*\*/);
  store.close();
});
