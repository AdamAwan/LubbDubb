import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { PlanReconciler, refCollisionReason } from '../src/plans/planReconciler.js';
import { renderPlanComment } from '../src/plans/planComment.js';
import { DEFAULT_PLANNING } from '../src/plans/planning.js';
import { bySlug, partBase } from '../src/plans/parts.js';
import type { ActionSink, IssueCommentInput, SendResult } from '../src/sink/actionSink.js';
import type { ErrorLogEntry, ErrorLogInput, PlanPartInput, PullRequest, WorldSnapshot } from '../src/types.js';

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
      setWorkItemState: unused,
      createPullRequest: unused,
      setPullTitle: unused,
      setPullBase: unused,
      async upsertIssueComment(input): Promise<SendResult> {
        comments.push(input);
        // The provider hands back a stable id; the reconciler must reuse it.
        return { ok: true, ref: input.commentRef ?? 'comment_1' };
      },
    },
  };
}

function world(pullRequests: PullRequest[] = []): WorldSnapshot {
  return { takenAt: '2026-07-25T12:00:00.000Z', pullRequests, issues: [] };
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
    {
      slug: 'schema',
      seq: 1,
      title: 'Schema',
      scope: 'src/store/',
      dependsOn: [],
      rationale: null,
      acceptance: null,
      expectedKind: null,
    },
    {
      slug: 'api',
      seq: 2,
      title: 'API',
      scope: 'src/server/',
      dependsOn: ['schema'],
      rationale: null,
      acceptance: null,
      expectedKind: null,
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

test('a plan being delivered whole writes its status comment too', async () => {
  // The bug this closes: the single-PR arm was a `single` plan *status*, and
  // `reconcile` lists `active`/`complete`/`awaiting_approval` — so those plans were
  // never reconciled and never wrote a comment. An issue worked whole told its
  // tracker nothing at all, silently, since there was no failure to record.
  const store = new Store(':memory:');
  const { sink, comments } = recordingSink();
  const plan = store.upsertPlan({
    originRef: 'issue:12',
    title: 'Big thing',
    status: 'active',
    reason: 'One PR is the right shape here.',
  });
  const reconciler = new PlanReconciler({
    store,
    git: new FakeGitObserver(),
    sink,
    planning: { ...DEFAULT_PLANNING, enabled: true },
    defaultBranch: 'main',
  });

  await reconciler.reconcile(world());
  assert.equal(comments.length, 1, 'the plan appearing is news on this arm too');
  // The shape and the reason, not a progress count: rendering the partless arm
  // through the rows said "0/0 parts done" — a progress report on work that was
  // never split.
  assert.match(comments[0]?.body ?? '', /One pull request/);
  assert.match(comments[0]?.body ?? '', /One PR is the right shape here\./);
  assert.doesNotMatch(comments[0]?.body ?? '', /parts? done/);
  assert.equal(store.getPlan(plan.id)?.statusCommentRef, 'comment_1');

  // Its body is the verdict, which nothing but a replan changes, so the body is
  // the news: an unchanged pulse must not rewrite it.
  await reconciler.reconcile(world());
  assert.equal(comments.length, 1);
  store.close();
});

test('an unapproved plan announces nothing, on either shape', async () => {
  const store = new Store(':memory:');
  const { sink, comments } = recordingSink();
  store.upsertPlan({ originRef: 'issue:12', title: 'Big thing', status: 'awaiting_approval', reason: 'One PR.' });
  const reconciler = new PlanReconciler({
    store,
    git: new FakeGitObserver(),
    sink,
    planning: { ...DEFAULT_PLANNING, enabled: true },
    defaultBranch: 'main',
  });

  await reconciler.reconcile(world());
  assert.equal(comments.length, 0, 'a verdict nobody has answered announces no commitment on the tracker');
  store.close();
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
  assert.match(h.errors[0]?.message ?? '', /The branch issue\/12 exists/);
  assert.equal(h.errors.length, 1, 'said once, on the transition — not every pulse');

  // The reason is on the rows, which is what makes the once-only error safe: the
  // Errors panel carries the news, the part carries the standing condition. Same
  // string in both, so the floor and the panel cannot word it differently.
  const reason = refCollisionReason(12);
  assert.ok(h.errors[0]?.message.includes(reason), 'the feed quotes the row');
  assert.deepEqual(
    h.store.listPlanParts(h.planId).map((p) => p.blockedReason),
    [reason, reason],
  );

  // And it survives the pulses that follow, when nothing flips and the feed is
  // silent — the case an operator actually looks at.
  await h.reconciler.reconcile(world());
  assert.equal(h.errors.length, 1, 'still silent');
  assert.equal(h.store.listPlanParts(h.planId)[0]?.blockedReason, reason, 'still explained');

  // Recovery is just deleting the branch; the next pulse un-blocks the parts.
  h.git.setPresence('issue/12', { local: false });
  await h.reconciler.reconcile(world());
  assert.deepEqual(statuses(h), [
    ['schema', 'ready'],
    ['api', 'pending'],
  ]);
  assert.deepEqual(
    h.store.listPlanParts(h.planId).map((p) => p.blockedReason),
    [null, null],
    'and stops claiming a collision that has been resolved',
  );
});

test('reconciliation is inert with the funnel off', async () => {
  const store = new Store(':memory:');
  const { sink, comments } = recordingSink();
  const plan = store.upsertPlan({ originRef: 'issue:12', title: 'Big thing', status: 'active', reason: null });
  store.upsertPlanParts(plan.id, [
    {
      slug: 'a',
      seq: 1,
      title: 'A',
      scope: 'src/',
      dependsOn: [],
      rationale: null,
      acceptance: null,
      expectedKind: null,
    },
  ]);
  const reconciler = new PlanReconciler({
    store,
    git: new FakeGitObserver(),
    sink,
    planning: { ...DEFAULT_PLANNING, enabled: false },
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
    {
      slug: 'schema',
      seq: 1,
      title: 'Schema',
      scope: 'src/store/',
      dependsOn: [],
      rationale: null,
      acceptance: null,
      expectedKind: null,
    },
    {
      slug: 'api',
      seq: 2,
      title: 'API',
      scope: 'src/server/',
      dependsOn: ['schema'],
      rationale: null,
      acceptance: null,
      expectedKind: null,
    },
  ]);
  store.updatePlanPart(parts[0]!.id, { status: 'merged', prNumber: 40 });
  const body = renderPlanComment(plan, store.listPlanParts(plan.id));
  assert.match(body, /1\/2 parts done/);
  assert.match(body, /Schema first\./);
  assert.match(body, /\[x\] \*\*Schema\*\* \(`schema`\) — merged · PR #40/);
  assert.match(body, /\[ \] \*\*API\*\*/);
  store.close();
});

test('a concluded part is finished, and the fold never brings it back', async () => {
  const h = setup();
  const parts = h.store.listPlanParts(h.planId);
  const schema = parts.find((p) => p.slug === 'schema')!;
  h.store.updatePlanPart(schema.id, { status: 'dispatched', branch: 'issue/12/schema' });
  h.store.concludePlanPart(schema.id, { kind: 'report', ref: null, summary: 'Findings in docs/perf.md' });

  // For a report or a determination there is no outside world to observe: the
  // record was durable the moment the agent wrote it, so the only thing this fold
  // could do is undo it. A PR appearing on the branch must not resurrect the part.
  await h.reconciler.reconcile(world([pr(40, 'issue/12/schema')]));
  const after = h.store.listPlanParts(h.planId).find((p) => p.slug === 'schema')!;
  assert.equal(after.status, 'concluded');
  assert.equal(after.outcomeKind, 'report');
  assert.equal(after.prNumber, null);

  // And it satisfies its dependent, which bases on the default branch because a
  // concluded part may never have pushed a branch worth stacking on.
  assert.equal(h.store.listPlanParts(h.planId).find((p) => p.slug === 'api')?.status, 'ready');
  h.store.close();
});

test('a plan finishing on a mix of terminals completes and says so without claiming a merge', async () => {
  const h = setup();
  const parts = h.store.listPlanParts(h.planId);
  const schema = parts.find((p) => p.slug === 'schema')!;
  const api = parts.find((p) => p.slug === 'api')!;
  h.store.updatePlanPart(schema.id, { status: 'merged', branch: 'issue/12/schema', prNumber: 40 });
  h.store.updatePlanPart(api.id, { status: 'dispatched', branch: 'issue/12/api' });
  h.store.concludePlanPart(api.id, { kind: 'determination', ref: null, summary: 'Already covered by #98' });

  await h.reconciler.reconcile(world());
  assert.equal(h.store.getPlan(h.planId)?.status, 'complete');
  const body = h.comments.at(-1)?.body ?? '';
  assert.match(body, /all 2 parts finished/);
  assert.match(body, /determination.*Already covered by #98/);
  assert.doesNotMatch(body, /API.*merged/);
  h.store.close();
});

// -- A plan whose lanes rejoin (issue #170) ----------------------------------

/** Declaration boilerplate, so the new tests read as the graph they are about. */
function partInput(slug: string, seq: number, dependsOn: string[]): PlanPartInput {
  return {
    slug,
    seq,
    title: slug,
    scope: `src/${slug}/`,
    dependsOn,
    rationale: null,
    acceptance: null,
    expectedKind: null,
  };
}

/**
 * A plan for issue 12 whose two lanes rejoin: `wire` needs **both** `schema` and
 * `api`, which the plan document's zod boundary refused until #170. The arity rule
 * moved here, so this is where it is asserted.
 */
function rejoinSetup(): Harness {
  const store = new Store(':memory:');
  const git = new FakeGitObserver();
  const { sink, comments } = recordingSink();
  const errors: ErrorLogInput[] = [];
  const plan = store.upsertPlan({
    originRef: 'issue:12',
    title: 'Two lanes, then a merger',
    status: 'active',
    reason: 'Schema and API are independent; wiring them needs both.',
  });
  store.upsertPlanParts(plan.id, [
    partInput('schema', 1, []),
    partInput('api', 2, []),
    partInput('wire', 3, ['schema', 'api']),
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

/** Put a part in review on its own branch, with the branch carrying commits. */
function inReview(h: Harness, slug: string, prNumber: number): PullRequest {
  const part = h.store.listPlanParts(h.planId).find((p) => p.slug === slug)!;
  const branch = `issue/12/${slug}`;
  h.store.updatePlanPart(part.id, { status: 'in_review', branch, prNumber });
  h.git.setDivergence(branch, 'main', { ahead: 2, behind: 0 });
  return pr(prNumber, branch);
}

function statusOf(h: Harness, slug: string): string {
  return h.store.listPlanParts(h.planId).find((p) => p.slug === slug)!.status;
}

test('a part with two dependencies still open stays pending — the arity rule, dynamically', async () => {
  const h = rejoinSetup();
  // Both dependencies are *satisfied*: each has pushed a branch worth stacking on,
  // so the only thing holding `wire` is that there are two of them in flight and
  // `partBase` would have two candidate branches and no way to choose. This is the
  // case the old static `dependsOn.length > 1` refusal existed to prevent.
  const prs = [inReview(h, 'schema', 40), inReview(h, 'api', 41)];
  await h.reconciler.reconcile(world(prs));
  assert.equal(statusOf(h, 'schema'), 'in_review');
  assert.equal(statusOf(h, 'api'), 'in_review');
  assert.equal(statusOf(h, 'wire'), 'pending');
  h.store.close();
});

test('one dependency merged and one open readies the rejoin, based on the one still open', async () => {
  const h = rejoinSetup();
  const open = inReview(h, 'api', 41);
  const schema = h.store.listPlanParts(h.planId).find((p) => p.slug === 'schema')!;
  h.store.updatePlanPart(schema.id, { status: 'merged', branch: 'issue/12/schema', prNumber: 40 });

  await h.reconciler.reconcile(world([open]));
  assert.equal(statusOf(h, 'wire'), 'ready', 'one unsettled dependency is the ordinary stack');

  const parts = h.store.listPlanParts(h.planId);
  const wire = parts.find((p) => p.slug === 'wire')!;
  assert.equal(partBase(wire, bySlug(parts), 12, 'main'), 'issue/12/api', 'it stacks on the one still in flight');
  h.store.close();
});

test('both dependencies merged readies the rejoin on the integration branch', async () => {
  const h = rejoinSetup();
  for (const [slug, number] of [
    ['schema', 40],
    ['api', 41],
  ] as const) {
    const part = h.store.listPlanParts(h.planId).find((p) => p.slug === slug)!;
    h.store.updatePlanPart(part.id, { status: 'merged', branch: `issue/12/${slug}`, prNumber: number });
  }

  await h.reconciler.reconcile(world());
  assert.equal(statusOf(h, 'wire'), 'ready');

  const parts = h.store.listPlanParts(h.planId);
  const wire = parts.find((p) => p.slug === 'wire')!;
  // Nothing is open, so there is nothing to stack on and no choice to make — which
  // is the whole reason a rejoin is safe and the old cap was too strict.
  assert.equal(partBase(wire, bySlug(parts), 12, 'main'), 'main');
  h.store.close();
});

test('a rejoin waits on every dependency, not just the ones that have settled', async () => {
  const h = rejoinSetup();
  // `api` merged, `schema` has an agent but has pushed nothing. One unsettled, so
  // the arity half passes; the satisfaction half must still hold `wire`.
  const api = h.store.listPlanParts(h.planId).find((p) => p.slug === 'api')!;
  h.store.updatePlanPart(api.id, { status: 'merged', branch: 'issue/12/api', prNumber: 41 });
  const schema = h.store.listPlanParts(h.planId).find((p) => p.slug === 'schema')!;
  const task = h.store.createTask({
    kind: 'code',
    title: 'Schema',
    prompt: 'p',
    branch: 'issue/12/schema',
    originRef: 'issue:12:part:schema',
  });
  h.store.markPartDispatched(schema.id, task.id, 'issue/12/schema');

  await h.reconciler.reconcile(world());
  assert.equal(statusOf(h, 'wire'), 'pending', 'basing on an empty branch gains nothing');

  h.git.setDivergence('issue/12/schema', 'main', { ahead: 1, behind: 0 });
  await h.reconciler.reconcile(world());
  assert.equal(statusOf(h, 'wire'), 'ready');
  h.store.close();
});
