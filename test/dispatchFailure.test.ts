import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { Spawner } from '../src/agents/streamJsonSession.js';

class FlakyWorktrees extends FakeWorktreeManager {
  failures = 1;

  override ensure(branch: string, base?: string): Promise<string> {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new Error(`EBUSY: resource busy or locked, rmdir '${branch}'`));
    }
    return super.ensure(branch, base);
  }
}

function testConfig(agentMode: 'raw' | 'stream') {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-dispatchfail-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode,
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 2,
  });
}

const streamConfig = () => testConfig('stream');

test('a dispatch whose worktree fails leaves no active task, and the same origin dispatches next cycle', async () => {
  const worktrees = new FlakyWorktrees();
  const system = buildSystem(testConfig('raw'), { worktrees, backend: new FakePtyBackend() });

  const job = system.store.jobs.createJob({
    title: 'Remove the scan-check pollers',
    prompt: 'Remove them.',
    kind: 'code',
    branch: 'issue/35174/remove-scan-check-pollers',
    originRef: 'pr:31658:ci-gate',
  });
  await system.harness.runCycle('manual');

  const rejected = system.store.decisions.listDecisions().filter((d) => d.outcome === 'rejected');
  assert.equal(rejected.length, 1);
  assert.match(rejected[0]!.detail, /Failed to start agent: EBUSY/);
  assert.equal(system.store.agents.listAgentsByStatus('starting', 'running').length, 0, 'nothing spawned');

  const task = system.store.tasks.listTasks()[0];
  assert.ok(task, 'the dispatch did write a task row');
  assert.equal(task.status, 'interrupted');
  assert.equal(system.store.tasks.listOutstandingTasks().length, 0, 'no active task survives the failed dispatch');
  assert.equal(system.store.tasks.findActiveTaskByOrigin(`job:${job.id}`), null, 'the origin is claimable again');
  assert.equal(system.store.tasks.findActiveTaskByBranch(task.branch!), null, 'and so is the branch');

  assert.equal(system.store.jobs.getJob(job.id)!.status, 'queued');

  await system.harness.runCycle('manual');
  const live = system.store.agents.listAgentsByStatus('starting', 'running');
  assert.equal(live.length, 1, 'the same origin dispatches on the next cycle');
  const started = system.store.tasks.getTask(live[0]!.taskId)!;
  assert.equal(started.originRef, `job:${job.id}`);
  assert.equal(started.branch, 'issue/35174/remove-scan-check-pollers');
  assert.equal(system.store.jobs.getJob(job.id)!.status, 'dispatched');

  system.store.close();
});

test('a dispatch whose spawn throws keeps the manager’s own settlement, and still leaves no active task', async () => {
  const spawner: Spawner = () => {
    throw new Error("Agent command 'claude' was not found on PATH.");
  };
  const system = buildSystem(streamConfig(), { worktrees: new FakeWorktreeManager(), streamSpawner: spawner });

  const job = system.store.jobs.createJob({ title: 'Look into it', prompt: 'Look into it.', kind: 'desk' });
  await system.harness.runCycle('manual');

  const task = system.store.tasks.listTasks()[0];
  assert.ok(task);
  assert.equal(task.status, 'failed');
  assert.equal(system.store.tasks.listOutstandingTasks().length, 0, 'no active task survives the failed dispatch');
  assert.equal(system.store.tasks.findActiveTaskByOrigin(`job:${job.id}`), null, 'the origin is claimable again');
  assert.match(
    system.store.decisions.listDecisions().find((d) => d.outcome === 'rejected')!.detail,
    /Failed to start agent: Agent command/,
  );

  system.store.close();
});
