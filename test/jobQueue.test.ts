import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';

/** A config with a small cap so the queue/priority behaviour is easy to drive. */
function testConfig(maxConcurrentAgents = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-jobs-'));
  return loadConfig({
    dbPath: ':memory:',
    dispatcher: 'rule',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents,
  });
}

test('a launched job dispatches an agent when there is headroom', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(2), { backend });

  const job = system.store.createJob({
    title: 'Investigate flake',
    prompt: 'Investigate the flaky test.',
    kind: 'desk',
  });
  await system.harness.runCycle('manual');

  const live = system.store.listAgentsByStatus('starting', 'running');
  assert.equal(live.length, 1, 'the job spawns one agent');
  const task = system.store.getTask(live[0]!.taskId)!;
  assert.equal(task.originRef, `job:${job.id}`, 'the task is linked to the job origin');
  assert.equal(task.prompt, 'Investigate the flaky test.');

  // The job has left the queue, tagged with the task it became.
  const stored = system.store.getJob(job.id)!;
  assert.equal(stored.status, 'dispatched');
  assert.equal(stored.taskId, task.id);
  assert.equal(system.store.listQueuedJobs().length, 0);

  system.store.close();
});

test('a job launched while the fleet is at capacity waits in the queue, then dispatches when a slot frees', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(1), { backend });

  // Fill the single slot with a first job.
  const first = system.store.createJob({ title: 'First', prompt: 'Do the first thing.', kind: 'desk' });
  await system.harness.runCycle('manual');
  assert.equal(system.store.listAgentsByStatus('starting', 'running').length, 1);
  const firstAgent = system.store.listAgentsByStatus('starting', 'running')[0]!;

  // A second job launched now can't fit — it stays queued.
  const second = system.store.createJob({ title: 'Second', prompt: 'Do the second thing.', kind: 'desk' });
  await system.harness.runCycle('manual');
  assert.equal(system.store.getJob(second.id)!.status, 'queued', 'the over-cap job waits');
  assert.equal(system.store.listAgentsByStatus('starting', 'running').length, 1, 'no second agent yet');
  // At capacity the dispatcher advertises zero headroom, so the job is held in the
  // queue rather than dispatched — it must not have been turned into a task.
  assert.ok(
    !system.store.listTasks().some((t) => t.originRef === `job:${second.id}`),
    'the over-cap job has not been dispatched into a task',
  );

  // Finish the first agent → a slot frees → the queued job dispatches next cycle.
  backend.last().emit('all done @@LUBBDUBB_DONE@@');
  assert.equal(system.store.getAgent(firstAgent.id)!.status, 'done');
  await system.harness.runCycle('manual');

  const stored = system.store.getJob(second.id)!;
  assert.equal(stored.status, 'dispatched', 'the queued job dispatches once there is room');
  assert.equal(system.store.getTask(stored.taskId!)!.originRef, `job:${second.id}`);
  assert.equal(first.status, 'queued'); // the in-memory snapshot is stale; the store is the truth
  assert.equal(system.store.getJob(first.id)!.status, 'dispatched');

  system.store.close();
});

test('a launched job takes priority over world-driven issue pickup for the last free slot', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(1), { backend });

  // An open issue would, on its own, claim the one slot via rule 4.
  system.connector.inject({ kind: 'new_issue', number: 301, title: 'A bug', labels: ['bug'] });
  // But an operator job is queued the same cycle — rule 0 wins the slot.
  const job = system.store.createJob({ title: 'Urgent chore', prompt: 'Handle the urgent chore.', kind: 'desk' });
  await system.harness.runCycle('manual');

  const live = system.store.listAgentsByStatus('starting', 'running');
  assert.equal(live.length, 1, 'only one agent fits');
  const task = system.store.getTask(live[0]!.taskId)!;
  assert.equal(task.originRef, `job:${job.id}`, 'the operator job — not the issue — takes the slot');
  assert.equal(system.store.getJob(job.id)!.status, 'dispatched');

  // The issue pickup was deferred, not lost — no task materialised for it.
  assert.ok(
    !system.store.listTasks().some((t) => t.originRef === 'issue:301'),
    'the issue dispatch was deferred behind the job',
  );

  system.store.close();
});

test('a queued job can be cancelled and is then never dispatched', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(1), { backend });

  // Occupy the slot so the next job stays queued.
  system.store.createJob({ title: 'Occupier', prompt: 'Occupy the slot.', kind: 'desk' });
  await system.harness.runCycle('manual');

  const doomed = system.store.createJob({ title: 'Never runs', prompt: 'Should be cancelled.', kind: 'desk' });
  await system.harness.runCycle('manual');
  assert.equal(system.store.getJob(doomed.id)!.status, 'queued');

  const cancelled = system.store.cancelJob(doomed.id);
  assert.ok(cancelled, 'a queued job is cancellable');
  assert.equal(system.store.getJob(doomed.id)!.status, 'cancelled');
  assert.equal(system.store.listQueuedJobs().length, 0, 'it has left the queue');

  // Cancelling an already-cancelled (or non-queued) job is a no-op.
  assert.equal(system.store.cancelJob(doomed.id), null);

  // Freeing the slot must not resurrect the cancelled job.
  const occupier = system.store.listAgentsByStatus('starting', 'running')[0]!;
  backend.last().emit('done @@LUBBDUBB_DONE@@');
  assert.equal(system.store.getAgent(occupier.id)!.status, 'done');
  await system.harness.runCycle('manual');
  assert.ok(
    !system.store.listTasks().some((t) => t.originRef === `job:${doomed.id}`),
    'a cancelled job never dispatches',
  );

  system.store.close();
});
