import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem } from '../src/system/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { PrAgentsPayload, PullRequest } from '../src/wire.js';

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
}

function pr(number: number, branch: string): PullRequest {
  return {
    id: `pr_${number}`,
    number,
    title: `Change ${number}`,
    branch,
    ciStatus: 'passing',
    unresolvedComments: [],
    state: 'open',
    author: 'me',
    viewerAuthored: true,
    assignees: [],
  };
}

test('GET /api/prs/agents groups the live agents by the pull request they are on', async () => {
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  const { app } = await buildApp(system);
  const { store } = system;
  store.world.setWorldBaseline({
    takenAt: new Date().toISOString(),
    pullRequests: [pr(10, 'issue/1'), pr(20, 'issue/2')],
    issues: [],
  });

  const spawn = (title: string, originRef: string, branch: string | null) => {
    const task = store.tasks.createTask({ kind: 'code', title, prompt: 'p', branch, originRef });
    return store.agents.createAgent({ taskId: task.id, cwd: '/wt', pid: null });
  };

  const byOrigin = spawn('Address review on PR 10', 'pr:10:review', null);
  const byBranch = spawn('Build issue 2', 'issue:2', 'issue/2');
  const job = store.jobs.createJob({ title: 'requeue', prompt: 'p', kind: 'code', branch: null, originRef: 'pr:10' });
  const requeued = spawn('Requeued work', `job:${job.id}`, null);
  spawn('Unrelated', 'issue:3', 'issue/3');
  const ended = spawn('Finished on PR 20', 'pr:20', null);
  store.agents.updateAgent(ended.id, { status: 'done', endedAt: new Date().toISOString() });
  for (const a of [byOrigin, byBranch, requeued]) store.agents.updateAgent(a.id, { status: 'running' });

  const res = await app.inject({ method: 'GET', url: '/api/prs/agents' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as PrAgentsPayload;
  assert.deepEqual(
    body.prs.map((p) => [p.number, p.agents.map((a) => a.id).sort()]),
    [
      [10, [byOrigin.id, requeued.id].sort()],
      [20, [byBranch.id]],
    ],
    'an ended agent and one on no pull request are left out; a job origin is read through to its pull request',
  );
  await app.close();
  store.close?.();
});
