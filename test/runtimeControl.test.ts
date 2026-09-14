import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeControl } from '../src/runtimeControl.js';
import { loadConfig, type Config } from '../src/config/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import type { DispatchResult } from '../src/dispatcher/dispatcher.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

function testConfig(overrides: Partial<Config> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    ...overrides,
  });
}

function deskPlan(...names: string[]): DispatchResult {
  return {
    rationale: 'test',
    rejected: [],
    actions: names.map((n) => ({
      type: 'dispatch_desk_agent',
      title: n,
      prompt: n.toLowerCase(),
      originRef: `x:${n}`,
      reason: 'r',
    })),
  } as unknown as DispatchResult;
}

test('RuntimeControl seeds cap and paused from constructor', () => {
  const rc = new RuntimeControl(3, false);
  assert.equal(rc.cap, 3);
  assert.equal(rc.paused, false);
  assert.deepEqual(rc.snapshot(), { cap: 3, paused: false });
});

test('RuntimeControl.apply mutates only the provided fields and returns the new state', () => {
  const rc = new RuntimeControl(3, false);

  assert.deepEqual(rc.apply({ cap: 5 }), { cap: 5, paused: false });
  assert.equal(rc.cap, 5);
  assert.equal(rc.paused, false);

  assert.deepEqual(rc.apply({ paused: true }), { cap: 5, paused: true });
  assert.equal(rc.cap, 5);
  assert.equal(rc.paused, true);

  assert.deepEqual(rc.apply({ cap: 0, paused: false }), { cap: 0, paused: false });
});

test('RuntimeControl.apply({}) is a no-op that returns current state', () => {
  const rc = new RuntimeControl(2, true);
  assert.deepEqual(rc.apply({}), { cap: 2, paused: true });
});

test('RuntimeControl.apply accepts cap 0 (a valid non-negative integer)', () => {
  const rc = new RuntimeControl(3, false);
  assert.doesNotThrow(() => rc.apply({ cap: 0 }));
  assert.equal(rc.cap, 0);
});

test('RuntimeControl.apply rejects a negative cap and leaves state untouched', () => {
  const rc = new RuntimeControl(3, false);
  assert.throws(() => rc.apply({ cap: -1 }), /non-negative integer/);
  assert.equal(rc.cap, 3);
});

test('RuntimeControl.apply rejects a non-integer cap', () => {
  const rc = new RuntimeControl(3, false);
  assert.throws(() => rc.apply({ cap: 2.5 }), /non-negative integer/);
  assert.equal(rc.cap, 3);
});

test('buildSystem seeds RuntimeControl from config (cap + unpaused by default)', () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig({ maxConcurrentAgents: 2 }), { worktrees: new FakeWorktreeManager(), backend });
  assert.equal(system.runtimeControl.cap, 2);
  assert.equal(system.runtimeControl.paused, false);
  system.store.close();
});

test('raising the cap at runtime lets more agents spawn on the next execute', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig({ maxConcurrentAgents: 1 }), { worktrees: new FakeWorktreeManager(), backend });

  const first = await system.executor.execute('cyc_1', deskPlan('A', 'B'));
  assert.equal(first.executed, 1);
  assert.equal(first.deferred, 1);
  assert.equal(system.store.agents.countLiveAgents(), 1);

  system.runtimeControl.apply({ cap: 2 });
  const second = await system.executor.execute('cyc_2', deskPlan('A', 'B'));
  assert.equal(second.executed, 1, 'B now fits under the raised cap');
  assert.equal(system.store.agents.countLiveAgents(), 2);
  system.store.close();
});

test('lowering the cap below live count defers new dispatch but kills nothing', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig({ maxConcurrentAgents: 2 }), { worktrees: new FakeWorktreeManager(), backend });

  await system.executor.execute('cyc_1', deskPlan('A', 'B'));
  assert.equal(system.store.agents.countLiveAgents(), 2);

  system.runtimeControl.apply({ cap: 1 });
  const summary = await system.executor.execute('cyc_2', deskPlan('C'));
  assert.equal(summary.executed, 0, 'no new spawn while over the lowered cap');
  assert.equal(summary.deferred, 1);
  assert.equal(system.store.agents.countLiveAgents(), 2, 'live agents are not killed by scale-down');
  system.store.close();
});

test('pausing stops new dispatch while leaving live agents running', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig({ maxConcurrentAgents: 3 }), { worktrees: new FakeWorktreeManager(), backend });

  await system.executor.execute('cyc_1', deskPlan('A'));
  assert.equal(system.store.agents.countLiveAgents(), 1);

  system.runtimeControl.apply({ paused: true });
  const summary = await system.executor.execute('cyc_2', deskPlan('B'));
  assert.equal(summary.executed, 0, 'no new spawn while paused');
  assert.equal(summary.deferred, 1);
  assert.equal(system.store.agents.countLiveAgents(), 1, 'the live agent keeps running while paused');

  const deferral = system.store.decisions.listDecisions(50).find((d) => d.outcome === 'deferred');
  assert.ok(deferral, 'a deferred decision is recorded');
  assert.match(deferral.detail, /paus/i);
  system.store.close();
});

test('unpausing resumes dispatch at the previously chosen cap', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig({ maxConcurrentAgents: 3 }), { worktrees: new FakeWorktreeManager(), backend });

  system.runtimeControl.apply({ paused: true });
  let summary = await system.executor.execute('cyc_1', deskPlan('A'));
  assert.equal(summary.executed, 0);

  system.runtimeControl.apply({ paused: false });
  summary = await system.executor.execute('cyc_2', deskPlan('A'));
  assert.equal(summary.executed, 1, 'dispatch resumes once unpaused');
  assert.equal(system.store.agents.countLiveAgents(), 1);
  system.store.close();
});

test('startPaused: true boots the system paused', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig({ startPaused: true }), { worktrees: new FakeWorktreeManager(), backend });
  assert.equal(system.runtimeControl.paused, true);

  const summary = await system.executor.execute('cyc_1', deskPlan('A'));
  assert.equal(summary.executed, 0, 'nothing dispatches on a paused boot');
  assert.equal(summary.deferred, 1);
  system.store.close();
});

test('while paused the harness keeps cycling: audit, escalations and answers still work', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig({ maxConcurrentAgents: 3 }), { worktrees: new FakeWorktreeManager(), backend });

  system.connector.inject({ kind: 'new_issue', number: 901, title: 'Add login' });
  await system.harness.runCycle('manual');
  const agentId = system.store.agents.listAgentsByStatus('starting', 'running')[0]!.id;

  system.runtimeControl.apply({ paused: true });
  const decisionsBefore = system.store.decisions.listDecisions(200).length;
  const liveBefore = system.store.agents.countLiveAgents();
  await system.harness.runCycle('manual');
  assert.equal(system.store.agents.countLiveAgents(), liveBefore, 'no new spawn; the live agent keeps running');
  assert.ok(system.store.decisions.listDecisions(200).length > decisionsBefore, 'the paused cycle still audits');

  backend.last().emit('@@LUBBDUBB_WAITING:Which auth provider?@@');
  const open = system.store.escalations.listOpenEscalations();
  assert.equal(open.length, 1, 'a waiting agent escalates while paused');

  const result = system.escalations.answer(open[0]!.id, 'Use OAuth');
  assert.equal(result.routing, 'typed_into_agent');
  assert.equal(system.store.agents.getAgent(agentId)!.status, 'running');

  system.store.close();
});
