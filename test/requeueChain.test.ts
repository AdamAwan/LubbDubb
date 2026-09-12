import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem } from '../src/system.js';
import { loadConfig, type Config } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { Worktrees } from '../src/worktree/worktreeManager.js';

function testConfig(overrides: Partial<Config> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-requeue-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    ...overrides,
  });
}

class WedgedWorktrees implements Worktrees {
  readonly inner = new FakeWorktreeManager();
  failing = true;
  ensure(branch: string, base?: string): Promise<string> {
    if (this.failing)
      return Promise.reject(
        new Error(`Cannot reclaim the worktree directory /wt/${branch}: it is held open by another process (EBUSY)`),
      );
    return this.inner.ensure(branch, base);
  }
  ensureReadOnly(key: string, of: string): Promise<string> {
    if (this.failing)
      return Promise.reject(
        new Error(`Cannot reclaim the worktree directory /wt/slot-0: it is held open by another process (EBUSY)`),
      );
    return this.inner.ensureReadOnly(key, of);
  }
  ensurePreview(ref: string): Promise<{ dir: string; commit: string }> {
    return this.inner.ensurePreview(ref);
  }
  previewCommit(ref: string): Promise<string> {
    return this.inner.previewCommit(ref);
  }
  remove(branch: string): Promise<void> {
    return this.inner.remove(branch);
  }
  deleteBranch(branch: string): Promise<void> {
    return this.inner.deleteBranch(branch);
  }
}

test('a dispatch whose worktree is wedged costs a cycle, not the branch', async () => {
  const worktrees = new WedgedWorktrees();
  const system = buildSystem(testConfig(), {
    worktrees,
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
  system.connector.inject({ kind: 'new_issue', number: 35174, title: 'Remove the scan-check pollers' });

  const first = await system.harness.runCycle('manual');

  assert.equal(first.summary.rejected, 1, 'the dispatch is audited as rejected');
  const rejection = system.store.decisions.listDecisions().find((d) => d.outcome === 'rejected');
  assert.match(rejection!.detail, /held open by another process/, 'and says why, in the operator’s terms');

  const task = system.store.tasks.listTasks()[0]!;
  assert.equal(task.status, 'interrupted');
  assert.equal(system.store.tasks.findActiveTaskByOrigin('issue:35174'), null, 'the origin is free again');
  assert.equal(system.store.tasks.findActiveTaskByBranch(task.branch!), null, 'and so is the branch');

  assert.deepEqual(system.recovery.pending(), [], 'a failed dispatch is not orphaned work awaiting a decision');
  assert.equal(system.recovery.pendingCount(), 0, 'so the next pulse is not held either');

  worktrees.failing = false;
  const second = await system.harness.runCycle('manual');
  assert.equal(second.summary.executed, 1, 'the very next cycle dispatches it again');
  system.store.close();
});

test('requeuing work behind a still-queued job releases that job instead of stacking a second one', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
    bootedAt: '2999-01-01T00:00:00.000Z',
  });

  const job = system.store.jobs.createJob({ title: 'Remove the scan-check pollers', prompt: 'Do it.', kind: 'code' });
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: job.title,
    prompt: job.prompt,
    branch: 'issue/35174/remove-scan-check-pollers',
    originRef: `job:${job.id}`,
  });

  const pending = system.recovery.pending();
  assert.deepEqual(
    pending.map((p) => p.taskId),
    [task.id],
    'the orphaned task is a decision waiting to be made',
  );

  const result = system.recovery.decide(task.id, 'requeue');

  assert.ok(result.ok);
  assert.equal(system.store.jobs.listJobs().length, 1, 'no second job: the queued one *is* the requeue');
  assert.equal(result.outcome.job?.id, job.id, 'and it is the one handed back to the cockpit');
  assert.match(result.outcome.detail, /never left the queue/);
  assert.equal(system.store.jobs.getJob(job.id)!.status, 'queued');
  assert.equal(system.store.tasks.getTask(task.id)!.status, 'interrupted', 'the orphan is still settled');

  assert.equal(
    system.store.jobs.findStandingJobByOrigin(`job:${job.id}`),
    null,
    'nothing stands in for the job, so nothing skips it',
  );

  const cycle = await system.harness.runCycle('manual');
  assert.equal(cycle.summary.executed, 1, 'and it dispatches on the next cycle');
  assert.equal(system.store.jobs.getJob(job.id)!.status, 'dispatched');
  system.store.close();
});

test('requeuing work whose job already dispatched still files a fresh one', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
    bootedAt: '2999-01-01T00:00:00.000Z',
  });

  const job = system.store.jobs.createJob({ title: 'Ship the thing', prompt: 'Do it.', kind: 'code' });
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: job.title,
    prompt: job.prompt,
    branch: 'job/ship',
    originRef: `job:${job.id}`,
  });
  system.store.jobs.markJobDispatched(job.id, task.id);

  const result = system.recovery.decide(task.id, 'requeue');

  assert.ok(result.ok);
  assert.equal(system.store.jobs.listJobs().length, 2, 'a dispatched predecessor gets a real requeue');
  assert.match(result.outcome.job!.title, /^Requeued: /);
  assert.equal(system.store.jobs.findStandingJobByOrigin(`job:${job.id}`)?.id, result.outcome.job!.id);
  assert.equal(system.store.jobs.findStandingJobByOrigin(`job:${result.outcome.job!.id}`), null);
  assert.equal(system.store.jobs.getJob(job.id)!.status, 'dispatched');
  system.store.close();
});
