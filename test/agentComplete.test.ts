import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';

/**
 * Operator-declared done (`AgentManager.complete`). An agent reaches the clean
 * terminal only by printing the sentinel, so an agent that finished the work
 * without one used to be endable only by Kill — which records the opposite
 * (`interrupted`), keeps the worktree and reads as an abandonment.
 *
 * What these assert is that completing lands on the *same* terminal a sentinel
 * does, rather than on a second flavour of done: the task, the reap and the
 * worktree removal all come from the path the sentinel already drives.
 */

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A throwaway git repo with one commit, so real `git worktree` commands work in isolation. */
function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-repo-'));
  const git = (args: string[]): void => void execFileSync('git', args, { cwd: dir });
  git(['init', '-q', '-b', 'main']);
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
    // The funnel, the assessor and the assay are pinned off: they default **on**
    // now, and this file is about something else — leaving them on would put an
    // extra agent in front of every issue these assertions dispatch. Each has its
    // own tests.
    planning: { enabled: false } as never,
    assessment: { enabled: false } as never,
    assay: { enabled: false } as never,
    retrospective: { enabled: false } as never,
    auth: { enabled: false } as never,
  });
  const backend = new FakePtyBackend();
  return { system: buildSystem(config, { backend, errorMirror: () => {} }), backend };
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

test('completing an agent lands on the done terminal, not the kill one', async () => {
  const { system, backend } = build();
  const task = await codeAgent(system, 7);
  const agent = system.store.listAgentsByStatus('starting', 'running')[0]!;

  // The shape this exists for: the agent parked without a done sentinel.
  backend.last().emit('@@LUBBDUBB_WAITING:I think that is everything@@\r\n');
  assert.equal(system.store.getAgent(agent.id)!.status, 'waiting');

  assert.equal(system.agents.complete(agent.id), true);
  assert.equal(system.store.getAgent(agent.id)!.status, 'done');
  assert.equal(system.store.getTask(task.id)!.status, 'done', 'the task must read done, not interrupted');
  assert.equal(system.agents.isLive(agent.id), false);
  system.store.close();
});

test('a completed agent is reaped as done, and its worktree removed', async () => {
  const { system } = build();
  await codeAgent(system, 8);
  const agent = system.store.listAgentsByStatus('starting', 'running')[0]!;
  const cwd = agent.cwd;
  const reaps: string[] = [];
  system.agents.on('reaped', ({ status }) => reaps.push(status));

  // The reap rendezvous is unchanged — it still waits on the real process exit
  // (`worktreeCleanup.test.ts` holds that property on the sentinel path). Here the
  // kill *is* the exit, so what this asserts is the half `kill()` suppresses:
  // `exited` is left intact, so a completed agent is reaped where a killed one
  // never is, and the worktree is reclaimed.
  system.agents.complete(agent.id);
  await waitFor(() => !existsSync(cwd));

  assert.deepEqual(reaps, ['done'], 'a completed agent must be reaped, and reaped as done');
  assert.ok(!existsSync(cwd), 'a completed agent gets the clean finish: worktree removed');
  system.store.close();
});

test('completing settles the escalation the agent was parked on', async () => {
  const { system, backend } = build();
  await codeAgent(system, 9);
  const agent = system.store.listAgentsByStatus('starting', 'running')[0]!;

  backend.last().emit('@@LUBBDUBB_WAITING:anything else?@@\r\n');
  assert.equal(system.store.listOpenEscalations().length, 1, 'the park should raise an escalation');

  system.agents.complete(agent.id);
  // An answer would route into a session that no longer exists, so leaving it
  // open is un-actionable clutter in "Needs you" — the same reason a kill
  // cascade-dismisses.
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

  // Liveness is the whole guard: a second completion has nothing to end, and
  // re-labelling a finished record is a different feature.
  const again = await app.inject({ method: 'POST', url: `/api/agents/${agent.id}/complete` });
  assert.equal(again.statusCode, 409);

  backend.last().emitExit(0);
  await app.close();
  system.store.close();
});
