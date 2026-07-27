import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig, type Config } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { isRecoveryVerdict, requeueJobRequest, restorability } from '../src/agents/crashRecovery.js';
import type { Agent, Task } from '../src/types.js';

function testConfig(overrides: Partial<Config> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    // The cockpit guard is exercised in test/cockpitAuth.test.ts; these drive routes.
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    dispatcher: 'rule',
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
}> {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(overrides), { backend, errorMirror: () => {} });
  system.connector.inject({ kind: 'new_story', title: 'Add login', wafPillars: ['Reliability'] });
  await system.harness.runCycle('manual');
  const agentId = system.store.listAgentsByStatus('starting', 'running')[0]!.id;
  system.recovery.detect();
  return { system, backend, agentId };
}

// -- The hold ---------------------------------------------------------------

test('the pulse is held while a crashed agent awaits a decision, and resumes once it lands', async () => {
  const { system, agentId } = await systemWithCrashedAgent();
  system.connector.inject({ kind: 'new_story', title: 'Second story', wafPillars: ['Security'] });

  const held = await system.harness.runCycle('timer');
  assert.equal(held.cycleId, 'held');
  assert.match(held.rationale, /await a recovery decision/);
  assert.deepEqual(held.summary, { cycleId: 'held', executed: 0, deferred: 0, rejected: 0 });
  assert.equal(system.store.listTasks().length, 1, 'nothing new is dispatched in front of the decision');

  system.recovery.decide(agentId, 'remove');
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
  const { system, agentId, backend } = await systemWithCrashedAgent();
  const pending = system.recovery.pending();
  assert.equal(pending[0]!.restorable, false);

  const result = system.recovery.decide(agentId, 'restore');
  assert.equal(result.ok, false);
  assert.equal(system.recovery.pendingCount(), 1, 'a refusal is not a decision — requeue and remove are still open');
  assert.equal(backend.spawned.length, 1, 'nothing was relaunched');
  system.store.close();
});

test('requeue retires the task and files a job that carries the work forward', async () => {
  const { system, agentId } = await systemWithCrashedAgent();
  const taskId = system.store.getAgent(agentId)!.taskId;
  const original = system.store.getTask(taskId)!;

  const result = system.recovery.decide(agentId, 'requeue');
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
  const { system, agentId } = await systemWithCrashedAgent();
  system.recovery.decide(agentId, 'requeue');

  await system.harness.runCycle('manual');
  const job = system.store.listJobs()[0]!;
  assert.equal(job.status, 'dispatched', 'rule 0 takes it ahead of world-driven work');
  const task = system.store.getTask(job.taskId!)!;
  assert.equal(task.status, 'running');
  system.store.close();
});

test('remove settles the work and is not re-offered on the next boot', async () => {
  const { system, agentId } = await systemWithCrashedAgent();
  system.recovery.decide(agentId, 'remove');

  assert.equal(system.recovery.pendingCount(), 0);
  assert.equal(system.store.listQueuedJobs().length, 0, 'nothing is queued in its place');
  // A second boot's detection must not resurrect it: the settled task is what says so.
  assert.equal(system.recovery.detect().length, 0);
  system.store.close();
});

test('every verdict lands in the decision log', async () => {
  const { system, agentId } = await systemWithCrashedAgent();
  system.recovery.decide(agentId, 'remove');
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

// -- The HTTP surface -------------------------------------------------------

test('POST /api/recovery/:id applies a verdict and reports what remains', async () => {
  const { system, agentId } = await systemWithCrashedAgent();
  const { app } = await buildApp(system);

  const before = await (await app.inject({ method: 'GET', url: '/api/state' })).json();
  assert.equal(before.recovery.length, 1);
  assert.equal(before.recovery[0].agentId, agentId);

  const res = await app.inject({ method: 'POST', url: `/api/recovery/${agentId}`, payload: { verdict: 'remove' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().remaining, 0);
  assert.ok(res.json().report, 'the last decision kicks a cycle, so held work moves immediately');

  const after = await (await app.inject({ method: 'GET', url: '/api/state' })).json();
  assert.equal(after.recovery.length, 0);

  await app.close();
  system.store.close();
});

test('POST /api/recovery/:id refuses an unknown verdict and an agent it is not holding', async () => {
  const { system, agentId } = await systemWithCrashedAgent();
  const { app } = await buildApp(system);

  const bad = await app.inject({ method: 'POST', url: `/api/recovery/${agentId}`, payload: { verdict: 'resume' } });
  assert.equal(bad.statusCode, 400);

  const missing = await app.inject({ method: 'POST', url: '/api/recovery/agent_nope', payload: { verdict: 'remove' } });
  assert.equal(missing.statusCode, 409);

  assert.equal(system.recovery.pendingCount(), 1, 'neither refusal moved anything');
  await app.close();
  system.store.close();
});

test("answering a crashed agent's escalation is refused, pointing at the recovery route", async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { backend, errorMirror: () => {} });
  system.connector.inject({ kind: 'new_story', title: 'Add login', wafPillars: ['Reliability'] });
  await system.harness.runCycle('manual');
  const agentId = system.store.listAgentsByStatus('starting', 'running')[0]!.id;
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
  assert.match(res.json().error, new RegExp(`/api/recovery/${agentId}`));
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

test('the requeued prompt tells a fresh agent it is redoing work, and on which branch', () => {
  const { title, prompt } = requeueJobRequest(agentRow({ note: 'rewrote the flaky test' }), taskRow());
  assert.match(title, /^Requeued: Fix CI on PR #42/);
  assert.match(prompt, /pr:42:ci/);
  assert.match(prompt, /fix\/ci/);
  assert.match(prompt, /rewrote the flaky test/);
  assert.ok(prompt.includes('Make the build pass.'));
});

test('the requeued prompt omits what it does not have', () => {
  const { prompt } = requeueJobRequest(agentRow(), taskRow({ branch: null, originRef: null }));
  assert.doesNotMatch(prompt, /branch/);
  assert.doesNotMatch(prompt, /last reported progress/);
});

test('isRecoveryVerdict admits exactly the three verdicts', () => {
  for (const v of ['restore', 'requeue', 'remove']) assert.equal(isRecoveryVerdict(v), true);
  for (const v of ['resume', 'kill', '', null, 3]) assert.equal(isRecoveryVerdict(v), false);
});
