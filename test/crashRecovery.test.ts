import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig, type Config } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import {
  isAgentlessCandidate,
  isRecoveryVerdict,
  requeueJobRequest,
  restorability,
} from '../src/agents/crashRecovery.js';
import type { Agent, Task } from '../src/types.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

function testConfig(overrides: Partial<Config> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    // The cockpit guard is exercised in test/cockpitAuth.test.ts; these drive routes.
    auth: { enabled: false } as never,
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

/** A system with one agent already dispatched, then orphaned the way a crash orphans one. */
async function systemWithCrashedAgent(overrides: Partial<Config> = {}): Promise<{
  system: System;
  backend: FakePtyBackend;
  agentId: string;
  taskId: string;
}> {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(overrides), {
    worktrees: new FakeWorktreeManager(),
    backend,
    errorMirror: () => {},
  });
  system.connector.inject({ kind: 'new_issue', number: 901, title: 'Add login' });
  await system.harness.runCycle('manual');
  const agentId = system.store.listAgentsByStatus('starting', 'running')[0]!.id;
  const taskId = system.store.getAgent(agentId)!.taskId;
  system.recovery.detect();
  return { system, backend, agentId, taskId };
}

/**
 * A system holding the *other* kind of orphan: a task the executor recorded and a
 * restart caught before `agents.spawn`, so there is no agent row at all.
 *
 * `bootedAt` in the far future is how a test says "everything already in the store
 * belongs to a previous run" — the fence that keeps a live dispatch's own transient
 * agentless moment out of the candidate set.
 */
function systemWithOrphanedTask(): { system: System; taskId: string; origin: string; branch: string } {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend,
    errorMirror: () => {},
    bootedAt: '2999-01-01T00:00:00.000Z',
  });
  const task = system.store.createTask({
    kind: 'code',
    title: 'Work issue #35377',
    prompt: 'Do the thing.',
    branch: 'issue/35377',
    originRef: 'issue:35377',
  });
  return { system, taskId: task.id, origin: task.originRef!, branch: task.branch! };
}

// -- The hold ---------------------------------------------------------------

test('the pulse is held while a crashed agent awaits a decision, and resumes once it lands', async () => {
  const { system, taskId } = await systemWithCrashedAgent();
  system.connector.inject({ kind: 'new_issue', number: 902, title: 'Second issue' });

  const held = await system.harness.runCycle('timer');
  assert.equal(held.cycleId, 'held');
  assert.match(held.rationale, /await a recovery decision/);
  assert.deepEqual(held.summary, { cycleId: 'held', executed: 0, deferred: 0, rejected: 0 });
  assert.equal(system.store.listTasks().length, 1, 'nothing new is dispatched in front of the decision');

  system.recovery.decide(taskId, 'remove');
  assert.equal(system.recovery.pendingCount(), 0);

  const ran = await system.harness.runCycle('timer');
  assert.notEqual(ran.cycleId, 'held', 'the hold lifts on its own — no restart, nothing to un-pause');
  assert.ok(system.store.listTasks().length > 1, 'work flows again once the fleet is honestly described');
  system.store.close();
});

test('a crashed agent stops counting against the concurrency cap', async () => {
  const { system, agentId } = await systemWithCrashedAgent();
  assert.equal(system.store.getAgent(agentId)!.status, 'crashed');
  assert.equal(system.store.countLiveAgents(), 0, 'a row with no process behind it is not headroom');
  assert.ok(system.store.getAgent(agentId)!.endedAt, 'the run is closed off so overlap detection sees it end');
  system.store.close();
});

test('the hold is asked before the world is fetched', async () => {
  const { system } = await systemWithCrashedAgent();
  let fetched = 0;
  const inner = system.connector.getState.bind(system.connector);
  system.connector.getState = async () => {
    fetched += 1;
    return inner();
  };
  await system.harness.runCycle('timer');
  assert.equal(fetched, 0, 'a held pulse reads nothing: every verdict it could reach would be reached on a fiction');
  system.store.close();
});

// -- The three verdicts -----------------------------------------------------

test('restore is refused (leaving the decision open) when the runtime cannot resume', async () => {
  // The `raw` runtime pins no session id, so there is nothing to `--resume`.
  const { system, taskId, backend } = await systemWithCrashedAgent();
  const pending = system.recovery.pending();
  assert.equal(pending[0]!.restorable, false);

  const result = system.recovery.decide(taskId, 'restore');
  assert.equal(result.ok, false);
  assert.equal(system.recovery.pendingCount(), 1, 'a refusal is not a decision — requeue and remove are still open');
  assert.equal(backend.spawned.length, 1, 'nothing was relaunched');
  system.store.close();
});

test('requeue retires the task and files a job that carries the work forward', async () => {
  const { system, agentId, taskId } = await systemWithCrashedAgent();
  const original = system.store.getTask(taskId)!;

  const result = system.recovery.decide(taskId, 'requeue');
  assert.equal(result.ok, true);
  assert.equal(system.store.getAgent(agentId)!.status, 'interrupted');
  assert.equal(system.store.getTask(taskId)!.status, 'interrupted', 'the old task is retired, never left queued');

  const job = system.store.listQueuedJobs()[0]!;
  assert.equal(job.kind, original.kind);
  assert.equal(job.branch, original.branch);
  assert.match(job.prompt, /did not survive a harness restart/);
  assert.ok(job.prompt.includes(original.prompt), 'the original instruction is carried verbatim');
  if (original.originRef) assert.ok(job.prompt.includes(original.originRef), 'the origin is named as provenance');
  system.store.close();
});

test('a requeued job is dispatched by the next pulse, once the hold lifts', async () => {
  const { system, taskId } = await systemWithCrashedAgent();
  system.recovery.decide(taskId, 'requeue');

  await system.harness.runCycle('manual');
  const job = system.store.listJobs()[0]!;
  assert.equal(job.status, 'dispatched', 'rule `manual-job` takes it ahead of world-driven work');
  const task = system.store.getTask(job.taskId!)!;
  assert.equal(task.status, 'running');
  system.store.close();
});

test('remove settles the work and is not re-offered on the next boot', async () => {
  const { system, taskId } = await systemWithCrashedAgent();
  system.recovery.decide(taskId, 'remove');

  assert.equal(system.recovery.pendingCount(), 0);
  assert.equal(system.store.listQueuedJobs().length, 0, 'nothing is queued in its place');
  // A second boot's detection must not resurrect it: the settled task is what says so.
  assert.equal(system.recovery.detect().length, 0);
  system.store.close();
});

test('every verdict lands in the decision log', async () => {
  const { system, taskId } = await systemWithCrashedAgent();
  system.recovery.decide(taskId, 'remove');
  const detail = system.store
    .listDecisions(50)
    .filter((d) => d.cycleId === 'crash-recovery')
    .map((d) => d.detail);
  assert.ok(
    detail.some((d) => d?.includes('need a recovery decision')),
    'the hold itself is audited',
  );
  assert.ok(
    detail.some((d) => d?.includes('Dropped agent')),
    'and so is the verdict',
  );
  system.store.close();
});

// -- An orphaned task with no agent at all ----------------------------------
//
// The wedge: a restart between `store.createTask` and `agents.spawn` leaves a
// `queued` task nothing is working, which every dispatch gate reads as "already
// being done". Before this, nothing detected it and the origin and branch were shut
// for good — an unbroken run of "nothing actionable" against an idle fleet.

test('a task the last run left with no agent is parked for a decision', () => {
  const { system, taskId } = systemWithOrphanedTask();
  const pending = system.recovery.detect();

  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.taskId, taskId);
  assert.equal(pending[0]!.agentId, null, 'there is no agent to name');
  assert.equal(pending[0]!.died, 'never_started');
  assert.equal(system.store.getTask(taskId)!.status, 'queued', 'detection decides nothing — the row is untouched');
  system.store.close();
});

test('the pulse is held for an agentless orphan, and the world is never fetched', async () => {
  const { system } = systemWithOrphanedTask();
  system.recovery.detect();
  let fetched = 0;
  const inner = system.connector.getState.bind(system.connector);
  system.connector.getState = async () => {
    fetched += 1;
    return inner();
  };

  const held = await system.harness.runCycle('timer');
  assert.equal(held.cycleId, 'held');
  assert.equal(fetched, 0, 'a claim on an origin nothing is working is as much a fiction as a dead `running` row');
  system.store.close();
});

test('restore is refused for an agentless orphan, with the reason on the card', () => {
  const { system, taskId } = systemWithOrphanedTask();
  const item = system.recovery.detect()[0]!;
  assert.equal(item.restorable, false);
  assert.match(item.restoreBlocked!, /no agent ever started/);

  const result = system.recovery.decide(taskId, 'restore');
  assert.equal(result.ok, false);
  assert.equal(system.recovery.pendingCount(), 1, 'a refusal is not a decision — requeue and remove remain');
  system.store.close();
});

test('requeue settles the task, freeing the origin and the branch, and files a job', () => {
  const { system, taskId, origin, branch } = systemWithOrphanedTask();
  system.recovery.detect();

  const result = system.recovery.decide(taskId, 'requeue');
  assert.equal(result.ok, true);
  assert.equal(system.store.getTask(taskId)!.status, 'interrupted');
  // The whole point: these two are what the `queued` row was holding shut.
  assert.equal(system.store.findActiveTaskByOrigin(origin), null);
  assert.equal(system.store.findActiveTaskByBranch(branch), null);

  const job = system.store.listQueuedJobs()[0]!;
  assert.equal(job.branch, branch);
  assert.match(job.prompt, /before its agent was ever started/);
  assert.ok(job.prompt.includes('Do the thing.'), 'the original instruction is carried verbatim');
  assert.equal(system.recovery.pendingCount(), 0);
  system.store.close();
});

test('remove settles an agentless orphan and queues nothing in its place', () => {
  const { system, taskId, origin, branch } = systemWithOrphanedTask();
  system.recovery.detect();

  assert.equal(system.recovery.decide(taskId, 'remove').ok, true);
  assert.equal(system.store.getTask(taskId)!.status, 'interrupted');
  assert.equal(system.store.findActiveTaskByOrigin(origin), null);
  assert.equal(system.store.findActiveTaskByBranch(branch), null);
  assert.equal(system.store.listQueuedJobs().length, 0);
  system.store.close();
});

test('detection of an agentless orphan is idempotent, and a settled one never returns', () => {
  const { system, taskId } = systemWithOrphanedTask();
  const first = system.recovery.detect();
  const second = system.recovery.detect();
  assert.equal(second.length, 1, 'a second boot finds the same one decision, not a second copy of it');
  assert.deepEqual(
    second.map((p) => p.taskId),
    first.map((p) => p.taskId),
  );

  system.recovery.decide(taskId, 'remove');
  assert.equal(system.recovery.detect().length, 0, 'the settled task is what says the decision was made');
  system.store.close();
});

test('a task that has already reached a terminal status is not a candidate', () => {
  const { system, taskId } = systemWithOrphanedTask();
  system.store.updateTask(taskId, { status: 'done' });
  assert.equal(system.recovery.detect().length, 0);
  system.store.close();
});

test('a task dispatched by this run is not mistaken for an orphan of the last one', async () => {
  // The default fence is this process's start, so everything the harness itself
  // creates is on the near side of it — including the instant between `createTask`
  // and `spawn` that this whole feature exists to clean up after.
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend, errorMirror: () => {} });
  system.connector.inject({ kind: 'new_issue', number: 903, title: 'Add login' });
  await system.harness.runCycle('manual');

  assert.ok(system.store.listOutstandingTasks().length > 0, 'there is live work to be wrong about');
  assert.equal(system.recovery.pendingCount(), 0);
  system.store.close();
});

// -- The HTTP surface -------------------------------------------------------

test('POST /api/recovery/:id applies a verdict and reports what remains', async () => {
  const { system, agentId, taskId } = await systemWithCrashedAgent();
  const { app } = await buildApp(system);

  const before = await (await app.inject({ method: 'GET', url: '/api/state' })).json();
  assert.equal(before.recovery.length, 1);
  assert.equal(before.recovery[0].taskId, taskId);
  assert.equal(before.recovery[0].agentId, agentId, 'an agent-backed orphan still names its agent');

  const res = await app.inject({ method: 'POST', url: `/api/recovery/${taskId}`, payload: { verdict: 'remove' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().remaining, 0);
  assert.ok(res.json().report, 'the last decision kicks a cycle, so held work moves immediately');

  const after = await (await app.inject({ method: 'GET', url: '/api/state' })).json();
  assert.equal(after.recovery.length, 0);

  await app.close();
  system.store.close();
});

test('POST /api/recovery/:id refuses an unknown verdict and a task it is not holding', async () => {
  const { system, taskId } = await systemWithCrashedAgent();
  const { app } = await buildApp(system);

  const bad = await app.inject({ method: 'POST', url: `/api/recovery/${taskId}`, payload: { verdict: 'resume' } });
  assert.equal(bad.statusCode, 400);

  const missing = await app.inject({ method: 'POST', url: '/api/recovery/task_nope', payload: { verdict: 'remove' } });
  assert.equal(missing.statusCode, 409);

  assert.equal(system.recovery.pendingCount(), 1, 'neither refusal moved anything');
  await app.close();
  system.store.close();
});

test("answering a crashed agent's escalation is refused, pointing at the recovery route", async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend, errorMirror: () => {} });
  system.connector.inject({ kind: 'new_issue', number: 904, title: 'Add login' });
  await system.harness.runCycle('manual');
  const agentId = system.store.listAgentsByStatus('starting', 'running')[0]!.id;
  const taskId = system.store.getAgent(agentId)!.taskId;
  backend.last().emit('@@LUBBDUBB_WAITING:Which database?@@');
  const escalationId = system.store.listOpenEscalations()[0]!.id;
  system.recovery.detect();

  const { app } = await buildApp(system);
  const res = await app.inject({
    method: 'POST',
    url: `/api/escalations/${escalationId}/answer`,
    payload: { response: 'Postgres' },
  });
  assert.equal(res.statusCode, 409, 'a dead agent has nothing to type into');
  assert.match(
    res.json().error,
    new RegExp(`/api/recovery/${taskId}`),
    'the refusal names the task, which is what the route takes',
  );
  assert.equal(system.store.getEscalation(escalationId)!.status, 'open', 'the question is kept for a restore');

  await app.close();
  system.store.close();
});

// -- The pure half ----------------------------------------------------------

const agentRow = (patch: Partial<Agent> = {}): Agent => ({
  id: 'agent_1',
  taskId: 'task_1',
  status: 'running',
  cwd: '/tmp/wt/issue-1',
  pid: null,
  waitingReason: null,
  sessionId: 'sess-1',
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: null,
  costUsd: null,
  inputTokens: null,
  outputTokens: null,
  numTurns: null,
  note: null,
  notedAt: null,
  resumedAt: null,
  ...patch,
});

const taskRow = (patch: Partial<Task> = {}): Task => ({
  id: 'task_1',
  kind: 'code',
  title: 'Fix CI on PR #42',
  prompt: 'Make the build pass.',
  branch: 'fix/ci',
  originRef: 'pr:42:ci',
  originTitle: null,
  originSummary: null,
  dispatchReason: null,
  status: 'running',
  agentId: 'agent_1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...patch,
});

test('restorability names the missing precondition rather than just saying no', () => {
  assert.deepEqual(restorability(agentRow(), { resumable: true, worktreeExists: true }), {
    restorable: true,
    blocked: null,
  });
  assert.match(
    restorability(agentRow(), { resumable: false, worktreeExists: true }).blocked!,
    /runtime cannot resume/,
    'the runtime, not the row, is the reason',
  );
  assert.match(restorability(agentRow({ sessionId: null }), { resumable: true, worktreeExists: true }).blocked!, /id/);
  assert.match(
    restorability(agentRow(), { resumable: true, worktreeExists: false }).blocked!,
    /working directory is gone/,
  );
});

test('restore is refused for work no agent ever started, and says so first', () => {
  // Ahead of the runtime and worktree checks: there is no conversation to resume,
  // so *why* the runtime cannot resume one is not the operator's answer.
  const verdict = restorability(null, { resumable: true, worktreeExists: true });
  assert.equal(verdict.restorable, false);
  assert.match(verdict.blocked!, /no agent ever started/);
});

test('the requeued prompt tells a fresh agent it is redoing work, and on which branch', () => {
  const { title, prompt } = requeueJobRequest(taskRow(), { note: 'rewrote the flaky test' });
  assert.match(title, /^Requeued: Fix CI on PR #42/);
  assert.match(prompt, /pr:42:ci/);
  assert.match(prompt, /fix\/ci/);
  assert.match(prompt, /rewrote the flaky test/);
  assert.ok(prompt.includes('Make the build pass.'));
});

test('the requeued prompt omits what it does not have', () => {
  const { prompt } = requeueJobRequest(taskRow({ branch: null, originRef: null }), { note: null });
  assert.doesNotMatch(prompt, /branch/);
  assert.doesNotMatch(prompt, /last reported progress/);
});

test('a requeue with no prior agent says nothing was done, rather than inventing a run', () => {
  const { prompt } = requeueJobRequest(taskRow(), null);
  assert.match(prompt, /before its agent was ever started/);
  assert.match(prompt, /no work was done/);
  assert.doesNotMatch(prompt, /may already carry commits/, 'a branch nothing ran on carries nothing to read');
  assert.ok(prompt.includes('Make the build pass.'), 'the original instruction is still carried verbatim');
});

test('the agentless candidate is fenced to work older than this run', () => {
  const bootedAt = '2026-01-02T00:00:00.000Z';
  const orphan = taskRow({ status: 'queued', agentId: null, createdAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(isAgentlessCandidate(orphan, { hasAgent: false, bootedAt }), true);

  // The window this feature cleans up after is the window it must not fire inside:
  // a dispatch is agentless for the instant between `createTask` and `spawn`.
  const inFlight = taskRow({ status: 'queued', agentId: null, createdAt: '2026-01-03T00:00:00.000Z' });
  assert.equal(isAgentlessCandidate(inFlight, { hasAgent: false, bootedAt }), false);

  // An agent row exists ⇒ the *other* arm owns it; counting it here would list one
  // piece of work twice.
  assert.equal(isAgentlessCandidate(orphan, { hasAgent: true, bootedAt }), false);
  // Settled work is history, not a question — the same rule as the agent arm.
  assert.equal(
    isAgentlessCandidate(taskRow({ status: 'interrupted', agentId: null }), { hasAgent: false, bootedAt }),
    false,
  );
});

test('isRecoveryVerdict admits exactly the three verdicts', () => {
  for (const v of ['restore', 'requeue', 'remove']) assert.equal(isRecoveryVerdict(v), true);
  for (const v of ['resume', 'kill', '', null, 3]) assert.equal(isRecoveryVerdict(v), false);
});
