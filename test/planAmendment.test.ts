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
import { amendmentWarnings, declinePlanAmendment, proposePlanAmendment } from '../src/plans/planAmendment.js';
import { planAmendmentProposalRef } from '../src/proposals/proposals.js';
import type { Plan, PlanAmendment, PlanStatus } from '../src/types.js';
import type { PlanHistory } from '../src/wire.js';

/**
 * Amending a plan that is **already running**.
 *
 * `src/plans/planAmendment.ts` states the design; every test here is one of the
 * three properties it turns on, and all three are properties of the harness *not*
 * doing something — the plan keeps scheduling, nobody but an operator applies it,
 * and a rejection changes nothing. None of those is visible in a return value, so
 * each is asserted against the store and the dispatcher rather than against a
 * reply.
 */

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

  const rows = system.store.listPlanAmendments(plan.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, 'pending');
  assert.equal(rows[0]!.author, 'agent');

  // The whole point: the plan is untouched, so the parts that were dispatchable
  // still are. A proposal that moved the plan would be a replan with extra steps.
  assert.equal(system.store.getPlan(plan.id)!.status, 'active');
  assert.equal(system.store.listPlanRevisions(plan.id).length, 1, 'nothing is ingested until it is accepted');
  assert.deepEqual(snapshotParts(system, plan), before);

  // And the diff the operator will read is computed at proposal time, against the
  // revision it amends — so the reply names the change actually described.
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
  const cards = system.store.listProposals().filter((p) => p.kind === 'plan_amendment');
  assert.equal(cards.length, 1, 'the change is put to the operator once');
  assert.equal(cards[0]!.status, 'pending');
  assert.equal(cards[0]!.ref, planAmendmentProposalRef(system.store.listPlanAmendments(plan.id)[0]!.id));

  // The card carries the author's reason and what applying it would leave
  // standing — the reading a diff alone cannot give.
  const escalation = system.store.listEscalations().find((e) => e.id === cards[0]!.escalationId)!;
  assert.match(String(escalation.context.detail), /the column is already there/);

  // Several more pulses: the row is still pending, so without the hold the rule
  // would raise a fresh card on every one of them.
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');
  assert.equal(system.store.listProposals().filter((p) => p.kind === 'plan_amendment').length, 1);
  await close();
});

test('accepting ingests over the running plan, and work in flight keeps its branch and PR', async () => {
  const { system, close } = await build();
  const plan = seedRunningPlan(system);
  propose(system, plan);
  await system.harness.runCycle('manual');
  const card = system.store.listProposals().find((p) => p.kind === 'plan_amendment')!;
  // The `api` part is being worked: an agent has it, on a branch, with a pull
  // request open. This is the state the whole design is for, and it is set after
  // the card is up so what the accept does to it is the only thing moving it.
  const api = system.store.listPlanParts(plan.id).find((p) => p.slug === 'api')!;
  system.store.updatePlanPart(api.id, { status: 'in_review', branch: 'issue/12/api', prNumber: 77, taskId: 'task-9' });
  await system.proposals.accept(card.id, 'yes, fold the console in');

  const after = system.store.getPlan(plan.id)!;
  assert.equal(after.status, 'active', 'the plan stays released — it is not sent back through the gate');
  assert.equal(system.store.listPlanRevisions(plan.id).length, 2, 'applying is the ordinary ingestion');

  const parts = system.store.listPlanParts(plan.id);
  const amended = parts.find((p) => p.slug === 'api')!;
  // Merged on slug: only the *declaration* is refreshed. Losing any of these three
  // would orphan a running agent's work from the plan it is being judged against.
  assert.equal(amended.branch, 'issue/12/api');
  assert.equal(amended.prNumber, 77);
  assert.equal(amended.taskId, 'task-9');
  assert.equal(amended.status, 'in_review');
  assert.equal(amended.scope, 'src/api, no longer stacked on the schema');
  // The new part arrives schedulable, which is what makes an amendment worth
  // accepting rather than replanning.
  assert.ok(parts.find((p) => p.slug === 'console'));
  assert.equal(system.store.listPlanAmendments(plan.id)[0]!.status, 'applied');
  await close();
});

test('rejecting changes the plan not at all', async () => {
  const { system, close } = await build();
  const plan = seedRunningPlan(system);
  propose(system, plan);
  await system.harness.runCycle('manual');
  const card = system.store.listProposals().find((p) => p.kind === 'plan_amendment')!;
  // Taken after the pulse: the plan is running, so that pulse dispatched a part —
  // which is itself the property this whole surface is for. What must not move is
  // where the refusal leaves it.
  const before = snapshotParts(system, plan);

  system.proposals.reject(card.id, 'the split is right, leave it');

  // The one settlement in the funnel with no effect on the goal. A refused *plan*
  // has to leave the issue a route; a refused amendment leaves the plan that was
  // already scheduling it, which is the route.
  assert.equal(system.store.getPlan(plan.id)!.status, 'active');
  assert.equal(system.store.listPlanRevisions(plan.id).length, 1);
  assert.deepEqual(snapshotParts(system, plan), before);
  assert.equal(system.store.listPlanAmendments(plan.id)[0]!.status, 'declined');

  // And it is not re-asked on the next pulse: a declined row is not pending.
  await system.harness.runCycle('manual');
  assert.equal(
    system.store.listProposals().filter((p) => p.kind === 'plan_amendment' && p.status === 'pending').length,
    0,
  );
  await close();
});

test('a replan supersedes a pending amendment and withdraws its card', async () => {
  const { system, app, close } = await build();
  const plan = seedRunningPlan(system);
  propose(system, plan);
  await system.harness.runCycle('manual');
  const card = system.store.listProposals().find((p) => p.kind === 'plan_amendment')!;
  assert.equal(card.status, 'pending');

  const res = await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/replan` });
  assert.equal(res.statusCode, 200);

  // Both halves matter. The row: a replan replaces the document the amendment was
  // written against, so the question it puts is about a plan that no longer
  // exists — and `applyPlanAmendment` refuses outside `active`, so leaving it
  // pending would leave it in the inbox for good.
  assert.equal(system.store.listPlanAmendments(plan.id)[0]!.status, 'superseded');
  // The card: an operator who approved a change and saw nothing happen learns not
  // to trust the card.
  assert.equal(system.store.listProposals().find((p) => p.id === card.id)!.status, 'rejected');
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
    system.store.setPlanStatus(plan.id, status);
    const res = proposePlanAmendment(system.store, {
      plan: system.store.getPlan(plan.id)!,
      document: amendedDocument(),
      note: 'the api part does not need the schema first',
      author: 'agent',
      authorRef: 'task-1',
    });
    assert.ok(!res.ok, `${status} must not accept an amendment`);
    assert.match(res.error, why);
    // A refusal writes nothing — including no amendment row to be found later by
    // a rule that does not care why it is there.
    assert.deepEqual(system.store.listPlanAmendments(plan.id), []);
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
  // Two cards in front of one person are two descriptions of the same plan, and
  // accepting both would apply the older document over the newer one. The refusal
  // names the standing one so the author can fold their change into it.
  assert.ok(!second.ok);
  assert.match(second.error, /already has an amendment waiting/);
  assert.match(second.error, /the column is already there/);
  assert.equal(system.store.listPlanAmendments(plan.id).length, 1);

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
  assert.deepEqual(system.store.listPlanAmendments(plan.id), []);
  await close();
});

test('the warnings say what applying it would leave standing', async () => {
  const { system, close } = await build();
  const plan = seedRunningPlan(system);
  const parts = system.store.listPlanParts(plan.id);
  // A dropped part somebody is halfway through: `partsToRetire` spares it, so the
  // amendment does not stop it and only the operator can end that run.
  system.store.updatePlanPart(parts.find((p) => p.slug === 'schema')!.id, {
    status: 'in_review',
    branch: 'issue/12/schema',
    prNumber: 4,
  });
  // And a re-declared part that has already finished: its declaration is
  // rewritten while what it delivered stays as it was.
  system.store.updatePlanPart(parts.find((p) => p.slug === 'api')!.id, { status: 'merged' });

  const warnings = amendmentWarnings(system.store.listPlanParts(plan.id), ['api', 'console']);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0]!, /"schema" is dropped[\s\S]*PR #4[\s\S]*keeps running/);
  assert.match(warnings[1]!, /"api" has already finished[\s\S]*does not change what was delivered/);
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
  // The server's own reading, and the same one `latestPlanDiff` gives once it is
  // applied: a change must not look like a different kind of thing either side of
  // the decision that applies it.
  assert.deepEqual(
    history.pending.diff!.parts.filter((p) => p.kind !== 'unchanged').map((p) => `${p.kind} ${p.slug}`),
    ['changed api', 'added console'],
  );
  // The plan itself has one revision and nothing to compare it to — the pending
  // block is drawn on a plan with no history at all, which is the commonest case.
  assert.equal(history.diff, null);
  await close();
});

// -- fixtures ----------------------------------------------------------------

/**
 * A whole `System` on a throwaway database, with the fakes the seam wants —
 * `worktrees` above all: without it a rule that dispatches a code agent cuts a
 * real branch in whatever checkout the suite is running in, and nothing deletes
 * it (CLAUDE.md).
 */
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

/** An issue decomposed into two parts and **released** — the state an amendment is about. */
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
  system.store.setPlanStatus(plan.id, 'active');
  return system.store.getPlan(plan.id)!;
}

/** The same amendment throughout: `api` unstacked, and a third part added. */
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

/** Every part's *progress*, which is the half an amendment must not move on its own. */
function snapshotParts(system: System, plan: Plan): unknown {
  return system.store
    .listPlanParts(plan.id)
    .map((p) => ({ slug: p.slug, status: p.status, branch: p.branch, prNumber: p.prNumber, taskId: p.taskId }));
}
