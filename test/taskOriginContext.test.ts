import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

// The cockpit needs enough of the originating item's context to understand a
// running agent at a glance (issue #17). These tests pin the thread that
// carries the source title/summary/dispatch-reason from dispatch time onto the
// persisted task row so `/api/state` serves it without a second fetch.

test('createTask persists origin context and round-trips through the store', () => {
  const store = new Store(':memory:');
  const task = store.createTask({
    kind: 'code',
    title: 'Resolve issue #13',
    prompt: 'GitHub issue #13 …',
    branch: 'issue/13',
    originRef: 'issue:13',
    originTitle: 'Login broken',
    originSummary: 'Users cannot sign in with SSO.',
    dispatchReason: 'Open issue #13 has no linked PR and no agent is on it.',
  });
  assert.equal(task.originTitle, 'Login broken');

  const fetched = store.getTask(task.id)!;
  assert.equal(fetched.originTitle, 'Login broken');
  assert.equal(fetched.originSummary, 'Users cannot sign in with SSO.');
  assert.equal(fetched.dispatchReason, 'Open issue #13 has no linked PR and no agent is on it.');

  const listed = store.listTasks().find((t) => t.id === task.id)!;
  assert.equal(listed.originSummary, 'Users cannot sign in with SSO.');
  store.close();
});

test('origin context defaults to null when not supplied', () => {
  const store = new Store(':memory:');
  const task = store.createTask({
    kind: 'desk',
    title: 'x',
    prompt: 'x',
    branch: null,
    originRef: null,
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
  });
  const fetched = store.getTask(task.id)!;
  assert.equal(fetched.originTitle, null);
  assert.equal(fetched.originSummary, null);
  assert.equal(fetched.dispatchReason, null);
  store.close();
});

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    // The funnel in front of pickup would spawn an assayer/planner first; this
    // test is about what rule `issue-pickup` puts on the task row.
    planning: { enabled: false } as never,
    assessment: { enabled: false } as never,
    assay: { enabled: false } as never,
  });
}

test('a dispatched task carries the source item title, summary and dispatch reason', async () => {
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend });

  // Straight to rule `issue-pickup`: the deliberation rules in front of pickup are off here, so
  // the agent that spawns is the one working the issue and its task carries the
  // issue's own title and body.
  system.connector.inject({
    kind: 'new_issue',
    number: 901,
    title: 'Add login',
    body: 'Let users sign in with email and password.',
  });
  await system.harness.runCycle('manual');

  const agent = system.store.listAgentsByStatus('starting', 'running')[0]!;
  const task = system.store.getTask(agent.taskId)!;
  assert.equal(task.originTitle, 'Add login', 'source item title should be captured');
  assert.equal(task.originSummary, 'Let users sign in with email and password.');
  assert.match(task.dispatchReason!, /issue #901/, 'the dispatch reason should be persisted');
  system.store.close();
});
