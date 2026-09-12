import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { OVERLAP_AGENT_WINDOW } from '../src/fileOverlap.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

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

test('GET /api/agents/:id/files answers one agent, and 404s an agent that does not exist', async () => {
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  const { app } = await buildApp(system);

  const taskA = system.store.tasks.createTask({
    kind: 'code',
    title: 'a',
    prompt: 'p',
    branch: 'b1',
    originRef: 'issue:1',
  });
  const taskB = system.store.tasks.createTask({
    kind: 'code',
    title: 'b',
    prompt: 'p',
    branch: 'b2',
    originRef: 'issue:2',
  });
  const a = system.store.agents.createAgent({ taskId: taskA.id, cwd: '/wt/a', pid: null });
  const b = system.store.agents.createAgent({ taskId: taskB.id, cwd: '/wt/b', pid: null });
  system.store.agents.recordFile(a.id, { path: 'src/wire.ts', tool: 'Write', promoted: false });
  system.store.agents.recordFile(a.id, { path: 'src/system.ts', tool: 'Edit', promoted: false });
  system.store.agents.recordFile(b.id, { path: 'README.md', tool: 'Write', promoted: false });

  const res = await app.inject({ method: 'GET', url: `/api/agents/${a.id}/files` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { agentId: string; files: { path: string }[] };
  assert.equal(body.agentId, a.id);
  assert.deepEqual(body.files.map((f) => f.path).sort(), ['src/system.ts', 'src/wire.ts']);

  assert.equal((await app.inject({ method: 'GET', url: '/api/agents/agent_nope/files' })).statusCode, 404);

  system.store.close();
});

test('the state snapshot no longer ships a fleet-wide files list', () => {
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: 'a',
    prompt: 'p',
    branch: 'b',
    originRef: 'issue:1',
  });
  const agent = system.store.agents.createAgent({ taskId: task.id, cwd: '/wt/a', pid: null });
  system.store.agents.recordFile(agent.id, { path: 'src/wire.ts', tool: 'Write', promoted: false });

  const snap: Record<string, unknown> = { ...buildStateSnapshot(system) };
  assert.equal('files' in snap, false, 'the drawer fetches its own rows; nothing polls the whole table');
  assert.ok(Array.isArray(snap.overlaps));

  system.store.close();
});

test('scope drift still sees a part whose agent is older than the overlap window', () => {
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  const store = system.store;

  const plan = store.plans.upsertPlan({
    originRef: 'issue:12',
    title: 'Issue #12',
    status: 'active',
    reason: 'Two pull requests of work.',
  });
  store.plans.upsertPlanParts(plan.id, [
    {
      slug: 'schema',
      seq: 1,
      title: 'Schema',
      scope: 'the store',
      touches: ['src/store/'],
      dependsOn: [],
      rationale: null,
      acceptance: null,
      size: null,
      expectedKind: null,
      profile: null,
    },
  ]);

  const partTask = store.tasks.createTask({
    kind: 'code',
    title: 'Schema',
    prompt: 'p',
    branch: 'issue/12/schema',
    originRef: 'issue:12:part:schema',
  });
  const partAgent = store.agents.createAgent({ taskId: partTask.id, cwd: '/wt/p', pid: null });
  store.tasks.updateTask(partTask.id, { agentId: partAgent.id });
  store.agents.recordFile(partAgent.id, { path: 'src/wire.ts', tool: 'Write', promoted: false });

  for (let i = 0; i < OVERLAP_AGENT_WINDOW + 5; i++) {
    const t = store.tasks.createTask({
      kind: 'code',
      title: `t${i}`,
      prompt: 'p',
      branch: `b${i}`,
      originRef: `issue:${i}`,
    });
    const a = store.agents.createAgent({ taskId: t.id, cwd: `/wt/${i}`, pid: null });
    store.tasks.updateTask(t.id, { agentId: a.id });
    store.agents.recordFile(a.id, { path: `src/other/${i}.ts`, tool: 'Write', promoted: false });
  }

  const snap = buildStateSnapshot(system);
  const drifted = snap.planParts.find((p) => p.slug === 'schema');
  assert.deepEqual(
    drifted?.outsideScope,
    ['src/wire.ts'],
    'a part is judged against its own agents, however far down the fleet history they are',
  );

  system.store.close();
});
