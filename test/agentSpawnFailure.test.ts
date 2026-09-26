import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store/store.js';
import { AgentManager } from '../src/agents/agentManager.js';
import type { AgentSession, AgentSessionStatus } from '../src/agents/session.js';

class ThrowingSession extends EventEmitter implements AgentSession {
  status: AgentSessionStatus = 'starting';
  pid: number | null = null;
  start(): void {
    throw new Error("Agent command 'claude' was not found on PATH.");
  }
  send(): void {}
  sendRaw(): void {}
  kill(): void {}
}

function tokenLedger() {
  const live = new Map<string, string>();
  let n = 0;
  return {
    live,
    open: () => ({ token: `tok${++n}`, configPath: null }),
    bind: (token: string, agentId: string) => void live.set(token, agentId),
    release: (token: string) => void live.delete(token),
  };
}

function manager(store: Store, mcp = tokenLedger(), resumable = false): AgentManager {
  return new AgentManager(store, {
    command: 'claude',
    buildArgs: () => [],
    whitelistedApprovals: [],
    createSession: () => new ThrowingSession(),
    resumable,
    mcp,
  });
}

test('a spawn that throws surfaces the reason and leaves no live agent', () => {
  const store = new Store(':memory:');
  const agents = manager(store);
  const task = store.tasks.createTask({ kind: 'code', title: 't', prompt: 'p', branch: 'b', originRef: null });

  const statuses: string[] = [];
  agents.on('status', (e) => statuses.push(e.status));

  assert.throws(() => agents.spawn(task, '/tmp'), /was not found on PATH/);

  const agent = store.agents.listAgents()[0];
  assert.ok(agent);
  assert.equal(agent.status, 'failed');
  assert.notEqual(agent.endedAt, null);
  assert.equal(agents.isLive(agent.id), false);
  assert.equal(store.tasks.getTask(task.id)?.status, 'failed');
  assert.match(store.transcripts.getTranscript(agent.id), /was not found on PATH/);
  assert.deepEqual(statuses, ['failed']);
});

test("a spawn that throws releases the agent's MCP token", () => {
  const store = new Store(':memory:');
  const mcp = tokenLedger();
  const agents = manager(store, mcp);
  const task = store.tasks.createTask({ kind: 'code', title: 't', prompt: 'p', branch: 'b', originRef: null });

  assert.throws(() => agents.spawn(task, '/tmp'));
  assert.equal(mcp.live.size, 0);
});

test('a resume that throws puts the agent back as it was and releases its token', () => {
  const store = new Store(':memory:');
  const mcp = tokenLedger();
  const agents = manager(store, mcp, true);
  const created = store.tasks.createTask({ kind: 'code', title: 't', prompt: 'p', branch: 'b', originRef: null });
  const row = store.agents.createAgent({
    taskId: created.id,
    cwd: '/tmp',
    pid: null,
    status: 'starting',
    sessionId: 's1',
  });
  store.agents.updateAgent(row.id, { status: 'crashed', endedAt: '2026-01-01T00:00:00.000Z' });
  store.tasks.updateTask(created.id, { status: 'failed', agentId: row.id });
  const agent = store.agents.getAgent(row.id)!;
  const task = store.tasks.getTask(created.id)!;

  assert.throws(() => agents.resume(agent, task), /resume spawn failed/);

  assert.equal(store.agents.getAgent(agent.id)?.status, 'crashed');
  assert.equal(store.agents.getAgent(agent.id)?.endedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(store.tasks.getTask(task.id)?.status, 'failed');
  assert.equal(mcp.live.size, 0);
});
