import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store/store.js';
import { AgentManager } from '../src/agents/agentManager.js';
import type { AgentSession, AgentSessionStatus } from '../src/agents/session.js';

/** A session whose start() throws, standing in for a failed real spawn. */
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
  const task = store.createTask({ kind: 'code', title: 't', prompt: 'p', branch: 'b', originRef: null });

  const statuses: string[] = [];
  agents.on('status', (e) => statuses.push(e.status));

  assert.throws(() => agents.spawn(task, '/tmp'), /was not found on PATH/);

  // The half-created agent is torn down: marked failed, not left in `starting`.
  const agent = store.listAgents()[0];
  assert.ok(agent);
  assert.equal(agent.status, 'failed');
  assert.notEqual(agent.endedAt, null);
  assert.equal(agents.isLive(agent.id), false);
  // Task fails too, so it isn't re-dispatched into the same broken command forever.
  assert.equal(store.getTask(task.id)?.status, 'failed');
  // The reason is captured for the operator instead of vanishing.
  assert.match(store.getTranscript(agent.id), /was not found on PATH/);
  assert.deepEqual(statuses, ['failed']);
});
