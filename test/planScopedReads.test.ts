import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { parsePlanDocument } from '../src/plans/planDocument.js';
import { proposePlanAmendment } from '../src/plans/planAmendment.js';
import type { Plan, PlanAtomInput } from '../src/types.js';
import type { UsagePayload } from '../src/wire.js';

test('every amendment in the database is read in one query, grouped per plan', async () => {
  const { system, app, close } = await build();
  const one = seedPlan(system, 12);
  const two = seedPlan(system, 13);
  propose(system, one);
  propose(system, two);

  const perPlan = [one, two].flatMap((plan) => system.store.plans.listPlanAmendments(plan.id));
  const all = system.store.plans.listAllPlanAmendments();
  assert.equal(all.length, 2);
  assert.deepEqual(
    [...all].sort((a, b) => a.id.localeCompare(b.id)),
    [...perPlan].sort((a, b) => a.id.localeCompare(b.id)),
    'the flat read carries exactly what the per-plan reads did',
  );
  assert.deepEqual(
    all.map((a) => a.planId),
    [...all.map((a) => a.planId)].sort(),
    'rows stay grouped by plan',
  );

  const res = await app.inject({ method: 'GET', url: '/api/usage' });
  assert.equal(res.statusCode, 200);
  const row = (res.json() as UsagePayload).insights.acts.find((r) => r.id === 'plan-amendment');
  assert.ok(row);
  assert.equal(row.offered, 2, 'both amendments still reach the operator insights');
  await close();
});

test("a plan's atoms are read scoped, in sequence", async () => {
  const { system, close } = await build();
  const one = seedPlan(system, 12);
  const two = seedPlan(system, 13);
  system.store.plans.upsertPlanAtoms(one.id, [atom('b', 2), atom('a', 1)]);
  system.store.plans.upsertPlanAtoms(two.id, [atom('c', 1)]);

  const scoped = system.store.plans.listPlanAtoms(one.id);
  assert.deepEqual(
    scoped.map((a) => a.slug),
    ['a', 'b'],
    'ordered by seq, the order a regroup reads',
  );
  assert.deepEqual(
    scoped,
    system.store.plans.listAllPlanAtoms().filter((a) => a.planId === one.id),
    'the scoped read carries exactly what filtering the whole table did',
  );
  assert.deepEqual(
    system.store.plans.listPlanAtoms(two.id).map((a) => a.slug),
    ['c'],
  );
  assert.deepEqual(system.store.plans.listPlanAtoms('plan-that-is-not-there'), []);
  await close();
});

function atom(slug: string, seq: number): PlanAtomInput {
  return {
    slug,
    seq,
    title: `Atom ${slug}`,
    intent: `Do ${slug}.`,
    touches: [`src/${slug}.ts`],
    acceptance: null,
    dependsOn: [],
    rejected: [],
  };
}

async function build(): Promise<{
  system: System;
  app: Awaited<ReturnType<typeof buildApp>>['app'];
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
  const system = buildSystem(config, {
    backend: new FakePtyBackend(),
    gitObserver: new FakeGitObserver(),
    worktrees: new FakeWorktreeManager(),
    errorMirror: () => {},
  });
  const { app } = await buildApp(system);
  return {
    system,
    app,
    close: async () => {
      await app.close();
      system.store.close();
    },
  };
}

function seedPlan(system: System, issue: number): Plan {
  system.connector.inject({ kind: 'new_issue', number: issue, title: 'Big thing', body: 'Several PRs.' });
  const doc = parsePlanDocument(
    JSON.stringify({
      version: 1,
      reason: 'Schema first.',
      parts: [
        { slug: 'schema', title: 'Schema', scope: 'src/store', dependsOn: [] },
        { slug: 'api', title: 'API', scope: 'src/api', dependsOn: ['schema'] },
      ],
    }),
  );
  assert.ok(doc.ok);
  const { plan } = ingestPlanDocument(system.store, {
    doc: doc.document,
    originRef: `issue:${issue}`,
    title: 'Big thing',
  });
  system.store.plans.setPlanStatus(plan.id, 'active');
  return system.store.plans.getPlan(plan.id)!;
}

function propose(system: System, plan: Plan): void {
  const res = proposePlanAmendment(system.store, {
    plan,
    document: {
      version: 1,
      reason: 'Schema first, but the api part can start now.',
      parts: [
        { slug: 'schema', title: 'Schema', scope: 'src/store', dependsOn: [] },
        { slug: 'api', title: 'API', scope: 'src/api, no longer stacked', dependsOn: [] },
      ],
    },
    note: 'The api part does not need the schema first — the column is already there.',
    author: 'agent',
    authorRef: 'task-1',
  });
  assert.ok(res.ok, res.ok ? '' : res.error);
}
