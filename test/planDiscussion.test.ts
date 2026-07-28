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
  const { app } = await buildTestApp();
  assert.equal((await app.inject({ method: 'POST', url: '/api/plans/nope/discuss' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/plans/nope/discuss/end' })).statusCode, 404);
  await app.close();
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
