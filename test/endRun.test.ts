import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { clearGoalWork } from '../src/floor/endRun.js';
import { buildSystem } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

function store(): Store {
  return new Store(':memory:');
}

function liveAgent(s: Store, originRef: string, status: 'running' | 'done' = 'running'): string {
  const task = s.createTask({ kind: 'code', title: originRef, prompt: 'go', branch: null, originRef });
  const agent = s.createAgent({ taskId: task.id, cwd: '/tmp', pid: 1 });
  s.updateAgent(agent.id, { status });
  return agent.id;
}

test('ending a run kills the goal’s agents, cancels its jobs and settles its instructions', () => {
  const s = store();
  const killed: string[] = [];
  const agents = {
    kill: (id: string) => {
      killed.push(id);
      return true;
    },
  };

  const pickup = liveAgent(s, 'issue:12');
  const part = liveAgent(s, 'issue:12:part:api');
  const settled = liveAgent(s, 'issue:12:plan', 'done');
  const neighbour = liveAgent(s, 'issue:1');
  const review = liveAgent(s, 'pr:42');

  const mine = s.createJob({ title: 'redo the retro', prompt: 'x', kind: 'desk', originRef: 'issue:12:retro' });
  const theirs = s.createJob({ title: 'someone else', prompt: 'x', kind: 'desk', originRef: 'issue:1' });
  const loose = s.createJob({ title: 'no origin', prompt: 'x', kind: 'desk' });

  s.addIssueInstruction({ originRef: 'issue:12', text: 'also do the migration' });
  s.addIssueInstruction({ originRef: 'issue:12', text: 'and rename the flag' });
  s.addIssueInstruction({ originRef: 'issue:1', text: 'not this goal' });

  const cleared = clearGoalWork(s, agents, 12);

  assert.deepEqual(cleared, { agents: 2, jobs: 1, instructions: 2 });
  assert.deepEqual(killed.sort(), [pickup, part].sort(), 'the goal’s live agents, and only those');
  for (const spared of [settled, neighbour, review]) assert.ok(!killed.includes(spared));

  assert.equal(s.getJob(mine.id)?.status, 'cancelled');
  assert.equal(s.getJob(theirs.id)?.status, 'queued', 'issue:1 is not under issue:12');
  assert.equal(s.getJob(loose.id)?.status, 'queued', 'a job standing in for nothing is nobody’s');

  assert.equal(s.listStandingInstructions('issue:12').length, 0);
  assert.equal(s.listStandingInstructions('issue:1').length, 1);
});

test('ending a run at a quiet goal clears nothing and says so', () => {
  const s = store();
  const cleared = clearGoalWork(s, { kill: () => true }, 12);
  assert.deepEqual(cleared, { agents: 0, jobs: 0, instructions: 0 });
});

test('the dismiss-run route does the clearing, and reports what it cleared', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-endrun-'));
  const system = buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
  const { store } = system;
  store.recordIssueRun({
    originRef: 'issue:12',
    issueNumber: 12,
    title: 'Add the thing',
    body: '',
    labels: [],
    linkedPrNumber: null,
    workItemState: null,
    complete: false,
  });
  const job = store.createJob({ title: 'redo it', prompt: 'x', kind: 'desk', originRef: 'issue:12' });
  store.addIssueInstruction({ originRef: 'issue:12', text: 'also do the migration' });

  const { app } = await buildApp(system);
  const ended = await app.inject({ method: 'POST', url: '/api/issues/12/dismiss-run' });
  assert.equal(ended.statusCode, 200);
  assert.deepEqual(ended.json().cleared, { agents: 0, jobs: 1, instructions: 1 });
  assert.equal(store.getJob(job.id)?.status, 'cancelled');
  assert.equal(store.listStandingInstructions('issue:12').length, 0);

  const again = await app.inject({ method: 'POST', url: '/api/issues/12/dismiss-run' });
  assert.equal(again.statusCode, 409);

  await app.close();
  store.close();
});
