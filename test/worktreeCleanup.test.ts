import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A throwaway git repo with one commit, so real `git worktree` commands work in isolation. */
function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-repo-'));
  const git = (args: string[]): void => void execFileSync('git', args, { cwd: dir });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['commit', '-q', '--allow-empty', '-m', 'root']);
  return dir;
}

function build() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const config = loadConfig({
    labelPrefix: '',
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

/** Dispatch a code agent for an injected issue; returns its task (whose worktree now exists). */
async function codeAgent(sys: ReturnType<typeof build>['system'], issueNumber: number) {
  sys.connector.inject({ kind: 'new_issue', number: issueNumber, title: `Bug ${issueNumber}` });
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

test('a finished code agent has its worktree removed once the process exits', async () => {
  const { system, backend } = build();
  const task = await codeAgent(system, 7);
  const agent = system.store.listAgentsByStatus('starting', 'running')[0]!;
  const cwd = agent.cwd;
  assert.ok(existsSync(cwd), 'worktree should exist while the agent runs');

  backend.last().emit('@@LUBBDUBB_DONE@@\r\n');
  assert.equal(system.store.getTask(task.id)!.status, 'done');
  // Removal waits for the actual process exit — the live process pins the cwd.
  await tick(50);
  assert.ok(existsSync(cwd), 'worktree must survive until the process is reaped');

  backend.last().emitExit(0);
  await waitFor(() => !existsSync(cwd));
  assert.ok(!existsSync(cwd), 'worktree should be removed after done + exit');
  system.store.close();
});

test('a failed agent keeps its worktree for debugging', async () => {
  const { system, backend } = build();
  await codeAgent(system, 8);
  const cwd = system.store.listAgentsByStatus('starting', 'running')[0]!.cwd;

  backend.last().emitExit(1);
  await tick(100);
  assert.ok(existsSync(cwd), 'a failed agent worktree must not be removed');
  system.store.close();
});

test('a shared-branch worktree is not removed while another task on the branch is active', async () => {
  const { system, backend } = build();
  const task = await codeAgent(system, 9);
  const cwd = system.store.listAgentsByStatus('starting', 'running')[0]!.cwd;

  // A second, still-active task on the same branch shares the checkout.
  system.store.createTask({
    kind: 'code',
    title: 'follow-up on same branch',
    prompt: 'x',
    branch: task.branch,
    originRef: null,
    originTitle: null,
    originSummary: null,
    dispatchReason: 'test',
  });

  backend.last().emit('@@LUBBDUBB_DONE@@\r\n');
  backend.last().emitExit(0);
  await tick(100);
  assert.ok(existsSync(cwd), 'shared worktree must not be yanked from an active sibling task');
  system.store.close();
});
