import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';

/** A throwaway git repo with one commit, so real `git worktree add` works in isolation. */
function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-repo-'));
  const git = (args: string[]): void => void execFileSync('git', args, { cwd: dir });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['commit', '-q', '--allow-empty', '-m', 'root']);
  return dir;
}

/** Build a system whose agents run through a fake PTY and whose worktrees live in an isolated repo. */
function build() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const config = loadConfig({
    dbPath: ':memory:',
    dispatcher: 'rule',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    repoRoot: gitRepo(),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
  const backend = new FakePtyBackend();
  return { system: buildSystem(config, { backend }), backend };
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

test('a behind PR is brought up to date, not merged', async () => {
  const { system } = build();
  system.connector.inject({ kind: 'new_pr', number: 45, title: 'X', branch: 'feat4', baseBranch: 'main' });
  system.connector.inject({ kind: 'pr_mergeable', prNumber: 45, mergeable: true, mergeableState: 'behind' });
  await system.harness.runCycle('manual');

  const task = system.store.listTasks().find((t) => t.originRef === 'pr:45:mergeable');
  assert.ok(task, 'a base-update task should exist');
  assert.equal(task!.branch, 'feat4');
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
