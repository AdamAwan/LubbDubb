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

/**
 * The queue-locking half of the two-day wedge.
 *
 * A dispatch writes its task row *before* the worktree exists, so a failing
 * `ensure` leaves a row behind. If that row is still active it becomes crash
 * recovery's business, and a `requeue` verdict files a job whose `originRef` is
 * the task's `job:<predecessor>` — which `listStandingJobs` then folds into
 * `activeOrigins`, so rule `manual-job` skips the predecessor for as long as the
 * new job is queued. Each failure adds a link ("Requeued: Requeued: …") and only
 * the newest of the chain is ever tried.
 *
 * Two properties keep it shut, tested here: the failed dispatch settles its row so
 * it never becomes a candidate at all, and a requeue that reaches one anyway
 * collapses onto the job already in the queue instead of stacking behind it.
 */

function testConfig(overrides: Partial<Config> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-requeue-'));
  return loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    ...overrides,
  });
}

/**
 * A {@link Worktrees} that fails the way the incident did — `rmSync` refusing a
 * directory a leftover shell still holds — and then recovers, because that is the
 * whole point of the failure being transient.
 */
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
  const rejection = system.store.listDecisions().find((d) => d.outcome === 'rejected');
  assert.match(rejection!.detail, /held open by another process/, 'and says why, in the operator’s terms');

  // The row the throw left behind is settled, which is what releases the origin
  // and the branch. `queued` is deliberately an *active* status, so a row nothing
  // ever started would otherwise hold both shut for the life of the database.
  const task = system.store.listTasks()[0]!;
  assert.equal(task.status, 'interrupted');
  assert.equal(system.store.findActiveTaskByOrigin('issue:35174'), null, 'the origin is free again');
  assert.equal(system.store.findActiveTaskByBranch(task.branch!), null, 'and so is the branch');

  // And so it is never offered for requeue: no candidate, no chain.
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
    // Everything already in the store belongs to a previous run.
    bootedAt: '2999-01-01T00:00:00.000Z',
  });

  // A job whose dispatch died between `createTask` and `spawn`: the task row is
  // there, and the job never left the queue, because `markJobDispatched` only runs
  // once the spawn has succeeded.
  const job = system.store.createJob({ title: 'Remove the scan-check pollers', prompt: 'Do it.', kind: 'code' });
  const task = system.store.createTask({
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
  assert.equal(system.store.listJobs().length, 1, 'no second job: the queued one *is* the requeue');
  assert.equal(result.outcome.job?.id, job.id, 'and it is the one handed back to the cockpit');
  assert.match(result.outcome.detail, /never left the queue/);
  assert.equal(system.store.getJob(job.id)!.status, 'queued');
  assert.equal(system.store.getTask(task.id)!.status, 'interrupted', 'the orphan is still settled');

  // The lock that made this a *chain*: a second job would stand in for
  // `job:<first>`, and rule `manual-job` skips a job whose origin is standing.
  assert.equal(
    system.store.findStandingJobByOrigin(`job:${job.id}`),
    null,
    'nothing stands in for the job, so nothing skips it',
  );

  const cycle = await system.harness.runCycle('manual');
  assert.equal(cycle.summary.executed, 1, 'and it dispatches on the next cycle');
  assert.equal(system.store.getJob(job.id)!.status, 'dispatched');
  system.store.close();
});

test('requeuing work whose job already dispatched still files a fresh one', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
    bootedAt: '2999-01-01T00:00:00.000Z',
  });

  // The other arm, and the reason the collapse is narrow: here an agent really did
  // run, its work may be on the branch, and there is something to redo.
  const job = system.store.createJob({ title: 'Ship the thing', prompt: 'Do it.', kind: 'code' });
  const task = system.store.createTask({
    kind: 'code',
    title: job.title,
    prompt: job.prompt,
    branch: 'job/ship',
    originRef: `job:${job.id}`,
  });
  system.store.markJobDispatched(job.id, task.id);

  const result = system.recovery.decide(task.id, 'requeue');

  assert.ok(result.ok);
  assert.equal(system.store.listJobs().length, 2, 'a dispatched predecessor gets a real requeue');
  assert.match(result.outcome.job!.title, /^Requeued: /);
  // The new job does stand in for the predecessor's origin — that is the #249 gate
  // doing its job, not the lock. Nothing is wedged by it: the predecessor is
  // `dispatched`, so no rule is trying to dispatch it, and the requeue is reached
  // under its *own* origin (`job:<new>`), which nothing is standing in for.
  assert.equal(system.store.findStandingJobByOrigin(`job:${job.id}`)?.id, result.outcome.job!.id);
  assert.equal(system.store.findStandingJobByOrigin(`job:${result.outcome.job!.id}`), null);
  assert.equal(system.store.getJob(job.id)!.status, 'dispatched');
  system.store.close();
});
