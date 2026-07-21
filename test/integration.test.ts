import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, reconcileAndResumeOnBoot, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import type { Escalation } from '../src/types.js';

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    dbPath: ':memory:',
    dispatcher: 'rule',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
}

/** Bring up one live agent parked on a single open escalation. */
async function agentWithOpenEscalation(
  system: System,
  backend: FakePtyBackend,
): Promise<{ agentId: string; escalationId: string }> {
  system.connector.inject({ kind: 'new_story', title: 'Needs a call', wafPillars: ['Reliability'] });
  await system.harness.runCycle('manual');
  const agentId = system.store.listAgentsByStatus('starting', 'running')[0]!.id;
  backend.last().emit('@@LUBBDUBB_WAITING:Which provider should I use?@@');
  const escalationId = system.store.listOpenEscalations()[0]!.id;
  return { agentId, escalationId };
}

test('full desk-task loop: inject -> dispatch -> agent waits -> escalate -> answer -> done', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { backend });

  // A story missing its description (but with WAF pillars set) yields exactly one
  // desk grooming task — no WAF task, and not a pickup candidate (needs desc+AC).
  system.connector.inject({ kind: 'new_story', title: 'Add login', wafPillars: ['Reliability'] });
  await system.harness.runCycle('manual');

  // An agent should now be live.
  const live = system.store.listAgentsByStatus('starting', 'running');
  assert.equal(live.length, 1, 'one agent should be running');
  const agentId = live[0]!.id;
  assert.equal(backend.spawned.length, 1);

  // The agent narrates, then asks for a decision -> a waiting escalation that
  // carries enough context to answer in-place.
  backend.last().emit('Reading the login story…\nUnsure which identity provider to target.\n');
  backend.last().emit('@@LUBBDUBB_WAITING:Which auth provider should I assume?@@');
  const open = system.store.listOpenEscalations();
  assert.equal(open.length, 1, 'a waiting agent should raise one escalation');
  assert.equal(open[0]!.agentId, agentId);
  assert.equal(system.store.getAgent(agentId)!.status, 'waiting');
  // Enriched context: the originating signal and a tail of the agent's output.
  const ctx = open[0]!.context;
  // The escalation carries the task's originating signal (a story-grooming ref).
  assert.equal(ctx.originRef, system.store.getTask(live[0]!.taskId)!.originRef);
  assert.match(String(ctx.originRef), /^story:.+:groom$/);
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

test('issuePickupLabel gates dispatch at the buildSystem seam; untagged issues stay visible', async () => {
  const backend = new FakePtyBackend();
  const config = testConfig();
  config.issuePickupLabel = 'agent-ready';
  const system = buildSystem(config, { backend });

  system.connector.inject({ kind: 'new_issue', number: 101, title: 'tagged', labels: ['agent-ready'] });
  system.connector.inject({ kind: 'new_issue', number: 102, title: 'untagged', labels: ['bug'] });
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

  system.connector.inject({ kind: 'new_story', title: 'Trivial', wafPillars: ['Cost'] });
  await system.harness.runCycle('manual');

  backend.last().emit('@@LUBBDUBB_WAITING:Allow running tests?@@');
  assert.equal(system.store.listOpenEscalations().length, 0, 'whitelisted prompt should not escalate');
  assert.equal(backend.last().writes.at(-1), 'yes\r');
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

test('reconcile on boot marks orphaned agents interrupted', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { backend });
  system.connector.inject({ kind: 'new_story', title: 'Work', wafPillars: ['Security'] });
  await system.harness.runCycle('manual');

  const agentId = system.store.listAgentsByStatus('starting', 'running')[0]!.id;
  // Simulate a crash: the process is gone but the DB still says "running". The
  // raw runtime isn't resumable, so reconciliation falls back to interrupting.
  const { resumed, interrupted } = reconcileAndResumeOnBoot(system.store, system.agents, system.escalations);
  assert.equal(resumed, 0);
  assert.equal(interrupted, 1);
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

test('reconcileAndResumeOnBoot auto-dismisses a non-resumable orphan open escalations', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { backend });
  const { escalationId } = await agentWithOpenEscalation(system, backend);

  // The raw runtime isn't resumable, so the orphan falls back to interrupted and
  // its now-orphaned escalation is dismissed.
  reconcileAndResumeOnBoot(system.store, system.agents, system.escalations);

  const after = system.store.getEscalation(escalationId)!;
  assert.equal(after.status, 'dismissed');
  assert.equal((after.context.dismissal as { reason: string }).reason, 'server restart');
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
