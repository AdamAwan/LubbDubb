import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
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
    repoRoot: gitRepo(),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
}

async function agentWithOpenEscalation(
  system: System,
  backend: FakePtyBackend,
): Promise<{ agentId: string; escalationId: string }> {
  system.connector.inject({ kind: 'new_issue', number: 901, title: 'Needs a call' });
  failPlanningOpen(system.store, 901);
  await system.harness.runCycle('manual');
  const agentId = system.store.agents.listAgentsByStatus('starting', 'running')[0]!.id;
  backend.last().emit('@@LUBBDUBB_WAITING:Which provider should I use?@@');
  const escalationId = system.store.escalations.listOpenEscalations()[0]!.id;
  return { agentId, escalationId };
}

test('full desk-task loop: inject -> dispatch -> agent waits -> escalate -> answer -> done', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { backend });

  system.connector.inject({ kind: 'new_issue', number: 902, title: 'Add login' });
  failPlanningOpen(system.store, 902);
  await system.harness.runCycle('manual');

  const live = system.store.agents.listAgentsByStatus('starting', 'running');
  assert.equal(live.length, 1, 'one agent should be running');
  const agentId = live[0]!.id;
  assert.equal(backend.spawned.length, 1);

  backend.last().emit('Reading the login issue…\nUnsure which identity provider to target.\n');
  backend.last().emit('@@LUBBDUBB_WAITING:Which auth provider should I assume?@@');
  const open = system.store.escalations.listOpenEscalations();
  assert.equal(open.length, 1, 'a waiting agent should raise one escalation');
  assert.equal(open[0]!.agentId, agentId);
  assert.equal(system.store.agents.getAgent(agentId)!.status, 'waiting');
  const ctx = open[0]!.context;
  assert.equal(ctx.originRef, system.store.tasks.getTask(live[0]!.taskId)!.originRef);
  assert.match(String(ctx.originRef), /^issue:902$/);
  assert.match(String(ctx.recentOutput), /identity provider/);
  assert.doesNotMatch(String(ctx.recentOutput), /LUBBDUBB/, 'sentinels are stripped from the excerpt');

  const result = system.escalations.answer(open[0]!.id, 'Assume OAuth via Azure AD');
  assert.equal(result.routing, 'typed_into_agent');
  assert.match(backend.last().writes.at(-1)!, /Azure AD/);
  assert.equal(system.store.agents.getAgent(agentId)!.status, 'running');

  backend.last().emit('done here @@LUBBDUBB_DONE@@');
  assert.equal(system.store.agents.getAgent(agentId)!.status, 'done');
  const task = system.store.tasks.getTask(live[0]!.taskId)!;
  assert.equal(task.status, 'done');

  system.store.close();
});

test('the watch gate gates dispatch at the buildSystem seam; untagged issues stay visible', async () => {
  const backend = new FakePtyBackend();
  const config = testConfig();
  config.labelPrefix = 'agent';
  const system = buildSystem(config, { backend });

  system.connector.inject({ kind: 'new_issue', number: 101, title: 'tagged', labels: ['agent-watch'] });

  failPlanningOpen(system.store, 101);
  system.connector.inject({ kind: 'new_issue', number: 102, title: 'untagged', labels: ['bug'] });
  failPlanningOpen(system.store, 102);
  await system.harness.runCycle('manual');

  const live = system.store.agents.listAgentsByStatus('starting', 'running');
  assert.equal(live.length, 1, 'only the labelled issue is picked up');
  const task = system.store.tasks.getTask(live[0]!.taskId)!;
  assert.equal(task.branch, 'issue/101');

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
  assert.equal(system.store.escalations.listOpenEscalations().length, 0, 'whitelisted prompt should not escalate');
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
  assert.equal(system.store.agents.countLiveAgents(), 1);
  system.store.close();
});

test('boot detection parks an orphaned agent for a decision instead of burying it', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { backend });
  system.connector.inject({ kind: 'new_issue', number: 904, title: 'Work' });
  failPlanningOpen(system.store, 904);
  await system.harness.runCycle('manual');

  const agentId = system.store.agents.listAgentsByStatus('starting', 'running')[0]!.id;
  const crashed = system.recovery.detect();
  assert.equal(crashed.length, 1);
  assert.equal(crashed[0]!.agentId, agentId);
  assert.equal(system.store.agents.getAgent(agentId)!.status, 'crashed');
  assert.equal(system.store.tasks.getTask(system.store.agents.getAgent(agentId)!.taskId)!.status, 'running');
  assert.equal(crashed[0]!.restorable, false);
  assert.match(crashed[0]!.restoreBlocked!, /cannot resume/);

  const decided = system.recovery.decide(crashed[0]!.taskId, 'remove');
  assert.equal(decided.ok, true);
  assert.equal(system.store.agents.getAgent(agentId)!.status, 'interrupted');
  assert.equal(system.store.tasks.getTask(system.store.agents.getAgent(agentId)!.taskId)!.status, 'interrupted');
  system.store.close();
});

test('killing a waiting agent auto-dismisses its open escalations with a reason', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { backend });
  const { agentId, escalationId } = await agentWithOpenEscalation(system, backend);

  const dismissedEvents: Escalation[] = [];
  system.escalations.on('dismissed', (e: Escalation) => dismissedEvents.push(e));

  system.agents.kill(agentId);

  const after = system.store.escalations.getEscalation(escalationId)!;
  assert.equal(after.status, 'dismissed');
  const dismissal = after.context.dismissal as { reason: string; at: string };
  assert.equal(dismissal.reason, 'agent killed');
  assert.ok(dismissal.at, 'dismissal timestamp recorded');
  assert.equal(system.store.escalations.listOpenEscalations().length, 0, 'dropped out of "Needs you"');
  assert.equal(dismissedEvents.length, 1, 'emitted a dismissed event for the live refresh');
  assert.ok(
    system.store.decisions
      .listDecisions()
      .some((d) => d.detail.includes(escalationId) && d.detail.includes('agent killed')),
    'dismissal written to the decision log',
  );
  system.store.close();
});

test('an agent that fails auto-dismisses its open escalations', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { backend });
  const { escalationId } = await agentWithOpenEscalation(system, backend);

  backend.last().emitExit(1);

  const after = system.store.escalations.getEscalation(escalationId)!;
  assert.equal(after.status, 'dismissed');
  assert.equal((after.context.dismissal as { reason: string }).reason, 'agent failed');
  system.store.close();
});

test('an agent that finishes with its own question still open auto-dismisses it', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { backend });
  const { escalationId } = await agentWithOpenEscalation(system, backend);

  backend.last().emit('sorted it myself @@LUBBDUBB_DONE@@');

  const after = system.store.escalations.getEscalation(escalationId)!;
  assert.equal(after.status, 'dismissed');
  assert.equal((after.context.dismissal as { reason: string }).reason, 'agent finished its work');
  assert.equal(system.store.escalations.listOpenEscalations().length, 0, 'dropped out of "Needs you"');
  system.store.close();
});

test('the pulse sweeps an escalation whose agent died without a terminal event', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { backend });
  const { agentId, escalationId } = await agentWithOpenEscalation(system, backend);

  system.store.agents.updateAgent(agentId, { status: 'failed', endedAt: new Date().toISOString(), pid: null });
  assert.equal(system.store.escalations.getEscalation(escalationId)!.status, 'open');

  await system.harness.runCycle('manual');

  const after = system.store.escalations.getEscalation(escalationId)!;
  assert.equal(after.status, 'dismissed');
  assert.match((after.context.dismissal as { reason: string }).reason, /^agent failed;/);

  await system.harness.runCycle('manual');
  const dismissals = system.store.decisions
    .listDecisions()
    .filter((d) => d.detail.includes(`Auto-dismissed escalation`));
  assert.equal(dismissals.length, 1, 'swept once, not once per pulse');
  system.store.close();
});

test("a crashed agent's open escalation survives detection and is dismissed only by the verdict", async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { backend });
  const { agentId, escalationId } = await agentWithOpenEscalation(system, backend);

  system.recovery.detect();
  assert.equal(system.store.escalations.getEscalation(escalationId)!.status, 'open');

  system.recovery.decide(system.store.agents.getAgent(agentId)!.taskId, 'remove');
  const after = system.store.escalations.getEscalation(escalationId)!;
  assert.equal(after.status, 'dismissed');
  assert.equal((after.context.dismissal as { reason: string }).reason, 'agent crashed; work dropped');
  system.store.close();
});

test('dismissal is scoped: a still-live agents escalations are left untouched', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { backend });
  const { escalationId } = await agentWithOpenEscalation(system, backend);

  system.escalations.dismissEscalationsForAgent('agent_someone_else', 'agent killed');

  assert.equal(system.store.escalations.getEscalation(escalationId)!.status, 'open');
  assert.equal(system.store.escalations.listOpenEscalations().length, 1);
  system.store.close();
});
