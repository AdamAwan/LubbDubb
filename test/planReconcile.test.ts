import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { PlanReconciler, refCollisionReason } from '../src/plans/planReconciler.js';
import { planIsWedged } from '../src/plans/planWedge.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import { renderPlanComment } from '../src/plans/planComment.js';
import { DEFAULT_PLANNING } from '../src/plans/planning.js';
import { bySlug, partBase } from '../src/plans/parts.js';
import type { ActionSink, IssueCommentInput, SendResult } from '../src/sink/actionSink.js';
import type { ErrorLogEntry, ErrorLogInput, PlanPartInput, PullRequest, WorldSnapshot } from '../src/types.js';

function recordingSink(): { sink: ActionSink; comments: IssueCommentInput[] } {
  const comments: IssueCommentInput[] = [];
  const unused = async (): Promise<SendResult> => {
    throw new Error('not used by reconciliation');
  };
  return {
    comments,
    sink: {
      canCloseIssue: () => false,
      canClosePr: () => false,
      closePr: (): never => {
        throw new Error('closePr is not scripted in this test');
      },
      canResolvePrThread: () => false,
      resolvePrThread: (): never => {
        throw new Error('resolvePrThread is not scripted in this test');
      },
      closeIssue: (): never => {
        throw new Error('closeIssue is not scripted in this test');
      },
      canSetWorkItemState: () => false,
      canPlaceWorkItem: () => false,
      setWorkItemParent: () => Promise.reject(new Error('not used')),
      setWorkItemAreaPath: () => Promise.reject(new Error('not used')),
      postPrReply: unused,
      mergePr: unused,
      setPrLabel: unused,
      setIssueLabel: unused,
      setWorkItemState: unused,
      linkWorkItem: unused,
      createPullRequest: unused,
      setPullTitle: unused,
      setPullBase: unused,
      updatePrBranch: unused,
      requeueCiCheck: unused,
      deleteBranch: unused,
      createIssue: unused,
      async upsertIssueComment(input): Promise<SendResult> {
        comments.push(input);
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

function setup(): Harness {
  const store = new Store(':memory:');
  const git = new FakeGitObserver();
  const { sink, comments } = recordingSink();
  const errors: ErrorLogInput[] = [];
  const plan = store.plans.upsertPlan({
    originRef: 'issue:12',
    title: 'Big thing',
    status: 'active',
    reason: 'Schema first.',
  });
  store.plans.upsertPlanParts(plan.id, [
    {
      slug: 'schema',
      seq: 1,
      title: 'Schema',
      scope: 'src/store/',
      dependsOn: [],
      rationale: null,
      acceptance: null,
      touches: [],
      size: null,
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
      touches: [],
      size: null,
      expectedKind: null,
    },
  ]);
  const reconciler = new PlanReconciler({
    store,
    git,
    sink,
    planning: DEFAULT_PLANNING,
    defaultBranch: 'main',
    errors: { record: (entry) => (errors.push(entry), {}) as ErrorLogEntry },
  });
  return { store, git, comments, errors, reconciler, planId: plan.id };
}

function statuses(h: Harness): [string, string][] {
  return h.store.plans.listPlanParts(h.planId).map((p) => [p.slug, p.status]);
}

test('a part with no dependency is ready; its dependent waits until the branch carries work', async () => {
  const h = setup();
  await h.reconciler.reconcile(world());
  assert.deepEqual(statuses(h), [
    ['schema', 'ready'],
    ['api', 'pending'],
  ]);

  const schema = h.store.plans.listPlanParts(h.planId)[0]!;
  const agentTask = h.store.tasks.createTask({
    kind: 'code',
    title: 'Schema',
    prompt: 'p',
    branch: 'issue/12/schema',
    originRef: 'issue:12:part:schema',
  });
  h.store.plans.markPartDispatched(schema.id, agentTask.id, 'issue/12/schema');
  await h.reconciler.reconcile(world());
  assert.deepEqual(
    statuses(h).find(([slug]) => slug === 'api'),
    ['api', 'pending'],
  );

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
  const [schema] = h.store.plans.listPlanParts(h.planId);
  assert.equal(schema?.status, 'in_review');
  assert.equal(schema?.prNumber, 40);
  assert.equal(schema?.branch, 'issue/12/schema', 'the branch is backfilled from the PR that appeared on it');

  await h.reconciler.reconcile(world([pr(40, 'issue/12/schema', { merged: true })]));
  assert.equal(h.store.plans.listPlanParts(h.planId)[0]?.status, 'merged');
});

test('a PR that has left the open list is read as merged', async () => {
  const h = setup();
  await h.reconciler.reconcile(world([pr(40, 'issue/12/schema')]));
  assert.equal(h.store.plans.listPlanParts(h.planId)[0]?.status, 'in_review');
  await h.reconciler.reconcile(world());
  assert.equal(h.store.plans.listPlanParts(h.planId)[0]?.status, 'merged');
});

test('a dispatched part whose agent is gone without a PR goes back to ready', async () => {
  const h = setup();
  await h.reconciler.reconcile(world());
  const schema = h.store.plans.listPlanParts(h.planId)[0]!;
  const task = h.store.tasks.createTask({
    kind: 'code',
    title: 'part',
    prompt: 'p',
    branch: 'issue/12/schema',
    originRef: 'issue:12:part:schema',
  });
  h.store.plans.markPartDispatched(schema.id, task.id, 'issue/12/schema');

  await h.reconciler.reconcile(world());
  assert.equal(h.store.plans.listPlanParts(h.planId)[0]?.status, 'dispatched', 'a live task keeps the part staffed');

  h.store.tasks.updateTask(task.id, { status: 'done' });
  await h.reconciler.reconcile(world());
  assert.equal(
    h.store.plans.listPlanParts(h.planId)[0]?.status,
    'ready',
    'so the per-part cooldown governs the retry, and the attempt cap eventually escalates',
  );
});

test('every part merged rolls the plan up to complete', async () => {
  const h = setup();
  const [schema, api] = h.store.plans.listPlanParts(h.planId);
  h.store.plans.updatePlanPart(schema!.id, { status: 'merged' });
  await h.reconciler.reconcile(world());
  assert.equal(h.store.plans.getPlanByOrigin('issue:12')?.status, 'active');

  h.store.plans.updatePlanPart(api!.id, { status: 'merged' });
  await h.reconciler.reconcile(world());
  assert.equal(h.store.plans.getPlanByOrigin('issue:12')?.status, 'complete');
  const body = h.comments.at(-1)?.body ?? '';
  assert.match(body, /Plan complete/);
  assert.match(body, /Closing it is a human decision/);
});

test('the status comment is written once and then edited in place, only when there is news', async () => {
  const h = setup();
  await h.reconciler.reconcile(world());
  assert.equal(h.comments.length, 1, 'the plan appearing is news');
  assert.equal(h.comments[0]?.commentRef, null, 'the first write creates the comment');

  await h.reconciler.reconcile(world());
  assert.equal(h.comments.length, 1);

  await h.reconciler.reconcile(world([pr(40, 'issue/12/schema')]));
  assert.equal(h.comments.length, 2, 'a part moving is news');
  assert.equal(h.comments[1]?.commentRef, 'comment_1', 'edited in place — one living comment, not a stream');
  assert.equal(h.store.plans.getPlanByOrigin('issue:12')?.statusCommentRef, 'comment_1');
});

test('a one-part plan writes its status comment like any other', async () => {
  const store = new Store(':memory:');
  const { sink, comments } = recordingSink();
  const plan = store.plans.upsertPlan({
    originRef: 'issue:12',
    title: 'Big thing',
    status: 'active',
    reason: 'One PR is the right shape here.',
  });
  store.plans.upsertPlanParts(plan.id, [
    {
      slug: 'whole',
      seq: 1,
      title: 'The change',
      scope: 'src/',
      touches: [],
      dependsOn: [],
      rationale: null,
      acceptance: null,
      size: null,
      expectedKind: null,
      profile: null,
    },
  ]);
  const reconciler = new PlanReconciler({
    store,
    git: new FakeGitObserver(),
    sink,
    planning: DEFAULT_PLANNING,
    defaultBranch: 'main',
  });

  await reconciler.reconcile(world());
  assert.equal(comments.length, 1, 'the plan appearing is news');
  assert.match(comments[0]?.body ?? '', /0\/1 part done/);
  assert.match(comments[0]?.body ?? '', /One PR is the right shape here\./);
  assert.doesNotMatch(comments[0]?.body ?? '', /One pull request/);
  assert.equal(store.plans.getPlan(plan.id)?.statusCommentRef, 'comment_1');

  await reconciler.reconcile(world());
  assert.equal(comments.length, 1);
  store.close();
});

test('an unapproved plan announces nothing, on either shape', async () => {
  const store = new Store(':memory:');
  const { sink, comments } = recordingSink();
  store.plans.upsertPlan({ originRef: 'issue:12', title: 'Big thing', status: 'awaiting_approval', reason: 'One PR.' });
  const reconciler = new PlanReconciler({
    store,
    git: new FakeGitObserver(),
    sink,
    planning: DEFAULT_PLANNING,
    defaultBranch: 'main',
  });

  await reconciler.reconcile(world());
  assert.equal(comments.length, 0, 'a verdict nobody has answered announces no commitment on the tracker');
  store.close();
});

test('an existing issue/<n> branch blocks the parts, and says so', async () => {
  const h = setup();
  h.git.setPresence('issue/12', { local: true });
  await h.reconciler.reconcile(world());
  assert.deepEqual(statuses(h), [
    ['schema', 'blocked'],
    ['api', 'blocked'],
  ]);
  assert.match(h.errors[0]?.message ?? '', /The branch issue\/12 exists/);
  assert.equal(h.errors.length, 1, 'said once, on the transition — not every pulse');

  const reason = refCollisionReason(12, { local: true, remote: false });
  assert.ok(h.errors[0]?.message.includes(reason), 'the feed quotes the row');
  assert.deepEqual(
    h.store.plans.listPlanParts(h.planId).map((p) => p.blockedReason),
    [reason, reason],
  );

  await h.reconciler.reconcile(world());
  assert.equal(h.errors.length, 1, 'still silent');
  assert.equal(h.store.plans.listPlanParts(h.planId)[0]?.blockedReason, reason, 'still explained');

  h.git.setPresence('issue/12', { local: false });
  await h.reconciler.reconcile(world());
  assert.deepEqual(statuses(h), [
    ['schema', 'ready'],
    ['api', 'pending'],
  ]);
  assert.deepEqual(
    h.store.plans.listPlanParts(h.planId).map((p) => p.blockedReason),
    [null, null],
    'and stops claiming a collision that has been resolved',
  );
});

test('the collision guard is scoped to the parts git is actually asked to cut', async () => {
  const h = humanAndCodeSetup();
  h.git.setPresence('issue/12', { local: true });
  await h.reconciler.reconcile(world());
  assert.deepEqual(statuses(h), [
    ['flip', 'ready'],
    ['code', 'blocked'],
  ]);
  const reasons = new Map(h.store.plans.listPlanParts(h.planId).map((p) => [p.slug, p.blockedReason]));
  assert.equal(reasons.get('flip'), null);
  assert.equal(reasons.get('code'), refCollisionReason(12, { local: true, remote: false }));
});

const PLANNING_ON = { ...DEFAULT_PLANNING, enabled: true };

function decline(h: Harness, slug: string): void {
  const part = h.store.plans.listPlanParts(h.planId).find((p) => p.slug === slug)!;
  const { task } = h.store.humanTasks.recordHumanTask({
    title: `Do ${slug}`,
    detail: null,
    agentId: null,
    taskId: null,
    originRef: `${h.planId}:${slug}`,
    partId: part.id,
    kind: 'ask',
  });
  h.store.humanTasks.settleHumanTask(task.id, 'declined', 'not doing this');
}

test('a declined step blocks its part without wedging the plan', async () => {
  const h = humanOnlySetup();
  decline(h, 'flip');
  await h.reconciler.reconcile(world());

  const parts = h.store.plans.listPlanParts(h.planId);
  assert.deepEqual(statuses(h), [['flip', 'blocked']], 'the decline still stops the part');
  assert.equal(parts[0]?.blockedBy, 'declined');
  assert.match(parts[0]?.blockedReason ?? '', /is a step for a person, and it was declined/);
  assert.equal(planIsWedged(parts), false, 'the operator declined it, and nothing is stranded behind it');

  const result = await new RuleDispatcher({ defaultBranch: 'main', planning: PLANNING_ON }).decide({
    world: {
      takenAt: '2026-07-25T12:00:00.000Z',
      pullRequests: [],
      issues: [{ id: 'i12', number: 12, title: 'Turn on the thing', body: '', labels: [], state: 'open' }],
    } as unknown as WorldSnapshot,
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    agentHeadroom: 5,
    recentDecisions: [],
    plans: [h.store.plans.getPlan(h.planId)!],
    planParts: parts,
  });
  assert.deepEqual(
    result.actions.filter((a) => a.rule === 'plan-blocked'),
    [],
    'the operator declined it — putting the refusal back in "Needs you" is asking them to answer themselves',
  );
});

test('a decline beside a collision is still a wedge — the branch is what clearing reaches', async () => {
  const h = humanAndCodeSetup();
  h.git.setPresence('issue/12', { local: true });
  decline(h, 'flip');
  await h.reconciler.reconcile(world());

  const parts = h.store.plans.listPlanParts(h.planId);
  const by = new Map(parts.map((p) => [p.slug, p.blockedBy]));
  assert.deepEqual(statuses(h), [
    ['flip', 'blocked'],
    ['code', 'blocked'],
  ]);
  assert.equal(by.get('flip'), 'declined');
  assert.equal(by.get('code'), 'collision');
  assert.equal(planIsWedged(parts), true);
});

test('a plan of nothing but human steps records no collision and is not wedged', async () => {
  const h = humanOnlySetup();
  h.git.setPresence('issue/12', { local: true });
  await h.reconciler.reconcile(world());
  assert.deepEqual(statuses(h), [['flip', 'ready']]);
  assert.equal(h.errors.length, 0, 'nothing collided, so nothing was recorded');
  assert.equal(h.store.plans.listPlanParts(h.planId)[0]?.blockedReason, null);
});

test('the reason names where the branch is, and which delete actually works', () => {
  const local = refCollisionReason(12, { local: true, remote: false });
  assert.match(local, /exists locally/);
  assert.match(local, /Delete or rename the local issue\/12/);
  assert.doesNotMatch(local, /origin/, 'nothing about a remote the branch is not on');

  const remote = refCollisionReason(12, { local: false, remote: true });
  assert.match(remote, /exists on origin/);
  assert.match(remote, /git push origin --delete issue\/12/);
  assert.match(remote, /Deleting it locally does nothing here/, 'the sentence the afternoon was spent without');
  assert.match(remote, /--prune/);

  assert.equal(refCollisionReason(12, { local: true, remote: true }), remote);
  for (const r of [local, remote]) assert.ok(r.includes('issue/12/<part>'));
});

test('a remote-only collision blocks the parts and says the remote delete', async () => {
  const h = setup();
  h.git.setPresence('issue/12', { remote: true });
  await h.reconciler.reconcile(world());
  assert.deepEqual(statuses(h), [
    ['schema', 'blocked'],
    ['api', 'blocked'],
  ]);
  const reason = refCollisionReason(12, { local: false, remote: true });
  assert.deepEqual(
    h.store.plans.listPlanParts(h.planId).map((p) => p.blockedReason),
    [reason, reason],
  );
  assert.ok(h.errors[0]?.message.includes(reason), 'one string in the feed and on the row');

  h.git.setPresence('issue/12', { local: true, remote: false });
  await h.reconciler.reconcile(world());
  assert.deepEqual(
    h.store.plans.listPlanParts(h.planId).map((p) => p.blockedReason),
    [refCollisionReason(12, { local: true, remote: false }), refCollisionReason(12, { local: true, remote: false })],
  );
  assert.equal(h.errors.length, 2, 'and the feed carries the change, since the row moved');
});

test('the rendered comment reports progress and the PR numbers', () => {
  const store = new Store(':memory:');
  const plan = store.plans.upsertPlan({
    originRef: 'issue:12',
    title: 'Big thing',
    status: 'active',
    reason: 'Schema first.',
  });
  const parts = store.plans.upsertPlanParts(plan.id, [
    {
      slug: 'schema',
      seq: 1,
      title: 'Schema',
      scope: 'src/store/',
      dependsOn: [],
      rationale: null,
      acceptance: null,
      touches: [],
      size: null,
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
      touches: [],
      size: null,
      expectedKind: null,
    },
  ]);
  store.plans.updatePlanPart(parts[0]!.id, { status: 'merged', prNumber: 40 });
  const body = renderPlanComment(plan, store.plans.listPlanParts(plan.id), '#');
  assert.match(body, /1\/2 parts done/);
  assert.match(body, /Schema first\./);
  assert.match(body, /\[x\] \*\*Schema\*\* \(`schema`\) — merged · PR #40/);
  assert.match(body, /\[ \] \*\*API\*\*/);
  store.close();
});

test('a concluded part is finished, and the fold never brings it back', async () => {
  const h = setup();
  const parts = h.store.plans.listPlanParts(h.planId);
  const schema = parts.find((p) => p.slug === 'schema')!;
  h.store.plans.updatePlanPart(schema.id, { status: 'dispatched', branch: 'issue/12/schema' });
  h.store.plans.concludePlanPart(schema.id, { kind: 'report', ref: null, summary: 'Findings in docs/perf.md' });

  await h.reconciler.reconcile(world([pr(40, 'issue/12/schema')]));
  const after = h.store.plans.listPlanParts(h.planId).find((p) => p.slug === 'schema')!;
  assert.equal(after.status, 'concluded');
  assert.equal(after.outcomeKind, 'report');
  assert.equal(after.prNumber, null);

  assert.equal(h.store.plans.listPlanParts(h.planId).find((p) => p.slug === 'api')?.status, 'ready');
  h.store.close();
});

test('a plan finishing on a mix of terminals completes and says so without claiming a merge', async () => {
  const h = setup();
  const parts = h.store.plans.listPlanParts(h.planId);
  const schema = parts.find((p) => p.slug === 'schema')!;
  const api = parts.find((p) => p.slug === 'api')!;
  h.store.plans.updatePlanPart(schema.id, { status: 'merged', branch: 'issue/12/schema', prNumber: 40 });
  h.store.plans.updatePlanPart(api.id, { status: 'dispatched', branch: 'issue/12/api' });
  h.store.plans.concludePlanPart(api.id, { kind: 'determination', ref: null, summary: 'Already covered by #98' });

  await h.reconciler.reconcile(world());
  assert.equal(h.store.plans.getPlan(h.planId)?.status, 'complete');
  const body = h.comments.at(-1)?.body ?? '';
  assert.match(body, /all 2 parts finished/);
  assert.match(body, /determination.*Already covered by #98/);
  assert.doesNotMatch(body, /API.*merged/);
  h.store.close();
});

function partInput(slug: string, seq: number, dependsOn: string[]): PlanPartInput {
  return {
    slug,
    seq,
    title: slug,
    scope: `src/${slug}/`,
    touches: [],
    dependsOn,
    rationale: null,
    acceptance: null,
    size: null,
    expectedKind: null,
  };
}

function humanAndCodeSetup(): Harness {
  return planOf([human('flip', 1), partInput('code', 2, [])], 'A flip, then the code');
}

function humanOnlySetup(): Harness {
  return planOf([human('flip', 1)], 'A flip, and nothing else');
}

function human(slug: string, seq: number): PlanPartInput {
  return { ...partInput(slug, seq, []), expectedKind: 'human' };
}

function planOf(parts: PlanPartInput[], title: string): Harness {
  const store = new Store(':memory:');
  const git = new FakeGitObserver();
  const { sink, comments } = recordingSink();
  const errors: ErrorLogInput[] = [];
  const plan = store.plans.upsertPlan({ originRef: 'issue:12', title, status: 'active', reason: null });
  store.plans.upsertPlanParts(plan.id, parts);
  const reconciler = new PlanReconciler({
    store,
    git,
    sink,
    planning: DEFAULT_PLANNING,
    defaultBranch: 'main',
    errors: { record: (entry) => (errors.push(entry), {}) as ErrorLogEntry },
  });
  return { store, git, comments, errors, reconciler, planId: plan.id };
}

function rejoinSetup(): Harness {
  const store = new Store(':memory:');
  const git = new FakeGitObserver();
  const { sink, comments } = recordingSink();
  const errors: ErrorLogInput[] = [];
  const plan = store.plans.upsertPlan({
    originRef: 'issue:12',
    title: 'Two lanes, then a merger',
    status: 'active',
    reason: 'Schema and API are independent; wiring them needs both.',
  });
  store.plans.upsertPlanParts(plan.id, [
    partInput('schema', 1, []),
    partInput('api', 2, []),
    partInput('wire', 3, ['schema', 'api']),
  ]);
  const reconciler = new PlanReconciler({
    store,
    git,
    sink,
    planning: DEFAULT_PLANNING,
    defaultBranch: 'main',
    errors: { record: (entry) => (errors.push(entry), {}) as ErrorLogEntry },
  });
  return { store, git, comments, errors, reconciler, planId: plan.id };
}

function inReview(h: Harness, slug: string, prNumber: number): PullRequest {
  const part = h.store.plans.listPlanParts(h.planId).find((p) => p.slug === slug)!;
  const branch = `issue/12/${slug}`;
  h.store.plans.updatePlanPart(part.id, { status: 'in_review', branch, prNumber });
  h.git.setDivergence(branch, 'main', { ahead: 2, behind: 0 });
  return pr(prNumber, branch);
}

function statusOf(h: Harness, slug: string): string {
  return h.store.plans.listPlanParts(h.planId).find((p) => p.slug === slug)!.status;
}

test('a part with two dependencies still open stays pending — the arity rule, dynamically', async () => {
  const h = rejoinSetup();
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
  const schema = h.store.plans.listPlanParts(h.planId).find((p) => p.slug === 'schema')!;
  h.store.plans.updatePlanPart(schema.id, { status: 'merged', branch: 'issue/12/schema', prNumber: 40 });

  await h.reconciler.reconcile(world([open]));
  assert.equal(statusOf(h, 'wire'), 'ready', 'one unsettled dependency is the ordinary stack');

  const parts = h.store.plans.listPlanParts(h.planId);
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
    const part = h.store.plans.listPlanParts(h.planId).find((p) => p.slug === slug)!;
    h.store.plans.updatePlanPart(part.id, { status: 'merged', branch: `issue/12/${slug}`, prNumber: number });
  }

  await h.reconciler.reconcile(world());
  assert.equal(statusOf(h, 'wire'), 'ready');

  const parts = h.store.plans.listPlanParts(h.planId);
  const wire = parts.find((p) => p.slug === 'wire')!;
  assert.equal(partBase(wire, bySlug(parts), 12, 'main'), 'main');
  h.store.close();
});

test('a rejoin waits on every dependency, not just the ones that have settled', async () => {
  const h = rejoinSetup();
  const api = h.store.plans.listPlanParts(h.planId).find((p) => p.slug === 'api')!;
  h.store.plans.updatePlanPart(api.id, { status: 'merged', branch: 'issue/12/api', prNumber: 41 });
  const schema = h.store.plans.listPlanParts(h.planId).find((p) => p.slug === 'schema')!;
  const task = h.store.tasks.createTask({
    kind: 'code',
    title: 'Schema',
    prompt: 'p',
    branch: 'issue/12/schema',
    originRef: 'issue:12:part:schema',
  });
  h.store.plans.markPartDispatched(schema.id, task.id, 'issue/12/schema');

  await h.reconciler.reconcile(world());
  assert.equal(statusOf(h, 'wire'), 'pending', 'basing on an empty branch gains nothing');

  h.git.setDivergence('issue/12/schema', 'main', { ahead: 1, behind: 0 });
  await h.reconciler.reconcile(world());
  assert.equal(statusOf(h, 'wire'), 'ready');
  h.store.close();
});
