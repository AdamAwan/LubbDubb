import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { gitRepo } from './support/gitRepo.js';
import type { ActionSink } from '../src/sink/actionSink.js';
import { findTask } from './support/tasks.js';

function build(overrides: Partial<ActionSink> = {}) {
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
  });
  const backend = new FakePtyBackend();
  const held: { inner?: ActionSink } = {};
  const sink = new Proxy({} as ActionSink, {
    get: (_t, prop: string) =>
      (overrides as Record<string, unknown>)[prop] ??
      ((input: never): unknown => (held.inner as unknown as Record<string, (i: never) => unknown>)[prop]!(input)),
  });
  const system = buildSystem(config, { backend, sink });
  held.inner = system.connector;
  return { system, backend };
}

function notifiedFor(system: ReturnType<typeof build>['system'], origin: string) {
  return system.store.decisions.listDecisions().filter((d) => {
    if (d.outcome !== 'executed' || d.action.type !== 'respond_to_agent') return false;
    const origins = d.action.originRefs;
    return Array.isArray(origins) && origins.includes(origin);
  });
}

test('a conflicted PR dispatches a resolve-conflicts code agent', async () => {
  const { system } = build();
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'feat', baseBranch: 'main' });
  system.connector.inject({ kind: 'pr_mergeable', prNumber: 42, mergeable: false, mergeableState: 'dirty' });
  await system.harness.runCycle('manual');

  const task = findTask(system.store, (t) => t.originRef === 'pr:42:mergeable');
  assert.ok(task, 'a conflict-resolution task should exist');
  assert.equal(task!.branch, 'feat');
  assert.match(task!.prompt, /resolve the conflicts/i);
  system.store.close();
});

test('a behind PR is brought up to date by the provider, with no agent dispatched', async () => {
  const { system } = build();
  system.connector.inject({ kind: 'new_pr', number: 45, title: 'X', branch: 'feat4', baseBranch: 'main' });
  system.connector.inject({ kind: 'pr_mergeable', prNumber: 45, mergeable: true, mergeableState: 'behind' });
  await system.harness.runCycle('manual');

  assert.equal(
    system.store.tasks.listTasks().filter((t) => t.originRef === 'pr:45:mergeable').length,
    0,
    'a routine base merge costs no agent',
  );
  const done = system.store.decisions
    .listDecisions()
    .find((d) => d.action.type === 'update_pr_branch' && d.action.originRef === 'pr:45:mergeable');
  assert.ok(done, 'the act is in the decision log');
  assert.equal(done!.outcome, 'executed');
  assert.equal(done!.rule, 'pr-base-update', 'attributed to the rule that proposed it');
  assert.match(done!.detail, /up to date with main/i);

  const world = await system.connector.getState();
  assert.equal(world.pullRequests.find((p) => p.number === 45)!.mergeableState, 'clean');
  system.store.close();
});

test('a base update the provider refuses falls back to a code agent, and is recorded', async () => {
  const { system } = build({
    updatePrBranch: () => Promise.reject(new Error('update-branch refused')),
  });
  system.connector.inject({ kind: 'new_pr', number: 46, title: 'X', branch: 'feat5', baseBranch: 'main' });
  system.connector.inject({ kind: 'pr_mergeable', prNumber: 46, mergeable: true, mergeableState: 'behind' });

  await system.harness.runCycle('manual');
  const failed = system.store.decisions.listDecisions().find((d) => d.action.type === 'update_pr_branch');
  assert.equal(failed?.outcome, 'rejected');
  assert.match(failed!.detail, /update-branch refused/);
  assert.equal(system.store.tasks.listTasks().length, 0, 'nothing dispatched on the cycle that tried');
  assert.match(system.store.errors.listErrors()[0]?.message ?? '', /Updating PR #46 from main failed/);

  await system.harness.runCycle('manual');
  const task = findTask(system.store, (t) => t.originRef === 'pr:46:mergeable');
  assert.ok(task, 'the PR is not left sitting behind its base');
  assert.equal(task!.branch, 'feat5');
  assert.match(task!.prompt, /up to date/i);
  system.store.close();
});

test('a second concern on a running branch notifies the live agent, not a duplicate', async () => {
  const { system, backend } = build();
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'feat', baseBranch: 'main' });
  system.connector.inject({ kind: 'ci_failed', prNumber: 42 });
  await system.harness.runCycle('manual');

  system.connector.inject({ kind: 'pr_mergeable', prNumber: 42, mergeable: false, mergeableState: 'dirty' });
  await system.harness.runCycle('manual');

  assert.equal(
    system.store.tasks.listTasks().filter((t) => t.branch === 'feat').length,
    1,
    'still one agent on the branch',
  );
  assert.equal(notifiedFor(system, 'pr:42:mergeable').length, 1, 'the conflict was delivered to the running agent');
  assert.match(backend.last().writes.join(''), /merge main in, resolve the conflicts/i);
  system.store.close();
});

test('a branch with a running agent is told its base moved, never merged under', async () => {
  const { system, backend } = build();
  system.connector.inject({ kind: 'new_pr', number: 47, title: 'X', branch: 'feat6', baseBranch: 'main' });
  system.connector.inject({ kind: 'ci_failed', prNumber: 47 });
  await system.harness.runCycle('manual');

  system.connector.inject({ kind: 'pr_mergeable', prNumber: 47, mergeable: true, mergeableState: 'behind' });
  await system.harness.runCycle('manual');

  assert.equal(
    system.store.decisions.listDecisions().filter((d) => d.action.type === 'update_pr_branch').length,
    0,
    'nothing is pushed to a branch an agent holds',
  );
  assert.equal(notifiedFor(system, 'pr:47:mergeable').length, 1, 'the agent is told instead');
  assert.match(backend.last().writes.join(''), /behind main/i);
  system.store.close();
});

test('a concern on a waiting branch is held, then delivered once the agent resumes', async () => {
  const { system, backend } = build();
  system.connector.inject({ kind: 'new_pr', number: 44, title: 'X', branch: 'feat3', baseBranch: 'main' });
  system.connector.inject({ kind: 'ci_failed', prNumber: 44 });
  await system.harness.runCycle('manual');

  const agentId = system.store.agents.listAgentsByStatus('running')[0]!.id;
  backend.last().emit('@@LUBBDUBB_WAITING:need a decision@@');
  assert.equal(system.store.agents.getAgent(agentId)!.status, 'waiting');

  system.connector.inject({ kind: 'pr_mergeable', prNumber: 44, mergeable: false, mergeableState: 'dirty' });
  await system.harness.runCycle('manual');
  assert.equal(notifiedFor(system, 'pr:44:mergeable').length, 0, 'must not inject while the agent is waiting');

  const esc = system.store.escalations.listOpenEscalations()[0]!;
  system.escalations.answer(esc.id, 'go ahead');
  assert.equal(system.store.agents.getAgent(agentId)!.status, 'running');
  await system.harness.runCycle('manual');
  assert.equal(notifiedFor(system, 'pr:44:mergeable').length, 1, 'the held conflict is delivered once running again');
  system.store.close();
});
