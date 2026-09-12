import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import type { Decision } from '../src/types.js';
import { gitRepo } from './support/gitRepo.js';

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function testConfig(maxConcurrentAgents = 1, repoRoot?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-jobs-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents,
    ...(repoRoot ? { repoRoot } : {}),
  });
}

function branchCollisions(decisions: Decision[]): Decision[] {
  return decisions.filter((d) => d.outcome === 'deferred' && d.detail.includes('would share its worktree'));
}

test('a launched job dispatches an agent when there is headroom', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(2), { backend });

  const job = system.store.jobs.createJob({
    title: 'Investigate flake',
    prompt: 'Investigate the flaky test.',
    kind: 'desk',
  });
  await system.harness.runCycle('manual');

  const live = system.store.agents.listAgentsByStatus('starting', 'running');
  assert.equal(live.length, 1, 'the job spawns one agent');
  const task = system.store.tasks.getTask(live[0]!.taskId)!;
  assert.equal(task.originRef, `job:${job.id}`, 'the task is linked to the job origin');
  assert.equal(task.prompt, 'Investigate the flaky test.');

  const stored = system.store.jobs.getJob(job.id)!;
  assert.equal(stored.status, 'dispatched');
  assert.equal(stored.taskId, task.id);
  assert.equal(system.store.jobs.listQueuedJobs().length, 0);

  system.store.close();
});

test('a job launched while the fleet is at capacity waits in the queue, then dispatches when a slot frees', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(1), { backend });

  const first = system.store.jobs.createJob({ title: 'First', prompt: 'Do the first thing.', kind: 'desk' });
  await system.harness.runCycle('manual');
  assert.equal(system.store.agents.listAgentsByStatus('starting', 'running').length, 1);
  const firstAgent = system.store.agents.listAgentsByStatus('starting', 'running')[0]!;

  const second = system.store.jobs.createJob({ title: 'Second', prompt: 'Do the second thing.', kind: 'desk' });
  await system.harness.runCycle('manual');
  assert.equal(system.store.jobs.getJob(second.id)!.status, 'queued', 'the over-cap job waits');
  assert.equal(system.store.agents.listAgentsByStatus('starting', 'running').length, 1, 'no second agent yet');
  assert.ok(
    !system.store.tasks.listTasks().some((t) => t.originRef === `job:${second.id}`),
    'the over-cap job has not been dispatched into a task',
  );

  backend.last().emit('all done @@LUBBDUBB_DONE@@');
  assert.equal(system.store.agents.getAgent(firstAgent.id)!.status, 'done');
  await system.harness.runCycle('manual');

  const stored = system.store.jobs.getJob(second.id)!;
  assert.equal(stored.status, 'dispatched', 'the queued job dispatches once there is room');
  assert.equal(system.store.tasks.getTask(stored.taskId!)!.originRef, `job:${second.id}`);
  assert.equal(first.status, 'queued');
  assert.equal(system.store.jobs.getJob(first.id)!.status, 'dispatched');

  system.store.close();
});

test('a launched job takes priority over world-driven issue pickup for the last free slot', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(1), { backend });

  system.connector.inject({ kind: 'new_issue', number: 301, title: 'A bug', labels: ['bug'] });
  const job = system.store.jobs.createJob({ title: 'Urgent chore', prompt: 'Handle the urgent chore.', kind: 'desk' });
  await system.harness.runCycle('manual');

  const live = system.store.agents.listAgentsByStatus('starting', 'running');
  assert.equal(live.length, 1, 'only one agent fits');
  const task = system.store.tasks.getTask(live[0]!.taskId)!;
  assert.equal(task.originRef, `job:${job.id}`, 'the operator job — not the issue — takes the slot');
  assert.equal(system.store.jobs.getJob(job.id)!.status, 'dispatched');

  assert.ok(
    !system.store.tasks.listTasks().some((t) => t.originRef === 'issue:301'),
    'the issue dispatch was deferred behind the job',
  );

  system.store.close();
});

test('a queued job can be cancelled and is then never dispatched', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(1), { backend });

  system.store.jobs.createJob({ title: 'Occupier', prompt: 'Occupy the slot.', kind: 'desk' });
  await system.harness.runCycle('manual');

  const doomed = system.store.jobs.createJob({ title: 'Never runs', prompt: 'Should be cancelled.', kind: 'desk' });
  await system.harness.runCycle('manual');
  assert.equal(system.store.jobs.getJob(doomed.id)!.status, 'queued');

  const cancelled = system.store.jobs.cancelJob(doomed.id);
  assert.ok(cancelled, 'a queued job is cancellable');
  assert.equal(system.store.jobs.getJob(doomed.id)!.status, 'cancelled');
  assert.equal(system.store.jobs.listQueuedJobs().length, 0, 'it has left the queue');

  assert.equal(system.store.jobs.cancelJob(doomed.id), null);

  const occupier = system.store.agents.listAgentsByStatus('starting', 'running')[0]!;
  backend.last().emit('done @@LUBBDUBB_DONE@@');
  assert.equal(system.store.agents.getAgent(occupier.id)!.status, 'done');
  await system.harness.runCycle('manual');
  assert.ok(
    !system.store.tasks.listTasks().some((t) => t.originRef === `job:${doomed.id}`),
    'a cancelled job never dispatches',
  );

  system.store.close();
});

test('a code job naming a branch a live task holds is deferred, then dispatches once the branch frees', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(3, gitRepo('lubbdubb-jobs-repo-')), { backend });

  const holder = system.store.jobs.createJob({
    title: 'Holder',
    prompt: 'Work the shared branch.',
    kind: 'code',
    branch: 'shared/work',
  });
  await system.harness.runCycle('manual');
  const holderTask = system.store.tasks.listTasks().find((t) => t.originRef === `job:${holder.id}`);
  assert.ok(holderTask, 'the first job dispatches normally');
  assert.equal(holderTask.branch, 'shared/work');

  const second = system.store.jobs.createJob({
    title: 'Collider',
    prompt: 'Also work the shared branch.',
    kind: 'code',
    branch: 'shared/work',
  });
  await system.harness.runCycle('manual');

  assert.equal(system.store.jobs.getJob(second.id)!.status, 'queued', 'the colliding job stays queued');
  assert.equal(
    system.store.tasks.listTasks().filter((t) => t.branch === 'shared/work').length,
    1,
    'no second task is materialised on the busy branch',
  );
  assert.equal(
    system.store.agents.listAgentsByStatus('starting', 'running').length,
    1,
    'no second agent in that worktree',
  );

  const collision = branchCollisions(system.store.decisions.listDecisions())[0];
  assert.ok(collision, 'the deferral is audited with a reason, like every other executor outcome');
  assert.ok(collision.detail.includes('shared/work'), 'the reason names the branch');
  assert.ok(collision.detail.includes(holderTask.id), 'and the task holding it');

  assert.equal(collision.outcome, 'deferred');

  const holderAgent = system.store.agents.listAgentsByStatus('starting', 'running')[0]!;
  backend.last().emit('@@LUBBDUBB_DONE@@\r\n');
  backend.last().emitExit(0);
  assert.equal(system.store.agents.getAgent(holderAgent.id)!.status, 'done');
  await tick(100);

  await system.harness.runCycle('manual');
  const stored = system.store.jobs.getJob(second.id)!;
  assert.equal(stored.status, 'dispatched', 'the queued job dispatches once the branch frees');
  assert.equal(system.store.tasks.getTask(stored.taskId!)!.branch, 'shared/work');

  system.store.close();
});

test('POST /api/jobs refuses a colliding branch at queue time', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(3, gitRepo('lubbdubb-jobs-repo-')), { backend });
  const { app } = await buildApp(system);

  const post = (payload: { prompt: string; kind: string; branch: string }) =>
    app.inject({ method: 'POST', url: '/api/jobs', payload });

  const first = await post({ prompt: 'Work the shared branch.', kind: 'code', branch: 'shared/work' });
  assert.equal(first.statusCode, 200, 'a free branch is accepted');
  assert.ok(system.store.tasks.listTasks().some((t) => t.branch === 'shared/work'));

  const collide = await post({ prompt: 'Also work it.', kind: 'code', branch: 'shared/work' });
  assert.equal(collide.statusCode, 409);
  assert.match(collide.json().error, /shared\/work is held by active task/);
  assert.equal(system.store.jobs.listJobs().length, 1, 'the refused job was never queued');

  const desk = await post({ prompt: 'Read the shared branch.', kind: 'desk', branch: 'shared/work' });
  assert.equal(desk.statusCode, 200);

  assert.equal((await post({ prompt: 'Elsewhere.', kind: 'code', branch: 'other/work' })).statusCode, 200);

  await app.close();
  system.store.close();
});

test('the branch gate is a no-op for world-driven rules, whose origins already determine their branches', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(6, gitRepo('lubbdubb-jobs-repo-')), { backend });

  system.connector.inject({ kind: 'new_pr', number: 500, title: 'Red CI', branch: 'feature/a' });
  system.connector.inject({ kind: 'ci_failed', prNumber: 500 });
  system.connector.inject({ kind: 'new_pr', number: 501, title: 'Behind', branch: 'feature/b' });
  system.connector.inject({ kind: 'pr_mergeable', prNumber: 501, mergeable: true, mergeableState: 'behind' });
  system.connector.inject({ kind: 'new_pr', number: 502, title: 'Commented', branch: 'feature/c' });
  system.connector.inject({ kind: 'pr_comment', prNumber: 502, author: 'reviewer', body: 'Rename this.' });
  system.connector.inject({ kind: 'new_issue', number: 301, title: 'A bug' });
  await system.harness.runCycle('manual');
  system.connector.inject({ kind: 'new_pr', number: 503, title: 'From the issue', branch: 'issue/301' });
  system.connector.inject({ kind: 'ci_failed', prNumber: 503 });
  await system.harness.runCycle('manual');

  const decisions = system.store.decisions.listDecisions();
  const worldDriven = decisions.filter((d) => d.action.type === 'dispatch_code_agent' && d.rule !== 'manual-job');
  assert.ok(worldDriven.length >= 4, 'the scenario actually exercised the world-driven dispatch rules');

  assert.deepEqual(
    branchCollisions(decisions).map((d) => d.detail),
    [],
    'no world-driven dispatch was ever held by the branch gate',
  );

  const owners = new Map<string, string>();
  for (const t of system.store.tasks.listTasks()) {
    if (!t.branch || !['queued', 'running', 'waiting'].includes(t.status)) continue;
    const owner = owners.get(t.branch);
    assert.equal(owner, undefined, `branch ${t.branch} is held by two live tasks (${owner}, ${t.id})`);
    owners.set(t.branch, t.id);
  }
  assert.ok(owners.size >= 4, 'and the live tasks really are spread across distinct branches');

  system.store.close();
});
