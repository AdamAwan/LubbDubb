import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { Spawner } from '../src/agents/streamJsonSession.js';

/**
 * A dispatch that throws must not leave an active task row behind.
 *
 * `queued` is deliberately an active status (`src/tasks.ts`), so a row written by a
 * dispatch that never spawned is a permanent claim on its origin and its branch —
 * and, when a job dispatched it, on whatever that job stands in for. The live
 * failure was one `EBUSY: … rmdir` from a worktree released moments earlier, which
 * wedged two jobs against a completely idle fleet for hours.
 */

/** A worktree manager whose first `ensure` fails the way the live one did. */
class FlakyWorktrees extends FakeWorktreeManager {
  /** How many more `ensure` calls throw before it starts working. */
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

  // A job standing in for another origin — the requeue shape — so the wedge this
  // guards against is the full chain: the dead row holds `job:<id>`, which keeps
  // the job `queued`, which keeps the job standing in for `pr:31658:ci-gate`.
  const job = system.store.createJob({
    title: 'Remove the scan-check pollers',
    prompt: 'Remove them.',
    kind: 'code',
    branch: 'issue/35174/remove-scan-check-pollers',
    originRef: 'pr:31658:ci-gate',
  });
  await system.harness.runCycle('manual');

  // The failure is audited through the normal path, with the reason.
  const rejected = system.store.listDecisions().filter((d) => d.outcome === 'rejected');
  assert.equal(rejected.length, 1);
  assert.match(rejected[0]!.detail, /Failed to start agent: EBUSY/);
  assert.equal(system.store.listAgentsByStatus('starting', 'running').length, 0, 'nothing spawned');

  // The row the dispatch wrote is settled, so it claims nothing: not the origin,
  // not the branch, and not the fleet's attention.
  const task = system.store.listTasks()[0];
  assert.ok(task, 'the dispatch did write a task row');
  assert.equal(task.status, 'interrupted');
  assert.equal(system.store.listOutstandingTasks().length, 0, 'no active task survives the failed dispatch');
  assert.equal(system.store.findActiveTaskByOrigin(`job:${job.id}`), null, 'the origin is claimable again');
  assert.equal(system.store.findActiveTaskByBranch(task.branch!), null, 'and so is the branch');

  // The job never left the queue — `markJobDispatched` runs only after the spawn —
  // so there is something for the next cycle to retry.
  assert.equal(system.store.getJob(job.id)!.status, 'queued');

  // Which it does: one transient failure costs a cycle, not the job.
  await system.harness.runCycle('manual');
  const live = system.store.listAgentsByStatus('starting', 'running');
  assert.equal(live.length, 1, 'the same origin dispatches on the next cycle');
  const started = system.store.getTask(live[0]!.taskId)!;
  assert.equal(started.originRef, `job:${job.id}`);
  assert.equal(started.branch, 'issue/35174/remove-scan-check-pollers');
  assert.equal(system.store.getJob(job.id)!.status, 'dispatched');

  system.store.close();
});

test('a dispatch whose spawn throws keeps the manager’s own settlement, and still leaves no active task', async () => {
  const spawner: Spawner = () => {
    throw new Error("Agent command 'claude' was not found on PATH.");
  };
  const system = buildSystem(streamConfig(), { worktrees: new FakeWorktreeManager(), streamSpawner: spawner });

  const job = system.store.createJob({ title: 'Look into it', prompt: 'Look into it.', kind: 'desk' });
  await system.harness.runCycle('manual');

  // The other arm of the same window: the row exists, the working directory is
  // ready, and it is the *spawn* that throws. `AgentManager.spawn` tears down its
  // half-created agent and settles the task as `failed` — a more specific reading
  // of the same failure, which the executor must not overwrite. Either way the row
  // must not stay active.
  const task = system.store.listTasks()[0];
  assert.ok(task);
  assert.equal(task.status, 'failed');
  assert.equal(system.store.listOutstandingTasks().length, 0, 'no active task survives the failed dispatch');
  assert.equal(system.store.findActiveTaskByOrigin(`job:${job.id}`), null, 'the origin is claimable again');
  assert.match(
    system.store.listDecisions().find((d) => d.outcome === 'rejected')!.detail,
    /Failed to start agent: Agent command/,
  );

  system.store.close();
});
