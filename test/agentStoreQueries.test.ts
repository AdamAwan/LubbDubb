import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import type { Agent } from '../src/types.js';

const STATUSES: Agent['status'][] = ['starting', 'running', 'waiting', 'done', 'failed', 'crashed', 'interrupted'];

function seed(store: Store, clock: { at: string }): void {
  let n = 0;
  for (const status of STATUSES) {
    for (let copy = 0; copy < 2; copy += 1) {
      n += 1;
      clock.at = new Date(Date.UTC(2024, 0, 1, 0, 0, n % 3)).toISOString();
      store.agents.createAgent({ taskId: `task_${n}`, cwd: `/tmp/${n}`, pid: null, status });
    }
  }
}

function openStore(): Store {
  const clock = { at: new Date().toISOString() };
  const store = new Store(':memory:', () => clock.at);
  seed(store, clock);
  return store;
}

test('listAgentsByStatus answers exactly what a scan-and-filter answered', () => {
  const store = openStore();
  try {
    const all = store.agents.listAgents();
    for (const picks of [
      ['running'],
      ['crashed', 'interrupted'],
      ['starting', 'running', 'waiting'],
      ['done', 'failed', 'crashed', 'interrupted'],
    ] as Agent['status'][][]) {
      assert.deepEqual(
        store.agents.listAgentsByStatus(...picks),
        all.filter((a) => picks.includes(a.status)),
        `${picks.join('+')} keeps the started_at DESC order the full listing had`,
      );
    }
    assert.deepEqual(store.agents.listAgentsByStatus(), [], 'no statuses asked for is no agents');
  } finally {
    store.close();
  }
});

test('countLiveAgents counts starting, running and waiting, and nothing else', () => {
  const store = openStore();
  try {
    assert.equal(store.agents.countLiveAgents(), 6, 'two rows each in the three live statuses');
    assert.equal(
      store.agents.countLiveAgents(),
      store.agents.listAgents().filter((a) => ['starting', 'running', 'waiting'].includes(a.status)).length,
      'the count is the length of the live listing',
    );
    const live = store.agents.listAgentsByStatus('starting', 'running', 'waiting');
    store.agents.updateAgent(live[0]!.id, { status: 'done' });
    assert.equal(store.agents.countLiveAgents(), 5, 'a finished agent stops counting against the cap');
  } finally {
    store.close();
  }
});

test('a status outside the vocabulary is not live', () => {
  const store = new Store(':memory:');
  try {
    const agent = store.agents.createAgent({ taskId: 'task_1', cwd: '/tmp/1', pid: null, status: 'running' });
    assert.equal(store.agents.countLiveAgents(), 1);
    store.agents.updateAgent(agent.id, { status: 'gone' as Agent['status'] });
    assert.equal(store.agents.countLiveAgents(), 0, 'only the three live statuses count');
    assert.deepEqual(store.agents.listAgentsByStatus('gone' as Agent['status']).length, 1, 'but it is still findable');
  } finally {
    store.close();
  }
});
