import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import type { Escalation } from '../src/types.js';
import { gitRepo } from './support/gitRepo.js';
import { failPlanningOpen } from './support/plans.js';

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    // Own repo, not the ambient checkout: a code dispatch cuts a real worktree, and
    // the CI checkout is a detached shallow clone with no `main` to cut it from.
    repoRoot: gitRepo(),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    // The assessor and the assay are pinned off: they default **on**, and this
    // file is about something else — leaving them on would put an extra agent in
    // front of every issue these assertions dispatch. Each has its own tests.
    // (The planning funnel cannot be pinned off; a goal is planned by writing the
    // funnel having failed open on it — `failPlanningOpen`.)
  });
}

/** Bring up one live agent parked on a single open escalation. */
async function agentWithOpenEscalation(
  system: System,
  backend: FakePtyBackend,
): Promise<{ agentId: string; escalationId: string }> {
  system.connector.inject({ kind: 'new_issue', number: 901, title: 'Needs a call' });
  failPlanningOpen(system.store, 901);
  await system.harness.runCycle('manual');
  const agentId = system.store.listAgentsByStatus('starting', 'running')[0]!.id;
  backend.last().emit('@@LUBBDUBB_WAITING:Which provider should I use?@@');
  const escalationId = system.store.listOpenEscalations()[0]!.id;
  return { agentId, escalationId };
}

test('full desk-task loop: inject -> dispatch -> agent waits -> escalate -> answer -> done', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { backend });

  // The funnel is off above, so an open issue with no PR is exactly one `issue-pickup`
  // pickup — one agent, on the issue's own branch.
  system.connector.inject({ kind: 'new_issue', number: 902, title: 'Add login' });
  failPlanningOpen(system.store, 902);
  await system.harness.runCycle('manual');

  // An agent should now be live.
  const live = system.store.listAgentsByStatus('starting', 'running');
  assert.equal(live.length, 1, 'one agent should be running');
  const agentId = live[0]!.id;
  assert.equal(backend.spawned.length, 1);

  // The agent narrates, then asks for a decision -> a waiting escalation that
  // carries enough context to answer in-place.
  backend.last().emit('Reading the login issue…\nUnsure which identity provider to target.\n');
  backend.last().emit('@@LUBBDUBB_WAITING:Which auth provider should I assume?@@');
  const open = system.store.listOpenEscalations();
  assert.equal(open.length, 1, 'a waiting agent should raise one escalation');
  assert.equal(open[0]!.agentId, agentId);
  assert.equal(system.store.getAgent(agentId)!.status, 'waiting');
  // Enriched context: the originating signal and a tail of the agent's output.
  const ctx = open[0]!.context;
  // The escalation carries the task's originating signal (the issue pickup ref).
  assert.equal(ctx.originRef, system.store.getTask(live[0]!.taskId)!.originRef);
  assert.match(String(ctx.originRef), /^issue:902$/);
  assert.match(String(ctx.recentOutput), /identity provider/);
  assert.doesNotMatch(String(ctx.recentOutput), /LUBBDUBB/, 'sentinels are stripped from the excerpt');

  // Human answers -> typed straight into the live session.
  const result = system.escalations.answer(open[0]!.id, 'Assume OAuth via Azure AD');
  assert.equal(result.routing, 'typed_into_agent');
  assert.match(backend.last().writes.at(-1)!, /Azure AD/);
  assert.equal(system.store.getAgent(agentId)!.status, 'running');

  // Agent finishes.
  backend.last().emit('done here @@LUBBDUBB_DONE@@');
  assert.equal(system.store.getAgent(agentId)!.status, 'done');
  const task = system.store.getTask(live[0]!.taskId)!;
  assert.equal(task.status, 'done');

  system.store.close();
});

test('the watch gate gates dispatch at the buildSystem seam; untagged issues stay visible', async () => {
  const backend = new FakePtyBackend();
  const config = testConfig();
  config.labelPrefix = 'agent'; // → watch tag "agent-watch"
  const system = buildSystem(config, { backend });

  system.connector.inject({ kind: 'new_issue', number: 101, title: 'tagged', labels: ['agent-watch'] });

  failPlanningOpen(system.store, 101);
  system.connector.inject({ kind: 'new_issue', number: 102, title: 'untagged', labels: ['bug'] });
  failPlanningOpen(system.store, 102);
  await system.harness.runCycle('manual');

  // Only the labelled issue starts an agent...
  const live = system.store.listAgentsByStatus('starting', 'running');
  assert.equal(live.length, 1, 'only the labelled issue is picked up');
  const task = system.store.getTask(live[0]!.taskId)!;
  assert.equal(task.branch, 'issue/101');

  // ...but the untagged issue remains visible in the world snapshot.
  const world = await system.connector.getState();
  assert.deepEqual(
    world.issues.map((i) => i.number).sort((a, b) => a - b),
    [101, 102],
    'both issues remain in /api/state',
  );
  system.store.close();
});

test('whitelisted waiting prompts are auto-answered without escalating', async () => {
  const backend = new FakePtyBackend();
  const config = testConfig();
  config.whitelistedApprovals = [{ match: 'Allow running tests', response: 'yes' }];
  const system = buildSystem(config, { backend });

  system.connector.inject({ kind: 'new_issue', number: 903, title: 'Trivial' });

  failPlanningOpen(system.store, 903);
  await system.harness.runCycle('manual');

  backend.last().emit('@@LUBBDUBB_WAITING:Allow running tests?@@');
  assert.equal(system.store.listOpenEscalations().length, 0, 'whitelisted prompt should not escalate');
  // The whitelisted response is typed in; the payload (framed as a bracketed paste)
  // and its submitting CR are written separately (see PtySession.send), so the last
  // write is the CR.
  assert.ok(
    backend.last().writes.some((w) => w.includes('yes')),
    'the whitelisted response is typed in',
  );
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(backend.last().writes.at(-1), '\r');
  system.store.close();
});

test('executor concurrency cap defers dispatches beyond the limit', async () => {
  const backend = new FakePtyBackend();
  const config = testConfig();
  config.maxConcurrentAgents = 1;
  const system = buildSystem(config, { backend });

  // Hand the executor a plan with two desk dispatches; the cap must defer one.
  const plan = {
    rationale: 'test',
    rejected: [],
    actions: [
      { type: 'dispatch_desk_agent', title: 'A', prompt: 'a', originRef: 'x:a', reason: 'r' },
      { type: 'dispatch_desk_agent', title: 'B', prompt: 'b', originRef: 'x:b', reason: 'r' },
    ],
  } as unknown as import('../src/dispatcher/dispatcher.js').DispatchResult;

  const summary = await system.executor.execute('cyc_test', plan);
  assert.equal(summary.executed, 1);
  assert.equal(summary.deferred, 1);
  assert.equal(system.store.countLiveAgents(), 1);
  system.store.close();
});

test('boot detection parks an orphaned agent for a decision instead of burying it', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { backend });
  system.connector.inject({ kind: 'new_issue', number: 904, title: 'Work' });
  failPlanningOpen(system.store, 904);
  await system.harness.runCycle('manual');

  const agentId = system.store.listAgentsByStatus('starting', 'running')[0]!.id;
  // Simulate a crash: the process is gone but the DB still says "running".
  const crashed = system.recovery.detect();
  assert.equal(crashed.length, 1);
  assert.equal(crashed[0]!.agentId, agentId);
  assert.equal(system.store.getAgent(agentId)!.status, 'crashed');
  // The task is untouched — the work is still outstanding until someone says so.
  assert.equal(system.store.getTask(system.store.getAgent(agentId)!.taskId)!.status, 'running');
  // The raw runtime can't resume, so restore isn't on offer and says why.
  assert.equal(crashed[0]!.restorable, false);
  assert.match(crashed[0]!.restoreBlocked!, /cannot resume/);

  const decided = system.recovery.decide(crashed[0]!.taskId, 'remove');
  assert.equal(decided.ok, true);
  assert.equal(system.store.getAgent(agentId)!.status, 'interrupted');
  assert.equal(system.store.getTask(system.store.getAgent(agentId)!.taskId)!.status, 'interrupted');
  system.store.close();
});

test('killing a waiting agent auto-dismisses its open escalations with a reason', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { backend });
  const { agentId, escalationId } = await agentWithOpenEscalation(system, backend);

  const dismissedEvents: Escalation[] = [];
  system.escalations.on('dismissed', (e: Escalation) => dismissedEvents.push(e));

  system.agents.kill(agentId);

  const after = system.store.getEscalation(escalationId)!;
  assert.equal(after.status, 'dismissed');
  const dismissal = after.context.dismissal as { reason: string; at: string };
  assert.equal(dismissal.reason, 'agent killed');
  assert.ok(dismissal.at, 'dismissal timestamp recorded');
  assert.equal(system.store.listOpenEscalations().length, 0, 'dropped out of "Needs you"');
  assert.equal(dismissedEvents.length, 1, 'emitted a dismissed event for the live refresh');
  // Not silent: the dismissal is in the audit log.
  assert.ok(
    system.store.listDecisions().some((d) => d.detail.includes(escalationId) && d.detail.includes('agent killed')),
    'dismissal written to the decision log',
  );
  system.store.close();
});

test('an agent that fails auto-dismisses its open escalations', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { backend });
  const { escalationId } = await agentWithOpenEscalation(system, backend);

  // Non-zero exit with no done sentinel => the session fails.
  backend.last().emitExit(1);

  const after = system.store.getEscalation(escalationId)!;
  assert.equal(after.status, 'dismissed');
  assert.equal((after.context.dismissal as { reason: string }).reason, 'agent failed');
  system.store.close();
});

test('an agent that finishes with its own question still open auto-dismisses it', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { backend });
  const { escalationId } = await agentWithOpenEscalation(system, backend);

  // The agent answered its own question and carried on to the end. Nobody is left
  // to hear a reply, so the card must not sit in "Needs you" for good.
  backend.last().emit('sorted it myself @@LUBBDUBB_DONE@@');

  const after = system.store.getEscalation(escalationId)!;
  assert.equal(after.status, 'dismissed');
  assert.equal((after.context.dismissal as { reason: string }).reason, 'agent finished its work');
  assert.equal(system.store.listOpenEscalations().length, 0, 'dropped out of "Needs you"');
  system.store.close();
});

test('the pulse sweeps an escalation whose agent died without a terminal event', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { backend });
  const { agentId, escalationId } = await agentWithOpenEscalation(system, backend);

  // Stand in for a death that reached no listener: the row is terminal, the
  // question is still open. This is the shape the backstop exists for.
  system.store.updateAgent(agentId, { status: 'failed', endedAt: new Date().toISOString(), pid: null });
  assert.equal(system.store.getEscalation(escalationId)!.status, 'open');

  await system.harness.runCycle('manual');

  const after = system.store.getEscalation(escalationId)!;
  assert.equal(after.status, 'dismissed');
  assert.match((after.context.dismissal as { reason: string }).reason, /^agent failed;/);

  // Idempotent: a second pulse over a clean inbox dismisses nothing more.
  await system.harness.runCycle('manual');
  const dismissals = system.store.listDecisions().filter((d) => d.detail.includes(`Auto-dismissed escalation`));
  assert.equal(dismissals.length, 1, 'swept once, not once per pulse');
  system.store.close();
});

test("a crashed agent's open escalation survives detection and is dismissed only by the verdict", async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { backend });
  const { agentId, escalationId } = await agentWithOpenEscalation(system, backend);

  // Detection decides nothing, so the question the agent asked is still open —
  // it has to be, or a `restore` would come back to an agent parked on a question
  // that no longer exists anywhere.
  system.recovery.detect();
  assert.equal(system.store.getEscalation(escalationId)!.status, 'open');

  system.recovery.decide(system.store.getAgent(agentId)!.taskId, 'remove');
  const after = system.store.getEscalation(escalationId)!;
  assert.equal(after.status, 'dismissed');
  assert.equal((after.context.dismissal as { reason: string }).reason, 'agent crashed; work dropped');
  system.store.close();
});

test('dismissal is scoped: a still-live agents escalations are left untouched', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { backend });
  const { escalationId } = await agentWithOpenEscalation(system, backend);

  // A different agent dying must not touch this live agent's escalation.
  system.escalations.dismissEscalationsForAgent('agent_someone_else', 'agent killed');

  assert.equal(system.store.getEscalation(escalationId)!.status, 'open');
  assert.equal(system.store.listOpenEscalations().length, 1);
  system.store.close();
});
