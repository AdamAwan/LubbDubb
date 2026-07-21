import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, reconcileAndResumeOnBoot } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';

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

  // The agent asks for a decision -> should become a waiting escalation.
  backend.last().emit('@@LUBBDUBB_WAITING:Which auth provider should I assume?@@');
  const open = system.store.listOpenEscalations();
  assert.equal(open.length, 1, 'a waiting agent should raise one escalation');
  assert.equal(open[0]!.agentId, agentId);
  assert.equal(system.store.getAgent(agentId)!.status, 'waiting');

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
  const { resumed, interrupted } = reconcileAndResumeOnBoot(system.store, system.agents);
  assert.equal(resumed, 0);
  assert.equal(interrupted, 1);
  assert.equal(system.store.getAgent(agentId)!.status, 'interrupted');
  assert.equal(system.store.getTask(system.store.getAgent(agentId)!.taskId)!.status, 'interrupted');
  system.store.close();
});
