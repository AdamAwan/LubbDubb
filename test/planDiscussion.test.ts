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
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { parsePlanDocument } from '../src/plans/planDocument.js';
import { isPlanInDiscussion } from '../src/plans/planDiscussion.js';
import type { Plan } from '../src/types.js';
import type { FastifyInstance } from 'fastify';

test('discuss parks the plan for a planner and withdraws the pending approval', async () => {
  const { system, app } = await buildTestApp();
  const plan = seedAwaitingApprovalPlan(system);
  await system.harness.runCycle('manual'); // rule 3d writes the proposal
  const before = system.store.listProposals().find((p) => p.kind === 'plan')!;
  assert.equal(before.status, 'pending');

  const res = await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/discuss` });
  assert.equal(res.statusCode, 200);

  const after = system.store.getPlan(plan.id)!;
  // `planning`, so rule 3c dispatches and rule 4a schedules no parts.
  assert.equal(after.status, 'planning');
  assert.equal(after.discussing, true);
  assert.equal(isPlanInDiscussion(after), true);
  // The withdrawal is not optional: a pending proposal holds rule 3d, so the
  // amended decomposition would never be put to anyone — and the stale card, if
  // accepted, would release a plan its reader never saw.
  assert.equal(system.store.listProposals().find((p) => p.id === before.id)!.status, 'rejected');
  // ...and withdrawing must not retire anything: `refusePlan` no-ops because the
  // status write above already moved the plan out of `awaiting_approval`.
  assert.ok(system.store.listPlanParts(plan.id).every((p) => p.status !== 'retired'));
  await app.close();
  system.store.close();
});

test('ending a discussion puts the plan back to awaiting approval', async () => {
  const { system, app } = await buildTestApp();
  const plan = seedAwaitingApprovalPlan(system);
  await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/discuss` });

  const res = await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/discuss/end` });
  assert.equal(res.statusCode, 200);
  const after = system.store.getPlan(plan.id)!;
  // Without restoring the status the plan sits in `planning` and rule 3c simply
  // starts another discussion — the flag alone is not the whole of ending one.
  assert.equal(after.status, 'awaiting_approval');
  assert.equal(after.discussing, false);
  assert.equal(isPlanInDiscussion(after), false);
  await app.close();
  system.store.close();
});

test('a missing plan is a 404 on both discussion routes', async () => {
  const { system, app } = await buildTestApp();
  assert.equal((await app.inject({ method: 'POST', url: '/api/plans/nope/discuss' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/plans/nope/discuss/end' })).statusCode, 404);
  await app.close();
  system.store.close();
});

test('/discuss/end refuses a plan that is not being discussed, and leaves it untouched', async () => {
  const { system, app } = await buildTestApp();
  const plan = seedAwaitingApprovalPlan(system);
  // `active`, not `awaiting_approval`: this is the state where an unguarded
  // restore actually costs something — parts already dispatched, agents already
  // on branches — and where forcing it back to `awaiting_approval` would reopen
  // an approval gate nobody asked to reopen and stop rule 4a scheduling its parts.
  system.store.setPlanStatus(plan.id, 'active');

  const res = await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/discuss/end` });
  assert.equal(res.statusCode, 409);

  const after = system.store.getPlan(plan.id)!;
  assert.equal(after.status, 'active', 'a refused call must not move the plan at all');
  assert.equal(after.discussing, false);
  await app.close();
  system.store.close();
});

test('/discuss refuses a plan that is not awaiting approval, and leaves it untouched', async () => {
  const { system, app } = await buildTestApp();
  const plan = seedAwaitingApprovalPlan(system);
  // `single` is the trace that actually parks an issue: an unguarded discussion
  // ending on it writes `awaiting_approval` over zero parts, an operator approves
  // an empty plan, and the issue is left with no ready part and no agent.
  system.store.setPlanStatus(plan.id, 'single');

  const res = await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/discuss` });
  assert.equal(res.statusCode, 409);

  const after = system.store.getPlan(plan.id)!;
  assert.equal(after.status, 'single', 'a refused call must not move the plan at all');
  assert.equal(after.discussing, false);
  await app.close();
  system.store.close();
});

test('a discussed plan gets a conversational planner, not a fresh one', async () => {
  const { system, app } = await buildTestApp();
  const plan = seedAwaitingApprovalPlan(system);
  await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/discuss` });

  const task = system.store.listTasks().find((t) => t.originRef === 'issue:231:plan');
  assert.ok(task, 'rule 3c dispatched on the planner origin');
  // Same origin and branch as any planner — that is what makes the origin gate,
  // the cooldown and the attempt cap apply without a line of new code.
  assert.equal(task!.branch, 'plan/issue/231');
  // ...but the conversation prompt, not the replan one.
  assert.match(task!.prompt, /conversation/i);
  assert.match(task!.prompt, /escalate/);
  assert.doesNotMatch(task!.prompt, /an operator has asked for it to be replanned/);
  await app.close();
  system.store.close();
});

test('an ordinary replan is untouched by the discussion arm', async () => {
  const { system, app } = await buildTestApp();
  const plan = seedAwaitingApprovalPlan(system);
  await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/replan` });
  const task = system.store.listTasks().find((t) => t.originRef === 'issue:231:plan');
  assert.ok(task);
  assert.match(task!.prompt, /an operator has asked for it to be replanned/);
  await app.close();
  system.store.close();
});

test('replan during a discussion clears the discussing flag', async () => {
  const { system, app } = await buildTestApp();
  const plan = seedAwaitingApprovalPlan(system);
  await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/discuss` });
  assert.equal(system.store.getPlan(plan.id)!.discussing, true);

  const res = await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/replan` });
  assert.equal(res.statusCode, 200);
  const after = system.store.getPlan(plan.id)!;
  assert.equal(after.status, 'planning');
  assert.equal(after.discussing, false, 'a replan requested mid-discussion must not leave the flag set');
  assert.equal((res.json() as { plan: Plan }).plan.discussing, false, 'the response body agrees with the store');

  // The discussion agent still holds the origin (rule 3c dispatches no second
  // planner while it does), so end it and prove the *next* dispatch reads the
  // cleared flag: `discuss-plan` would render again if the clear were lost.
  const discussionTask = system.store.listTasks().find((t) => t.originRef === 'issue:231:plan');
  assert.ok(discussionTask?.agentId);
  system.agents.kill(discussionTask!.agentId!);
  await system.harness.runCycle('manual');
  const replanTask = system.store
    .listTasks()
    .find((t) => t.originRef === 'issue:231:plan' && t.id !== discussionTask!.id);
  assert.ok(replanTask, 'rule 3c dispatched a fresh planner once the origin freed up');
  assert.match(replanTask!.prompt, /an operator has asked for it to be replanned/);
  assert.doesNotMatch(replanTask!.prompt, /conversation/i);
  await app.close();
  system.store.close();
});

test('an amended plan ends the discussion and comes back as a fresh proposal', async () => {
  const { system, app } = await buildTestApp();
  const plan = seedAwaitingApprovalPlan(system);
  await system.harness.runCycle('manual');
  const first = system.store.listProposals().find((p) => p.kind === 'plan')!;

  await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/discuss` });
  assert.equal(system.store.listProposals().find((p) => p.id === first.id)!.status, 'rejected');

  // The discussion agent submits an amended decomposition — the same ingestion
  // both transports share.
  const parsed = parsePlanDocument(
    JSON.stringify({
      version: 1,
      verdict: 'parts',
      reason: 'amended after discussion',
      document: '# Amended\n\nmint no longer stacks on route.',
      parts: [
        { slug: 'signer', title: 'Signer', scope: 'src/', dependsOn: [] },
        { slug: 'mint', title: 'Mint', scope: 'web/', dependsOn: ['signer'] },
      ],
    }),
  );
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  ingestPlanDocument(system.store, {
    doc: parsed.document,
    originRef: 'issue:231',
    title: 'Serve artifacts outside /api',
    requireApproval: true,
  });

  const amended = system.store.getPlan(plan.id)!;
  assert.equal(amended.discussing, false, 'submitting is what ends the discussion');
  assert.equal(amended.status, 'awaiting_approval');

  // A *fresh* proposal, not the withdrawn one: the withdrawal at discuss time is
  // what unblocks rule 3d, which would otherwise be held by a pending verdict.
  await system.harness.runCycle('manual');
  const pending = system.store.listProposals().filter((p) => p.kind === 'plan' && p.status === 'pending');
  assert.equal(pending.length, 1);
  assert.notEqual(pending[0]!.id, first.id);
  await app.close();
  system.store.close();
});

test('nothing is scheduled from a plan while it is being discussed', async () => {
  const { system, app } = await buildTestApp();
  const plan = seedAwaitingApprovalPlan(system);
  await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/discuss` });
  // Run several pulses — "exactly one planner, however many pulses run" is only
  // a meaningful assertion once more than one pulse has actually happened.
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');

  // Rule 4a schedules parts for `active`/`awaiting_approval` only, so a plan in
  // `planning` yields no part dispatch — and rule 3c cannot start a second
  // planner because the discussion agent holds `issue:231:plan`.
  const partTasks = system.store.listTasks().filter((t) => (t.originRef ?? '').includes(':part:'));
  assert.deepEqual(partTasks, []);
  const planners = system.store.listTasks().filter((t) => t.originRef === 'issue:231:plan');
  assert.equal(planners.length, 1, 'exactly one planner, however many pulses run');
  await app.close();
  system.store.close();
});

// -- fixtures ----------------------------------------------------------------

/** A `System` + Fastify app wired the way route-driving tests need: no auth, a
 * fake PTY backend and git observer, and an in-memory store. */
async function buildTestApp(): Promise<{ system: System; app: FastifyInstance }> {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const config = loadConfig({
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    dispatcher: 'rule',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    planning: { enabled: true, requireApproval: true } as never,
    heartbeatIntervalMs: 999_999,
  });
  const system = buildSystem(config, {
    backend: new FakePtyBackend(),
    gitObserver: new FakeGitObserver(),
    errorMirror: () => {},
  });
  const { app } = await buildApp(system);
  return { system, app };
}

/** An issue already decomposed into two parts, parked `awaiting_approval`. */
function seedAwaitingApprovalPlan(system: System): Plan {
  system.connector.inject({ kind: 'new_issue', number: 231, title: 'Big thing', body: 'Several PRs.' });
  const doc = parsePlanDocument(
    JSON.stringify({
      version: 1,
      verdict: 'parts',
      reason: 'Schema first.',
      parts: [
        { slug: 'schema', title: 'Schema', scope: 'src/store', dependsOn: [] },
        { slug: 'api', title: 'API', scope: 'src/api', dependsOn: ['schema'] },
      ],
    }),
  );
  assert.ok(doc.ok);
  const result = ingestPlanDocument(system.store, {
    doc: doc.document,
    originRef: 'issue:231',
    title: 'Big thing',
    requireApproval: true,
  });
  return result.plan;
}
