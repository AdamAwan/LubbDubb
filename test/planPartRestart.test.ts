import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { parsePlanDocument } from '../src/plans/planDocument.js';
import { partOrigin } from '../src/plans/parts.js';
import { partRestartRefusal } from '../src/plans/partRestart.js';
import type { Plan, PlanPart, TaskSummary } from '../src/types.js';

/**
 * Restarting a plan part an amendment has overtaken.
 *
 * An amendment rewrites what a part is *for* and deliberately stops nothing, so a
 * part with an open pull request carries on building the declaration that was
 * superseded. This is the operator's way out, and every test here is one of the
 * three writes it has to make together — the pull request closed, the branch
 * dropped, the row back to `ready` — plus the states in which it must refuse.
 * → `docs/spec/08-planning.md#restarting-a-part`
 */

const ISSUE = 12;
const PR = 77;

test('a restart closes the PR, drops the branch and puts the part back on the fleet', async () => {
  const { system, app, worktrees, close } = await build();
  const plan = seedRunningPlan(system);
  inReview(system, plan, 'api', 'issue/12/api', PR);

  const res = await app.inject({
    method: 'POST',
    url: `/api/plans/${plan.id}/restart-part`,
    payload: { slug: 'api' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { ok: true; part: PlanPart; detail: string };

  // 1. The row, as the route hands it back — before the cycle it runs has had a
  // chance to dispatch it again. `prNumber` cleared is what stops the reconciler's
  // closed-unmerged arm firing a second time on the next pulse.
  assert.equal(body.part.status, 'ready');
  assert.equal(body.part.prNumber, null);
  assert.equal(body.part.branch, null);

  // 2. The pull request actually left the provider's open list. Without this the
  // reset above is undone on the very next pulse: `observePartPr`'s first reading
  // is "an open PR on the branch → in_review".
  const world = await system.connector.getState();
  assert.equal(
    world.pullRequests.find((p) => p.number === PR),
    undefined,
    'the PR is no longer open',
  );
  assert.ok(
    (world.closedPullRequests ?? []).some((p) => p.number === PR && p.merged === false),
    'it is closed rather than merged — nothing was delivered',
  );

  // 3. The branch, through the manager rather than a raw git call: the lease is
  // what keeps two agents out of one directory, and `ensure` is reuse-first — a
  // branch left standing hands the next agent the commits the amendment invalidated.
  assert.deepEqual(worktrees.deleted, ['issue/12/api']);

  // And it is a `plan-part` candidate again, against the declaration the plan
  // carries now: the route's own cycle dispatched it.
  const dispatched = system.store.listTasks().find((t) => t.originRef === partOrigin(ISSUE, 'api'));
  assert.ok(dispatched, 'the part was dispatched again');
  await close();
});

test('a restart refuses a part with no pull request, and pressing it twice is that refusal', async () => {
  const { system, app, close } = await build();
  const plan = seedRunningPlan(system);
  inReview(system, plan, 'api', 'issue/12/api', PR);

  const first = await app.inject({
    method: 'POST',
    url: `/api/plans/${plan.id}/restart-part`,
    payload: { slug: 'api' },
  });
  assert.equal(first.statusCode, 200);

  // Idempotence, in the shape this feature actually has one: the second press finds
  // nothing to close and says so, rather than closing something else or throwing.
  const second = await app.inject({
    method: 'POST',
    url: `/api/plans/${plan.id}/restart-part`,
    payload: { slug: 'api' },
  });
  assert.equal(second.statusCode, 400);
  assert.match((second.json() as { error: string }).error, /has no pull request open/);

  // And the provider's own close is idempotent underneath it, which is what makes
  // a retry after a half-failed restart safe.
  const again = await system.connector.closePr({ prNumber: PR });
  assert.equal(again.ok, true, 'closing a pull request that is already closed is a success');
  await close();
});

test('a restart refuses a part that has already merged', async () => {
  const { system, app, close } = await build();
  const plan = seedRunningPlan(system);
  const part = partOf(system, plan, 'api');
  system.store.updatePlanPart(part.id, { status: 'merged', branch: 'issue/12/api', prNumber: PR });

  const res = await app.inject({
    method: 'POST',
    url: `/api/plans/${plan.id}/restart-part`,
    payload: { slug: 'api' },
  });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /already finished as merged/);
  assert.equal(partOf(system, plan, 'api').status, 'merged', 'nothing was written');
  await close();
});

test('a restart refuses while an agent is still on the part', async () => {
  const { system, app, worktrees, close } = await build();
  const plan = seedRunningPlan(system);
  inReview(system, plan, 'api', 'issue/12/api', PR);
  // A run that outlived the PR opening — a re-dispatch onto the same branch writes
  // its own task row, which is why the check reads the branch as well as `taskId`.
  system.store.createTask({
    kind: 'code',
    title: 'still going',
    prompt: 'p',
    branch: 'issue/12/api',
    originRef: partOrigin(ISSUE, 'api'),
  });

  const res = await app.inject({
    method: 'POST',
    url: `/api/plans/${plan.id}/restart-part`,
    payload: { slug: 'api' },
  });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /agent is still working/i);
  // The worktree an agent is sitting in is exactly what a premature restart would
  // have deleted, so this is the assertion that matters more than the status code.
  assert.deepEqual(worktrees.deleted, []);
  const world = await system.connector.getState();
  assert.ok(
    world.pullRequests.some((p) => p.number === PR),
    'the PR is untouched',
  );
  await close();
});

test('a restart refuses where the provider cannot close a pull request', async () => {
  const { system, app, worktrees, close } = await build();
  const plan = seedRunningPlan(system);
  inReview(system, plan, 'api', 'issue/12/api', PR);
  // The deployment shape this stands in for is a source-control provider that is
  // not `PrCloseCapable`. The cockpit reads the same answer off `config.canClosePr`
  // and draws no control at all; this is the backstop behind that.
  system.connector.canClosePr = () => false;

  const res = await app.inject({
    method: 'POST',
    url: `/api/plans/${plan.id}/restart-part`,
    payload: { slug: 'api' },
  });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /cannot close a pull request/);
  assert.equal(partOf(system, plan, 'api').status, 'in_review', 'the part is left where it was');
  assert.deepEqual(worktrees.deleted, [], 'and its branch with it');
  await close();
});

test('the refusals name the reason, and the capability one names what to do instead', () => {
  const part = (over: Partial<PlanPart>): PlanPart => ({
    id: 'plan_1:api',
    planId: 'plan_1',
    slug: 'api',
    seq: 1,
    title: 'API',
    scope: 'src/api',
    rationale: null,
    acceptance: null,
    acceptanceMet: [],
    touches: [],
    size: null,
    expectedKind: null,
    outcomeKind: null,
    outcomeRef: null,
    outcomeSummary: null,
    dependsOn: [],
    branch: 'issue/12/api',
    prNumber: PR,
    status: 'in_review',
    blockedReason: null,
    blockedBy: null,
    taskId: null,
    profile: null,
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
    ...over,
  });
  const none: TaskSummary[] = [];

  assert.equal(partRestartRefusal(part({}), none, true), null, 'a part in review with a PR may be restarted');
  assert.match(partRestartRefusal(part({ status: 'concluded' }), none, true)!, /already finished as concluded/);
  assert.match(partRestartRefusal(part({ prNumber: null }), none, true)!, /no pull request open/);
  // The capability refusal explains the deployment rather than the button: closing
  // it in the tracker is what brings the part back, and the operator has to be told
  // that or the part sits in review for good.
  const capability = partRestartRefusal(part({}), none, false)!;
  assert.match(capability, /cannot close a pull request from here/);
  assert.match(capability, /Close it there/);
});

// -- fixtures ----------------------------------------------------------------

/**
 * A whole `System` on a throwaway database. `worktrees` above all: the happy path
 * dispatches a code agent, and without the fake that cuts a real branch in
 * whatever checkout the suite is running in (CLAUDE.md).
 */
async function build(): Promise<{
  system: System;
  app: Awaited<ReturnType<typeof buildApp>>['app'];
  worktrees: FakeWorktreeManager;
  close: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
  });
  const worktrees = new FakeWorktreeManager();
  const system = buildSystem(config, {
    backend: new FakePtyBackend(),
    gitObserver: new FakeGitObserver(),
    worktrees,
    errorMirror: () => {},
  });
  const { app } = await buildApp(system);
  return {
    system,
    app,
    worktrees,
    close: async () => {
      await app.close();
      system.store.close();
    },
  };
}

/** An issue decomposed into two independent parts and released. */
function seedRunningPlan(system: System): Plan {
  system.connector.inject({ kind: 'new_issue', number: ISSUE, title: 'Big thing', body: 'Several PRs.' });
  const doc = parsePlanDocument(
    JSON.stringify({
      version: 1,
      reason: 'Two independent pieces.',
      parts: [
        { slug: 'schema', title: 'Schema', scope: 'src/store', dependsOn: [] },
        { slug: 'api', title: 'API', scope: 'src/api', dependsOn: [] },
      ],
    }),
  );
  assert.ok(doc.ok);
  const { plan } = ingestPlanDocument(system.store, {
    doc: doc.document,
    originRef: `issue:${ISSUE}`,
    title: 'Big thing',
  });
  system.store.setPlanStatus(plan.id, 'active');
  return system.store.getPlan(plan.id)!;
}

/** The state a restart is about: a part with a pull request open on its branch. */
function inReview(system: System, plan: Plan, slug: string, branch: string, prNumber: number): void {
  system.store.updatePlanPart(partOf(system, plan, slug).id, { status: 'in_review', branch, prNumber });
  system.connector.inject({ kind: 'new_pr', number: prNumber, title: 'API', branch });
}

function partOf(system: System, plan: Plan, slug: string): PlanPart {
  const part = system.store.listPlanParts(plan.id).find((p) => p.slug === slug);
  assert.ok(part, `no part "${slug}"`);
  return part;
}
