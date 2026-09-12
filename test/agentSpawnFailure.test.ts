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

function manager(store: Store): AgentManager {
  return new AgentManager(store, {
    command: 'claude',
    buildArgs: () => [],
    whitelistedApprovals: [],
    createSession: () => new ThrowingSession(),
    resumable: false,
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
