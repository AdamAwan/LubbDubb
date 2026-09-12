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
import { parsePlanDocument, planPartInputs } from '../src/plans/planDocument.js';
import { amendmentWarnings, declinePlanAmendment, proposePlanAmendment } from '../src/plans/planAmendment.js';
import { planAmendmentProposalRef } from '../src/proposals/proposals.js';
import type { Plan, PlanAmendment, PlanPartInput, PlanStatus } from '../src/types.js';
import type { PlanHistory } from '../src/wire.js';

test('proposing against a running plan writes a row and schedules nothing', async () => {
  const { system, close } = await build();
  const plan = seedRunningPlan(system);
  const before = snapshotParts(system, plan);

  const proposed = proposePlanAmendment(system.store, {
    plan,
    document: amendedDocument(),
    note: 'The api part does not need the schema first — the column is already there.',
    author: 'agent',
    authorRef: 'task-1',
  });
  assert.ok(proposed.ok, proposed.ok ? '' : proposed.error);

  const rows = system.store.plans.listPlanAmendments(plan.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, 'pending');
  assert.equal(rows[0]!.author, 'agent');

  assert.equal(system.store.plans.getPlan(plan.id)!.status, 'active');
  assert.equal(system.store.plans.listPlanRevisions(plan.id).length, 1, 'nothing is ingested until it is accepted');
  assert.deepEqual(snapshotParts(system, plan), before);

  const moved = proposed.proposed.diff!.parts.filter((p) => p.kind !== 'unchanged');
  assert.deepEqual(
    moved.map((p) => `${p.kind} ${p.slug}`),
    ['changed api', 'added console'],
  );
  await close();
});

test('rule `plan-amendment` proposes once, and the hold suppresses the second', async () => {
  const { system, close } = await build();
  const plan = seedRunningPlan(system);
  propose(system, plan);

  await system.harness.runCycle('manual');
  const cards = system.store.escalations.listProposals().filter((p) => p.kind === 'plan_amendment');
  assert.equal(cards.length, 1, 'the change is put to the operator once');
  assert.equal(cards[0]!.status, 'pending');
  assert.equal(cards[0]!.ref, planAmendmentProposalRef(system.store.plans.listPlanAmendments(plan.id)[0]!.id));

  const escalation = system.store.escalations.listEscalations().find((e) => e.id === cards[0]!.escalationId)!;
  assert.match(String(escalation.context.detail), /the column is already there/);

  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');
  assert.equal(system.store.escalations.listProposals().filter((p) => p.kind === 'plan_amendment').length, 1);
  await close();
});

test('accepting ingests over the running plan, and work in flight keeps its branch and PR', async () => {
  const { system, close } = await build();
  const plan = seedRunningPlan(system);
  propose(system, plan);
  await system.harness.runCycle('manual');
  const card = system.store.escalations.listProposals().find((p) => p.kind === 'plan_amendment')!;
  const api = system.store.plans.listPlanParts(plan.id).find((p) => p.slug === 'api')!;
  system.store.plans.updatePlanPart(api.id, {
    status: 'in_review',
    branch: 'issue/12/api',
    prNumber: 77,
    taskId: 'task-9',
  });
  await system.proposals.accept(card.id, 'yes, fold the console in');

  const after = system.store.plans.getPlan(plan.id)!;
  assert.equal(after.status, 'active', 'the plan stays released — it is not sent back through the gate');
  assert.equal(system.store.plans.listPlanRevisions(plan.id).length, 2, 'applying is the ordinary ingestion');

  const parts = system.store.plans.listPlanParts(plan.id);
  const amended = parts.find((p) => p.slug === 'api')!;
  assert.equal(amended.branch, 'issue/12/api');
  assert.equal(amended.prNumber, 77);
  assert.equal(amended.taskId, 'task-9');
  assert.equal(amended.status, 'in_review');
  assert.equal(amended.scope, 'src/api, no longer stacked on the schema');
  assert.ok(parts.find((p) => p.slug === 'console'));
  assert.equal(system.store.plans.listPlanAmendments(plan.id)[0]!.status, 'applied');
  await close();
});

test('rejecting changes the plan not at all', async () => {
  const { system, close } = await build();
  const plan = seedRunningPlan(system);
  propose(system, plan);
  await system.harness.runCycle('manual');
  const card = system.store.escalations.listProposals().find((p) => p.kind === 'plan_amendment')!;
  const before = snapshotParts(system, plan);

  system.proposals.reject(card.id, 'the split is right, leave it');

  assert.equal(system.store.plans.getPlan(plan.id)!.status, 'active');
  assert.equal(system.store.plans.listPlanRevisions(plan.id).length, 1);
  assert.deepEqual(snapshotParts(system, plan), before);
  assert.equal(system.store.plans.listPlanAmendments(plan.id)[0]!.status, 'declined');

  await system.harness.runCycle('manual');
  assert.equal(
    system.store.escalations.listProposals().filter((p) => p.kind === 'plan_amendment' && p.status === 'pending')
      .length,
    0,
  );
  await close();
});

test('a replan supersedes a pending amendment and withdraws its card', async () => {
  const { system, app, close } = await build();
  const plan = seedRunningPlan(system);
  propose(system, plan);
  await system.harness.runCycle('manual');
  const card = system.store.escalations.listProposals().find((p) => p.kind === 'plan_amendment')!;
  assert.equal(card.status, 'pending');

  const res = await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/replan` });
  assert.equal(res.statusCode, 200);

  assert.equal(system.store.plans.listPlanAmendments(plan.id)[0]!.status, 'superseded');
  assert.equal(system.store.escalations.listProposals().find((p) => p.id === card.id)!.status, 'rejected');
  await close();
});

test('proposePlanAmendment refuses on every status but active, and names the route that fits', async () => {
  const { system, close } = await build();
  const plan = seedRunningPlan(system);
  const statuses: [PlanStatus, RegExp][] = [
    ['awaiting_approval', /amend it in place/],
    ['planning', /a planner already has it/],
    ['complete', /no schedule left/],
    ['abandoned', /stopped deliberately/],
  ];
  for (const [status, why] of statuses) {
    system.store.plans.setPlanStatus(plan.id, status);
    const res = proposePlanAmendment(system.store, {
      plan: system.store.plans.getPlan(plan.id)!,
      document: amendedDocument(),
      note: 'the api part does not need the schema first',
      author: 'agent',
      authorRef: 'task-1',
    });
    assert.ok(!res.ok, `${status} must not accept an amendment`);
    assert.match(res.error, why);
    assert.deepEqual(system.store.plans.listPlanAmendments(plan.id), []);
  }
  await close();
});

test('one pending amendment per plan, and a settled one clears the way for the next', async () => {
  const { system, close } = await build();
  const plan = seedRunningPlan(system);
  const first = propose(system, plan);

  const second = proposePlanAmendment(system.store, {
    plan,
    document: amendedDocument(),
    note: 'and another thing',
    author: 'operator',
    authorRef: null,
  });
  assert.ok(!second.ok);
  assert.match(second.error, /already has an amendment waiting/);
  assert.match(second.error, /the column is already there/);
  assert.equal(system.store.plans.listPlanAmendments(plan.id).length, 1);

  declinePlanAmendment(system.store, first.id);
  const third = proposePlanAmendment(system.store, {
    plan,
    document: amendedDocument(),
    note: 'and another thing',
    author: 'operator',
    authorRef: null,
  });
  assert.ok(third.ok, 'the bar is one *pending*, not one ever');
  await close();
});

test('an amendment with no reason on it is refused before anything is written', async () => {
  const { system, close } = await build();
  const plan = seedRunningPlan(system);
  const res = proposePlanAmendment(system.store, {
    plan,
    document: amendedDocument(),
    note: '   ',
    author: 'agent',
    authorRef: 'task-1',
  });
  assert.ok(!res.ok);
  assert.match(res.error, /needs a reason/);
  assert.deepEqual(system.store.plans.listPlanAmendments(plan.id), []);
  await close();
});

test('the warnings say what applying it would leave standing', async () => {
  const { system, close } = await build();
  const plan = seedRunningPlan(system);
  const parts = system.store.plans.listPlanParts(plan.id);
  system.store.plans.updatePlanPart(parts.find((p) => p.slug === 'schema')!.id, {
    status: 'in_review',
    branch: 'issue/12/schema',
    prNumber: 4,
  });
  system.store.plans.updatePlanPart(parts.find((p) => p.slug === 'api')!.id, { status: 'merged' });

  const dropping = amendedDocument() as { parts: { slug: string }[] };
  dropping.parts = dropping.parts.filter((p) => p.slug !== 'schema');

  const warnings = amendmentWarnings(system.store.plans.listPlanParts(plan.id), declaredParts(dropping));
  assert.equal(warnings.length, 2);
  assert.match(warnings[0]!, /"schema" is dropped[\s\S]*PR #4[\s\S]*keeps running/);
  assert.match(warnings[1]!, /"api" has already finished[\s\S]*does not change what was delivered/);
  await close();
});

test('a re-declared part with work in flight warns, and names its pull request', async () => {
  const { system, close } = await build();
  const plan = seedRunningPlan(system);
  const parts = system.store.plans.listPlanParts(plan.id);
  system.store.plans.updatePlanPart(parts.find((p) => p.slug === 'api')!.id, {
    status: 'in_review',
    branch: 'issue/12/api',
    prNumber: 7,
  });

  const warnings = amendmentWarnings(system.store.plans.listPlanParts(plan.id), declaredParts(amendedDocument()));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /"api" is being worked right now \(in_review\), PR #7/);
  assert.match(warnings[0]!, /rewrites its scope, dependencies/);
  assert.match(warnings[0]!, /neither stops it nor re-dispatches it/);
  await close();
});

test('a re-declared part in flight whose declaration did not move says nothing', async () => {
  const { system, close } = await build();
  const plan = seedRunningPlan(system);
  const parts = system.store.plans.listPlanParts(plan.id);
  system.store.plans.updatePlanPart(parts.find((p) => p.slug === 'schema')!.id, {
    status: 'in_review',
    branch: 'issue/12/schema',
    prNumber: 9,
  });

  assert.deepEqual(amendmentWarnings(system.store.plans.listPlanParts(plan.id), declaredParts(amendedDocument())), []);

  const rewrapped = amendedDocument() as { parts: { slug: string; scope: string }[] };
  rewrapped.parts.find((p) => p.slug === 'schema')!.scope = '  src/store\n';
  assert.deepEqual(amendmentWarnings(system.store.plans.listPlanParts(plan.id), declaredParts(rewrapped)), []);
  await close();
});

test('a dispatched part whose acceptance is rewritten warns before anybody has a PR', async () => {
  const { system, close } = await build();
  const plan = seedRunningPlan(system);
  const parts = system.store.plans.listPlanParts(plan.id);
  system.store.plans.updatePlanPart(parts.find((p) => p.slug === 'schema')!.id, {
    status: 'dispatched',
    branch: 'issue/12/schema',
  });

  const doc = amendedDocument() as { parts: { slug: string; acceptance?: string }[] };
  doc.parts.find((p) => p.slug === 'schema')!.acceptance = 'The column is nullable and backfilled.';
  const warnings = amendmentWarnings(system.store.plans.listPlanParts(plan.id), declaredParts(doc));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /"schema" is being worked right now \(dispatched\) and this amendment rewrites its /);
  assert.match(warnings[0]!, /acceptance/);
  assert.doesNotMatch(warnings[0]!, /PR #/);
  await close();
});

test("the plan sheet's history carries the change waiting on the operator", async () => {
  const { system, app, close } = await build();
  const plan = seedRunningPlan(system);

  const before = await app.inject({ method: 'GET', url: `/api/plans/${plan.id}/history` });
  assert.equal((before.json() as PlanHistory).pending, null, 'null is the ordinary shape');

  propose(system, plan);
  const res = await app.inject({ method: 'GET', url: `/api/plans/${plan.id}/history` });
  const history = res.json() as PlanHistory;
  assert.ok(history.pending);
  assert.equal(history.pending.author, 'agent');
  assert.match(history.pending.note, /the column is already there/);
  assert.deepEqual(
    history.pending.diff!.parts.filter((p) => p.kind !== 'unchanged').map((p) => `${p.kind} ${p.slug}`),
    ['changed api', 'added console'],
  );
  assert.equal(history.diff, null);
  await close();
});

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

function seedRunningPlan(system: System): Plan {
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Big thing', body: 'Several PRs.' });
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
  const { plan } = ingestPlanDocument(system.store, { doc: doc.document, originRef: 'issue:12', title: 'Big thing' });
  system.store.plans.setPlanStatus(plan.id, 'active');
  return system.store.plans.getPlan(plan.id)!;
}

function amendedDocument(): unknown {
  return {
    version: 1,
    reason: 'Schema first, but the api part can start now.',
    parts: [
      { slug: 'schema', title: 'Schema', scope: 'src/store', dependsOn: [] },
      { slug: 'api', title: 'API', scope: 'src/api, no longer stacked on the schema', dependsOn: [] },
      { slug: 'console', title: 'Console', scope: 'web/src', dependsOn: ['api'] },
    ],
  };
}

function declaredParts(document: unknown): PlanPartInput[] {
  const parsed = parsePlanDocument(JSON.stringify(document));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  return planPartInputs(parsed.document);
}

function propose(system: System, plan: Plan): PlanAmendment {
  const res = proposePlanAmendment(system.store, {
    plan,
    document: amendedDocument(),
    note: 'The api part does not need the schema first — the column is already there.',
    author: 'agent',
    authorRef: 'task-1',
  });
  assert.ok(res.ok, res.ok ? '' : res.error);
  return res.proposed.amendment;
}

function snapshotParts(system: System, plan: Plan): unknown {
  return system.store.plans
    .listPlanParts(plan.id)
    .map((p) => ({ slug: p.slug, status: p.status, branch: p.branch, prNumber: p.prNumber, taskId: p.taskId }));
}
