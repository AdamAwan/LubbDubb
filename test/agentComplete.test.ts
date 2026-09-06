import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { gitRepo } from './support/gitRepo.js';
import { failPlanningOpen } from './support/plans.js';
import { pinnedPool } from './support/worktrees.js';

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function build() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
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
  });
  const backend = new FakePtyBackend();
  const pool = pinnedPool(config, 1);
  const system = buildSystem(config, { backend, worktrees: pool.worktrees, errorMirror: () => {} });
  pool.attach(system);
  return { system, backend };
}

async function codeAgent(sys: ReturnType<typeof build>['system'], issueNumber: number) {
  sys.connector.inject({ kind: 'new_issue', number: issueNumber, title: `Bug ${issueNumber}` });
  failPlanningOpen(sys.store, issueNumber);
  await sys.harness.runCycle('manual');
  const task = sys.store.listTasks().find((t) => t.kind === 'code' && t.branch === `issue/${issueNumber}`);
  assert.ok(task, 'a code task should have been dispatched');
  return task!;
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) return;
    await tick(20);
  }
}

test('completing an agent lands on the done terminal, not the kill one', async () => {
  const { system, backend } = build();
  const task = await codeAgent(system, 7);
  const agent = system.store.listAgentsByStatus('starting', 'running')[0]!;

  backend.last().emit('@@LUBBDUBB_WAITING:I think that is everything@@\r\n');
  assert.equal(system.store.getAgent(agent.id)!.status, 'waiting');

  assert.equal(system.agents.complete(agent.id), true);
  assert.equal(system.store.getAgent(agent.id)!.status, 'done');
  assert.equal(system.store.getTask(task.id)!.status, 'done', 'the task must read done, not interrupted');
  assert.equal(system.agents.isLive(agent.id), false);
  system.store.close();
});

test('a completed agent is reaped as done, and its worktree slot released', async () => {
  const { system } = build();
  await codeAgent(system, 8);
  const agent = system.store.listAgentsByStatus('starting', 'running')[0]!;
  const cwd = agent.cwd;
  const reaps: string[] = [];
  system.agents.on('reaped', ({ status }) => reaps.push(status));

  system.agents.complete(agent.id);
  await waitFor(() => reaps.length > 0);

  assert.deepEqual(reaps, ['done'], 'a completed agent must be reaped, and reaped as done');
  assert.ok(existsSync(cwd), 'the directory stays — releasing the slot is not deleting it');
  assert.equal(await system.worktrees.ensure('someone/else', 'main'), cwd, 'the slot is back in the pool');
  system.store.close();
});

test('completing settles the escalation the agent was parked on', async () => {
  const { system, backend } = build();
  await codeAgent(system, 9);
  const agent = system.store.listAgentsByStatus('starting', 'running')[0]!;

  backend.last().emit('@@LUBBDUBB_WAITING:anything else?@@\r\n');
  assert.equal(system.store.listOpenEscalations().length, 1, 'the park should raise an escalation');

  system.agents.complete(agent.id);
  assert.equal(system.store.listOpenEscalations().length, 0);
  system.store.close();
});

test('completing is audited as the operator’s own act', async () => {
  const { system, backend } = build();
  await codeAgent(system, 10);
  const agent = system.store.listAgentsByStatus('starting', 'running')[0]!;
  backend.last().emit('@@LUBBDUBB_WAITING:done I think@@\r\n');

  system.agents.complete(agent.id);
  const row = system.store.listDecisions(50).find((d) => d.cycleId === `human:${agent.id}`);
  assert.ok(row, 'a decision must be recorded under the human: cycle id the cockpit badges');
  assert.equal(row!.outcome, 'executed');
  system.store.close();
});

test('completing an agent that is no longer live is refused', async () => {
  const { system, backend } = build();
  await codeAgent(system, 11);
  const agent = system.store.listAgentsByStatus('starting', 'running')[0]!;
  const { app } = await buildApp(system);

  const ok = await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/complete` });
  assert.equal(ok.statusCode, 200);

  const again = await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/complete` });
  assert.equal(again.statusCode, 409);

  backend.last().emitExit(0);
  await app.close();
  system.store.close();
});
