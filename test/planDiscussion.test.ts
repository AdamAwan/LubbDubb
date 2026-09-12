import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { McpDesktopServer } from '../src/mcp/desktop.js';
import { desktopDeps } from './support/desktop.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { parsePlanDocument } from '../src/plans/planDocument.js';
import { testPartNote } from '../src/plans/planning.js';
import type { Plan } from '../src/types.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';

test('plan_read hands the session the verdict, the parts and the agenda', async () => {
  const { system, session, close } = await buildDesk();
  seedAwaitingApprovalPlan(system);

  const read = await session.call('plan_read', { issue: 231 });
  assert.ok(!read.isError, read.content[0]?.text);
  const body = JSON.parse(read.content[0]!.text) as Record<string, unknown>;
  assert.equal(body.status, 'awaiting_approval');
  assert.equal(body.reason, 'Schema first.');
  assert.equal(body.openQuestions, 'Whether the API part can start before the schema lands.');
  assert.match(body.parts as string, /"schema"/);
  assert.match(body.parts as string, /"api"/);
  assert.match(body.next as string, /awaiting_approval/);
  assert.match(body.next as string, /active/);
  await close();
});

test('plan_read says so rather than inventing one when a goal has no plan', async () => {
  const { system, session, close } = await buildDesk();
  system.connector.inject({ kind: 'new_issue', number: 404, title: 'Unplanned', body: 'Nothing yet.' });

  const read = await session.call('plan_read', { issue: 404 });
  assert.ok(read.isError);
  assert.match(read.content[0]!.text, /no plan/i);
  await close();
});

test('plan_amend records the amendment and withdraws the card it supersedes', async () => {
  const { system, session, close } = await buildDesk();
  const plan = seedAwaitingApprovalPlan(system);
  await system.harness.runCycle('manual');
  const stale = system.store.escalations.listProposals().find((p) => p.kind === 'plan')!;
  assert.equal(stale.status, 'pending');

  const res = await session.call('plan_amend', {
    issue: 231,
    reason: 'The API part does not need the schema first after all.',
    document: '# Amended\n\napi no longer stacks on schema.',
    parts: [
      { slug: 'schema', title: 'Schema', scope: 'src/store', dependsOn: [] },
      { slug: 'api', title: 'API', scope: 'src/api', dependsOn: [] },
    ],
  });
  assert.ok(!res.isError, res.content[0]?.text);
  const body = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
  assert.equal(body.amended, true);
  assert.equal(body.status, 'awaiting_approval');
  assert.match(body.next as string, /cockpit/i);

  const after = system.store.plans.getPlan(plan.id)!;
  assert.equal(after.status, 'awaiting_approval');
  assert.equal(after.reason, 'The API part does not need the schema first after all.');
  assert.equal(
    system.store.plans.listPlanRevisions(plan.id).length,
    2,
    'the amendment is a second revision, not a rewrite',
  );

  assert.equal(system.store.escalations.listProposals().find((p) => p.id === stale.id)!.status, 'rejected');
  assert.ok(system.store.plans.listPlanParts(plan.id).every((p) => p.status !== 'retired'));

  const pending = system.store.escalations.listProposals().filter((p) => p.kind === 'plan' && p.status === 'pending');
  assert.equal(pending.length, 1);
  assert.notEqual(pending[0]!.id, stale.id);
  await close();
});

test('plan_amend on a released plan proposes, and writes nothing over it', async () => {
  const { system, session, close } = await buildDesk();
  const plan = seedAwaitingApprovalPlan(system);
  system.store.plans.setPlanStatus(plan.id, 'active');

  const res = await session.call('plan_amend', {
    issue: 231,
    note: 'The api part does not need the schema first — the column is already there.',
    reason: 'Schema first, but the api part can start now.',
    parts: [
      { slug: 'schema', title: 'Schema', scope: 'src/store', dependsOn: [] },
      { slug: 'api', title: 'API', scope: 'src/api', dependsOn: [] },
    ],
  });
  assert.ok(!res.isError, res.content[0]?.text);
  const body = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
  assert.equal(body.proposed, true);
  assert.equal(body.amended, undefined, 'the two settlements do not share a word');
  assert.deepEqual(body.changes, ['changed api']);
  assert.match(body.means as string, /has not changed/i);
  assert.match(body.next as string, /cockpit/i);

  const after = system.store.plans.getPlan(plan.id)!;
  assert.equal(after.status, 'active', 'the plan keeps scheduling while the question is open');
  assert.equal(after.reason, 'Schema first.', 'and nothing is written over it');
  assert.equal(system.store.plans.listPlanRevisions(plan.id).length, 1);

  const amendments = system.store.plans.listPlanAmendments(plan.id);
  assert.equal(amendments.length, 1);
  assert.equal(amendments[0]!.status, 'pending');
  assert.equal(amendments[0]!.author, 'operator', 'proposed at the operator’s own keyboard, not by an agent');
  await close();
});

test('plan_amend on a released plan refuses without a reason, and writes nothing', async () => {
  const { system, session, close } = await buildDesk();
  const plan = seedAwaitingApprovalPlan(system);
  system.store.plans.setPlanStatus(plan.id, 'active');

  const res = await session.call('plan_amend', {
    issue: 231,
    reason: 'Schema first, but the api part can start now.',
    parts: [{ slug: 'schema', title: 'Schema', scope: 'src/store', dependsOn: [] }],
  });
  assert.ok(res.isError);
  assert.match(res.content[0]!.text, /needs a reason/i);
  assert.deepEqual(system.store.plans.listPlanAmendments(plan.id), []);
  await close();
});

test('plan_amend refuses a plan that is neither awaiting approval nor running', async () => {
  const { system, session, close } = await buildDesk();
  const plan = seedAwaitingApprovalPlan(system);
  system.store.plans.setPlanStatus(plan.id, 'complete');

  const res = await session.call('plan_amend', {
    issue: 231,
    reason: 'no',
    parts: [{ slug: 'schema', title: 'Schema', scope: 'src/store', dependsOn: [] }],
  });
  assert.ok(res.isError);
  assert.match(res.content[0]!.text, /"complete"/);
  assert.equal(system.store.plans.getPlan(plan.id)!.status, 'complete', 'a refused call must not move the plan at all');
  assert.equal(system.store.plans.listPlanRevisions(plan.id).length, 1);
  await close();
});

test('a rejected document writes nothing, so the retry is against an unchanged plan', async () => {
  const { system, session, close } = await buildDesk();
  const plan = seedAwaitingApprovalPlan(system);

  const res = await session.call('plan_amend', { issue: 231, reason: 'no parts at all', parts: [] });
  assert.ok(res.isError);
  assert.match(res.content[0]!.text, /Plan rejected/);

  const after = system.store.plans.getPlan(plan.id)!;
  assert.equal(after.reason, 'Schema first.', 'the plan is exactly as it was');
  assert.equal(system.store.plans.listPlanRevisions(plan.id).length, 1);
  assert.ok(system.store.plans.listPlanParts(plan.id).every((p) => p.status !== 'retired'));
  await close();
});

test('discussing a plan dispatches nothing', async () => {
  const { system, close } = await buildDesk();
  seedAwaitingApprovalPlan(system);
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');

  const planners = system.store.tasks.listTasks().filter((t) => t.originRef === 'issue:231:plan');
  assert.deepEqual(planners, [], 'Discuss is a link now; nothing is put on the planner origin');
  const partTasks = system.store.tasks.listTasks().filter((t) => (t.originRef ?? '').includes(':part:'));
  assert.deepEqual(partTasks, [], 'and an unapproved plan still schedules no parts');
  await close();
});

const WITH_BROWSER: EnvironmentConfig[] = [
  {
    name: 'acceptance',
    at: 'echo unused',
    validate: { permits: ['check'], browser: { runner: 'npm run e2e', listSelectors: 'npm run e2e -- --list' } },
  },
];

test('plan_read hands the discussion the same test-part bar the planning prompts carry', async () => {
  const { system, session, close } = await buildDesk(WITH_BROWSER);
  seedAwaitingApprovalPlan(system);
  system.store.remoteValidation.recordSelectorOffering('acceptance', [
    { selector: 'Checkout Tests', tests: 4 },
    { selector: 'Login Tests', tests: 2 },
  ]);

  const read = await session.call('plan_read', { issue: 231 });
  assert.ok(!read.isError, read.content[0]?.text);
  const body = JSON.parse(read.content[0]!.text) as Record<string, unknown>;
  const bar = body.testPart as string;
  assert.ok(typeof bar === 'string' && bar !== '', 'the bar reaches the operator’s own keyboard, not only the fleet');
  assert.equal(
    bar,
    testPartNote(WITH_BROWSER, system.store.remoteValidation.listSelectorOfferings()).trim(),
    'and it is that string',
  );
  assert.match(bar, /`Checkout Tests`, `Login Tests`/, 'enumerated from the offering cache, so nothing is invented');
  assert.match(bar, /silent and consequential/, 'the bar comes with it rather than the areas alone');
  await close();
});

test('plan_read carries no bar where no environment declares a suite', async () => {
  const { system, session, close } = await buildDesk();
  seedAwaitingApprovalPlan(system);

  const read = await session.call('plan_read', { issue: 231 });
  const body = JSON.parse(read.content[0]!.text) as Record<string, unknown>;
  assert.equal(body.testPart, undefined, 'a discussion is never told to declare a part nobody can build');
  await close();
});

type Session = NonNullable<ReturnType<McpDesktopServer['session']>>;

async function buildDesk(
  environments: EnvironmentConfig[] = [],
): Promise<{ system: System; session: Session; close: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    environments,
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
  const server = new McpDesktopServer({
    ...desktopDeps(system),
    validationRoot: join(dir, 'validation'),
    now: () => new Date().toISOString(),
    socketPath: process.platform === 'win32' ? `\\\\.\\pipe\\lubbdubb-test-${randomUUID()}` : join(dir, 'desktop.sock'),
    credentialPath: join(dir, 'desktop.json'),
  });
  assert.ok(await server.listen(), 'the desktop channel starts on a throwaway path');
  const session = server.session();
  assert.ok(session, 'the channel is up, so it hands out a session');
  return {
    system,
    session,
    close: async () => {
      await server.close();
      system.store.close();
    },
  };
}

function seedAwaitingApprovalPlan(system: System): Plan {
  system.connector.inject({ kind: 'new_issue', number: 231, title: 'Big thing', body: 'Several PRs.' });
  const doc = parsePlanDocument(
    JSON.stringify({
      version: 1,
      reason: 'Schema first.',
      openQuestions: 'Whether the API part can start before the schema lands.',
      parts: [
        { slug: 'schema', title: 'Schema', scope: 'src/store', dependsOn: [] },
        { slug: 'api', title: 'API', scope: 'src/api', dependsOn: ['schema'] },
      ],
    }),
  );
  assert.ok(doc.ok);
  const result = ingestPlanDocument(system.store, { doc: doc.document, originRef: 'issue:231', title: 'Big thing' });
  return result.plan;
}
