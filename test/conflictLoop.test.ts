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

/**
 * Build a system whose agents run through a fake PTY and whose worktrees live in
 * an isolated repo. `overrides` replaces individual sink methods — the rest still
 * reach the fake world, so a test can break one act without losing the loop.
 */
function build(overrides: Partial<ActionSink> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const config = loadConfig({
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
  // The sink has to exist before the system it delegates to does, so it reads the
  // real one out of a holder the build fills in.
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

/** Executed respond_to_agent decisions whose note covers the given origin. */
function notifiedFor(system: ReturnType<typeof build>['system'], origin: string) {
  return system.store.listDecisions().filter((d) => {
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

  const task = system.store.listTasks().find((t) => t.originRef === 'pr:42:mergeable');
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
    system.store.listTasks().filter((t) => t.originRef === 'pr:45:mergeable').length,
    0,
    'a routine base merge costs no agent',
  );
  const done = system.store
    .listDecisions()
    .find((d) => d.action.type === 'update_pr_branch' && d.action.originRef === 'pr:45:mergeable');
  assert.ok(done, 'the act is in the decision log');
  assert.equal(done!.outcome, 'executed');
  assert.equal(done!.rule, 'pr-base-update', 'attributed to the rule that proposed it');
  assert.match(done!.detail, /up to date with main/i);

  // Reflected back into the world, so the concern is gone rather than re-fired.
  const world = await system.connector.getState();
  assert.equal(world.pullRequests.find((p) => p.number === 45)!.mergeableState, 'clean');
  system.store.close();
});

test('a base update the provider refuses falls back to a code agent, and is recorded', async () => {
  const { system } = build({
    // Everything else behaves; the one act under test throws, the way GitHub does
    // when the merge it promised was clean is not.
    updatePrBranch: () => Promise.reject(new Error('update-branch refused')),
  });
  system.connector.inject({ kind: 'new_pr', number: 46, title: 'X', branch: 'feat5', baseBranch: 'main' });
  system.connector.inject({ kind: 'pr_mergeable', prNumber: 46, mergeable: true, mergeableState: 'behind' });

  await system.harness.runCycle('manual');
  const failed = system.store.listDecisions().find((d) => d.action.type === 'update_pr_branch');
  assert.equal(failed?.outcome, 'rejected');
  assert.match(failed!.detail, /update-branch refused/);
  assert.equal(system.store.listTasks().length, 0, 'nothing dispatched on the cycle that tried');
  // The failure is a first-class error, not a decision row nobody reads.
  assert.match(system.store.listErrors()[0]?.message ?? '', /Updating PR #46 from main failed/);

  // Next pulse: the PR is still behind and the cheap path is spent, so the agent
  // that always did this work is dispatched with the routine-update prompt.
  await system.harness.runCycle('manual');
  const task = system.store.listTasks().find((t) => t.originRef === 'pr:46:mergeable');
  assert.ok(task, 'the PR is not left sitting behind its base');
  assert.equal(task!.branch, 'feat5');
  assert.match(task!.prompt, /up to date/i);
  system.store.close();
});

test('a second concern on a running branch notifies the live agent, not a duplicate', async () => {
  const { system, backend } = build();
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'feat', baseBranch: 'main' });
  system.connector.inject({ kind: 'ci_failed', prNumber: 42 });
  await system.harness.runCycle('manual'); // dispatches the CI agent (now running)

  // A conflict arrives while the CI agent is working the branch.
  system.connector.inject({ kind: 'pr_mergeable', prNumber: 42, mergeable: false, mergeableState: 'dirty' });
  await system.harness.runCycle('manual');

  assert.equal(system.store.listTasks().filter((t) => t.branch === 'feat').length, 1, 'still one agent on the branch');
  assert.equal(notifiedFor(system, 'pr:42:mergeable').length, 1, 'the conflict was delivered to the running agent');
  assert.match(backend.last().writes.join(''), /merge main in, resolve the conflicts/i);
  system.store.close();
});

test('a branch with a running agent is told its base moved, never merged under', async () => {
  // The agent's worktree was cut from the branch's current head. Merging the base
  // in behind its back moves the commit it is working from, so the staffed branch
  // gets the note it always got and the cheap path stays for free branches.
  const { system, backend } = build();
  system.connector.inject({ kind: 'new_pr', number: 47, title: 'X', branch: 'feat6', baseBranch: 'main' });
  system.connector.inject({ kind: 'ci_failed', prNumber: 47 });
  await system.harness.runCycle('manual'); // the CI agent takes the branch

  system.connector.inject({ kind: 'pr_mergeable', prNumber: 47, mergeable: true, mergeableState: 'behind' });
  await system.harness.runCycle('manual');

  assert.equal(
    system.store.listDecisions().filter((d) => d.action.type === 'update_pr_branch').length,
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
  await system.harness.runCycle('manual'); // CI agent running

  const agentId = system.store.listAgentsByStatus('running')[0]!.id;
  backend.last().emit('@@LUBBDUBB_WAITING:need a decision@@'); // park the agent on a human
  assert.equal(system.store.getAgent(agentId)!.status, 'waiting');

  // A conflict arrives while the agent is parked — it must be held.
  system.connector.inject({ kind: 'pr_mergeable', prNumber: 44, mergeable: false, mergeableState: 'dirty' });
  await system.harness.runCycle('manual');
  assert.equal(notifiedFor(system, 'pr:44:mergeable').length, 0, 'must not inject while the agent is waiting');

  // Human answers -> agent resumes -> a later cycle delivers the held note.
  const esc = system.store.listOpenEscalations()[0]!;
  system.escalations.answer(esc.id, 'go ahead');
  assert.equal(system.store.getAgent(agentId)!.status, 'running');
  await system.harness.runCycle('manual');
  assert.equal(notifiedFor(system, 'pr:44:mergeable').length, 1, 'the held conflict is delivered once running again');
  system.store.close();
});
