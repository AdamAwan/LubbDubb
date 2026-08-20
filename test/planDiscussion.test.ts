import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { McpDesktopServer } from '../src/mcp/desktop.js';
import { ingestPlanDocument } from '../src/plans/planIngest.js';
import { parsePlanDocument } from '../src/plans/planDocument.js';
import type { Plan } from '../src/types.js';

/**
 * Discussing a plan, which is now a conversation at the operator's own keyboard
 * rather than a dispatch.
 *
 * The cockpit's half is a `claude://code/new` link and writes nothing, so there is
 * nothing here to drive it with: everything that *happens* happens through the
 * desktop channel's two plan tools, and this drives them through
 * `McpDesktopServer.session()` — the in-process caller that converges on the same
 * `dispatch` the operator's bridge reaches. There is no test-only tool path.
 */

test('plan_read hands the session the verdict, the parts and the agenda', async () => {
  const { system, session, close } = await buildDesk();
  seedAwaitingApprovalPlan(system);

  const read = await session.call('plan_read', { issue: 231 });
  assert.ok(!read.isError, read.content[0]?.text);
  const body = JSON.parse(read.content[0]!.text) as Record<string, unknown>;
  assert.equal(body.status, 'awaiting_approval');
  assert.equal(body.reason, 'Schema first.');
  // The planner's own nomination of what to argue about — the agenda a discussion
  // opens on when the operator has not brought one of their own.
  assert.equal(body.openQuestions, 'Whether the API part can start before the schema lands.');
  // The parts carry their slugs, because the slug is what an amendment merges on
  // and a session shown only prose would re-declare them under new names.
  assert.match(body.parts as string, /"schema"/);
  assert.match(body.parts as string, /"api"/);
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
  await system.harness.runCycle('manual'); // rule `plan-approval` writes the proposal
  const stale = system.store.listProposals().find((p) => p.kind === 'plan')!;
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
  // The hand-back wording is the whole of what the session tells the operator, so
  // it has to name the cockpit rather than leaving the reply a bare ok.
  assert.match(body.next as string, /cockpit/i);

  const after = system.store.getPlan(plan.id)!;
  assert.equal(after.status, 'awaiting_approval');
  assert.equal(after.reason, 'The API part does not need the schema first after all.');
  assert.equal(system.store.listPlanRevisions(plan.id).length, 2, 'the amendment is a second revision, not a rewrite');

  // The withdrawal is not optional: a pending proposal holds rule `plan-approval`
  // off this plan, so without it the operator walks back to a card describing the
  // decomposition from *before* the conversation.
  assert.equal(system.store.listProposals().find((p) => p.id === stale.id)!.status, 'rejected');
  // ...and withdrawing must retire nothing. `refusePlan` settles a plan that is
  // still `awaiting_approval` — the status write before the rejection is what
  // makes it a no-op, and this is the assertion that catches its removal.
  assert.ok(system.store.listPlanParts(plan.id).every((p) => p.status !== 'retired'));

  // A *fresh* card, put up by the cycle `plan_amend` runs, so it is there when
  // they look rather than at the next heartbeat.
  const pending = system.store.listProposals().filter((p) => p.kind === 'plan' && p.status === 'pending');
  assert.equal(pending.length, 1);
  assert.notEqual(pending[0]!.id, stale.id);
  await close();
});

test('plan_amend refuses a released plan and leaves it untouched', async () => {
  const { system, session, close } = await buildDesk();
  const plan = seedAwaitingApprovalPlan(system);
  // Released, with its parts scheduling off that decision. Amending writes
  // `awaiting_approval` back over it, which reopens a gate rule `plan-part` had
  // cleared and stops the rest of the work — for a conversation nobody asked to
  // be a hold.
  system.store.setPlanStatus(plan.id, 'active');

  const res = await session.call('plan_amend', {
    issue: 231,
    reason: 'no',
    parts: [{ slug: 'schema', title: 'Schema', scope: 'src/store', dependsOn: [] }],
  });
  assert.ok(res.isError);
  assert.match(res.content[0]!.text, /not awaiting approval/i);

  const after = system.store.getPlan(plan.id)!;
  assert.equal(after.status, 'active', 'a refused call must not move the plan at all');
  assert.equal(system.store.listPlanRevisions(plan.id).length, 1);
  await close();
});

test('a rejected document writes nothing, so the retry is against an unchanged plan', async () => {
  const { system, session, close } = await buildDesk();
  const plan = seedAwaitingApprovalPlan(system);

  const res = await session.call('plan_amend', { issue: 231, reason: 'no parts at all', parts: [] });
  assert.ok(res.isError);
  assert.match(res.content[0]!.text, /Plan rejected/);

  const after = system.store.getPlan(plan.id)!;
  assert.equal(after.reason, 'Schema first.', 'the plan is exactly as it was');
  assert.equal(system.store.listPlanRevisions(plan.id).length, 1);
  // Nothing is half-applied — including the proposal withdrawal, which happens
  // after validation for exactly this reason.
  assert.ok(system.store.listPlanParts(plan.id).every((p) => p.status !== 'retired'));
  await close();
});

test('discussing a plan dispatches nothing', async () => {
  const { system, close } = await buildDesk();
  seedAwaitingApprovalPlan(system);
  // Several pulses: "no planner, however many pulses run" is only a meaningful
  // assertion once more than one has actually happened. There is no status write
  // any more — the plan simply stays `awaiting_approval` while they talk, which is
  // a status rule `issue-plan` does not dispatch from and rule `plan-part` queues
  // as `unapproved`.
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');

  const planners = system.store.listTasks().filter((t) => t.originRef === 'issue:231:plan');
  assert.deepEqual(planners, [], 'Discuss is a link now; nothing is put on the planner origin');
  const partTasks = system.store.listTasks().filter((t) => (t.originRef ?? '').includes(':part:'));
  assert.deepEqual(partTasks, [], 'and an unapproved plan still schedules no parts');
  await close();
});

// -- fixtures ----------------------------------------------------------------

type Session = NonNullable<ReturnType<McpDesktopServer['session']>>;

/**
 * A `System` and a live desktop channel on throwaway paths — never the operator's
 * real socket or home directory, which is what `system.desktop` would bind.
 */
async function buildDesk(): Promise<{ system: System; session: Session; close: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const config = loadConfig({
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
    // Without this a rule that dispatches a code agent cuts a real branch in
    // whatever checkout the suite is running in — see CLAUDE.md. Nothing here is
    // about git behaviour, and the point of most of these tests is that nothing
    // is dispatched at all.
    worktrees: new FakeWorktreeManager(),
    errorMirror: () => {},
  });
  const server = new McpDesktopServer({
    store: system.store,
    claimMinutes: 60,
    validationRoot: join(dir, 'validation'),
    localRun: () => system.localRun,
    proposals: () => system.proposals,
    runCycle: () => system.harness.runCycle('manual').then(() => undefined),
    now: () => new Date().toISOString(),
    // A named pipe on Windows, where a filesystem path is not bindable at all —
    // the channel itself short-circuits on `\\`. Unique per test either way, so
    // nothing here can collide with a harness the operator is actually running.
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

/** An issue already decomposed into two parts, parked `awaiting_approval`. */
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
