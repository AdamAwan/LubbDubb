import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { gitRepo } from './support/gitRepo.js';
import { failPlanningOpen } from './support/plans.js';
import { pinnedPool } from './support/worktrees.js';
import type { TaskSummary } from '../src/types.js';

// → docs/spec/35-ejection.md

function build(overrides: Record<string, unknown> = {}): { system: System; backend: FakePtyBackend } {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-eject-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    repoRoot: gitRepo(),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    auth: { enabled: false } as never,
    ...overrides,
  });
  const backend = new FakePtyBackend();
  const pool = pinnedPool(config, 2);
  const system = buildSystem(config, { backend, worktrees: pool.worktrees, errorMirror: () => {} });
  pool.attach(system);
  return { system, backend };
}

async function codeAgent(system: System, issueNumber: number): Promise<TaskSummary> {
  system.connector.inject({ kind: 'new_issue', number: issueNumber, title: `Bug ${issueNumber}` });
  failPlanningOpen(system.store, issueNumber);
  await system.harness.runCycle('manual');
  const task = system.store.tasks.listTasks().find((t) => t.kind === 'code' && t.branch === `issue/${issueNumber}`);
  assert.ok(task, 'a code task should have been dispatched');
  return task;
}

function liveAgentId(system: System): string {
  const agent = system.store.agents.listAgentsByStatus('starting', 'running')[0];
  assert.ok(agent, 'an agent should be live');
  return agent.id;
}

// The queue is where a held origin shows itself: `activeOrigins` drops a suppressed
// candidate before it is ranked, so a held origin is absent from Up next entirely.
function queued(system: System, originRef: string): boolean {
  return (system.harness.upcoming?.items ?? []).some((item) => item.origin === originRef);
}

test('an ejection holds its origin: nothing is dispatched for it until it is settled', async () => {
  const { system } = build();
  const task = await codeAgent(system, 21);
  const origin = task.originRef;
  assert.ok(origin);
  const ejected = system.ejections.eject(liveAgentId(system), 'it is rewriting the store');
  assert.ok(ejected.ok, ejected.ok ? '' : ejected.error);

  assert.equal(system.store.tasks.getTask(task.id)!.status, 'interrupted', 'the kill still settles the task');
  await system.harness.runCycle('manual');
  assert.equal(queued(system, origin), false, 'the origin is held: the rules cannot propose work an operator took');
  assert.equal(
    system.store.tasks.listTasks().some((t) => t.originRef === origin && t.id !== task.id),
    false,
    'and nothing was dispatched for it',
  );

  const settled = system.ejections.settle(ejected.ejection.id, 'handed_back', null);
  assert.ok(settled.ok, settled.ok ? '' : settled.error);
  await system.harness.runCycle('manual');
  assert.equal(queued(system, origin), true, 'settling puts the origin back in front of the rules');
  system.store.close();
});

test('an ejection holds its branch and its worktree slot', async () => {
  const { system } = build();
  const task = await codeAgent(system, 22);
  const branch = task.branch;
  assert.ok(branch);
  const agent = system.store.agents.getAgent(liveAgentId(system))!;
  const held = agent.cwd;

  const ejected = system.ejections.eject(agent.id, 'wrong direction');
  assert.ok(ejected.ok, ejected.ok ? '' : ejected.error);

  assert.equal(system.store.ejections.ejectionOnBranch(branch)?.id, ejected.ejection.id);
  assert.equal(system.store.tasks.findActiveTaskByBranch(branch), null, 'no task holds it — the claim is what does');

  // The pool grew by the held slot, so the next branch takes a directory of its own
  // rather than being handed the one the operator is sitting in.
  const other = await system.worktrees.ensure('issue/other');
  assert.notEqual(other, held, 'a held slot must never be handed to another branch');

  system.ejections.settle(ejected.ejection.id, 'handed_back', null);
  assert.equal(system.store.ejections.ejectionOnBranch(branch), null);
  system.store.close();
});

test('the hold survives a restart, because it is a row rather than a lease', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-eject-db-'));
  const dbPath = join(dir, 'state.db');
  const first = build({ dbPath });
  const task = await codeAgent(first.system, 23);
  const ejected = first.system.ejections.eject(liveAgentId(first.system), 'taking this one');
  assert.ok(ejected.ok, ejected.ok ? '' : ejected.error);
  first.system.store.close();

  const second = build({ dbPath, repoRoot: first.system.config.repoRoot });
  const live = second.system.store.ejections.liveEjections();
  assert.equal(live.length, 1, 'the claim is still standing after a restart');
  assert.equal(live[0]!.originRef, task.originRef);
  assert.equal(second.system.store.ejections.ejectionOnBranch(task.branch!)?.id, ejected.ejection.id);
  second.system.store.close();
});

test('requeueing files a job that stands in for the ejected origin', async () => {
  const { system } = build();
  const task = await codeAgent(system, 24);
  const origin = task.originRef!;
  const ejected = system.ejections.eject(liveAgentId(system), 'it missed the migration');
  assert.ok(ejected.ok, ejected.ok ? '' : ejected.error);

  const refused = system.ejections.settle(ejected.ejection.id, 'requeued', '   ');
  assert.equal(refused.ok, false, 'a requeue without a note has no preamble for the fresh agent');

  const settled = system.ejections.settle(ejected.ejection.id, 'requeued', 'I added the column; finish the backfill.');
  assert.ok(settled.ok, settled.ok ? '' : settled.error);
  const job = system.store.jobs.listJobs().find((j) => j.id === settled.jobId);
  assert.ok(job, 'a job should carry the work');
  assert.equal(job.originRef, origin, 'the job stands in for the origin, so nothing races it');
  assert.match(job.prompt, /I added the column/);
  assert.match(job.prompt, /it missed the migration/, "the operator's reason travels with the work");

  const again = system.ejections.settle(ejected.ejection.id, 'handed_back', null);
  assert.equal(again.ok, false, 'a settled claim cannot be settled twice');
  system.store.close();
});

test('a claim older than the window is expired by the pulse, and said out loud', async () => {
  const { system } = build({ ejection: { enabled: true, expiryHours: 0.000001, contactGraceMinutes: 15 } });
  const task = await codeAgent(system, 25);
  const ejected = system.ejections.eject(liveAgentId(system), 'holding this');
  assert.ok(ejected.ok, ejected.ok ? '' : ejected.error);

  await new Promise((r) => setTimeout(r, 20));
  const gone = system.ejections.sweepExpiries();
  assert.equal(gone.length, 1);
  assert.equal(gone[0]!.outcome, 'expired');
  assert.equal(system.store.ejections.ejectionOnBranch(task.branch!), null, 'the slot goes back to the pool');
  assert.ok(
    system.store.decisions.listDecisions(20).some((d) => d.action.reason.includes('expired')),
    'an expiry is the harness taking work back from a person, and is announced',
  );

  await system.harness.runCycle('manual');
  assert.equal(queued(system, task.originRef!), true, 'the origin is eligible again');
  system.store.close();
});

test('never contacted is its own state, not a stale timestamp', async () => {
  const { system } = build();
  await codeAgent(system, 26);
  const ejected = system.ejections.eject(liveAgentId(system), 'mine now');
  assert.ok(ejected.ok, ejected.ok ? '' : ejected.error);
  assert.equal(ejected.ejection.lastSeenAt, null, 'nothing has contacted the harness about it yet');

  system.store.ejections.noteEjection(ejected.ejection.id, 'reverting the store extraction');
  const seen = system.store.ejections.getEjection(ejected.ejection.id)!;
  assert.notEqual(seen.lastSeenAt, null);
  assert.equal(seen.lastNote, 'reverting the store extraction');
  system.store.close();
});

test('ejection refuses what it cannot hold, and refuses to be turned off halfway', async () => {
  const { system } = build({ ejection: { enabled: false, expiryHours: 8, contactGraceMinutes: 15 } });
  await codeAgent(system, 27);
  const off = system.ejections.eject(liveAgentId(system), 'no');
  assert.equal(off.ok, false, 'the control is not offered when the deployment turned it off');

  const { system: on } = build();
  await codeAgent(on, 28);
  const id = liveAgentId(on);
  assert.equal(on.ejections.eject(id, '   ').ok, false, 'a reason is required');
  const first = on.ejections.eject(id, 'taking it');
  assert.ok(first.ok);
  assert.equal(on.ejections.eject(id, 'again').ok, false, 'a dead agent has nothing left to eject');
  system.store.close();
  on.store.close();
});
