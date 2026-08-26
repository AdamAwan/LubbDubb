import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import type { Spawner, StreamChild } from '../src/agents/streamJsonSession.js';
import { gitRepo } from './support/gitRepo.js';
import { failPlanningOpen } from './support/plans.js';
import { pinnedPool } from './support/worktrees.js';

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function build() {
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
    // The assessor and the appraisal are pinned off: they default **on**, and this
    // file is about something else — leaving them on would put an extra agent in
    // front of every issue these assertions dispatch. Each has its own tests.
    // (The planning funnel cannot be pinned off; a goal is planned by writing the
    // funnel having failed open on it — `failPlanningOpen`.)
  });
  const backend = new FakePtyBackend();
  // A pool of one, so "is the slot free again" is observable: with room to grow, a
  // second branch is handed a *new* slot rather than the released one, because
  // reuse is scoped to the branch and a hand-over wipes the tree. The pool the
  // composition root builds follows the agent cap, so the bound is pinned by
  // injecting the manager rather than by a config key.
  const pool = pinnedPool(config, 1);
  const system = buildSystem(config, { backend, worktrees: pool.worktrees });
  pool.attach(system);
  return { system, backend };
}

/**
 * A fake headless `claude` child whose `kill()` is deliberately silent — a real
 * signalled process dies *later*, and `exit` must land as its own event for the
 * kill/reap rendezvous to be worth testing at all. `crash()` drives that later exit.
 */
class FakeStreamChild extends EventEmitter implements StreamChild {
  pid = 555;
  stdout = { on: () => {} } as unknown as NodeJS.ReadableStream;
  stderr = null;
  stdin = { write: () => {}, end: () => {} } as unknown as NodeJS.WritableStream;
  override on(event: 'exit', cb: (code: number | null) => void): this {
    return super.on(event, cb);
  }
  crash(code: number): void {
    this.emit('exit', code);
  }
  kill(): void {}
}

/** Same pool/config shape as {@link build}, but on the stream runtime so a kill's
 * exit is a later, separate event instead of firing synchronously off `kill()`. */
function buildStream() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'stream',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    repoRoot: gitRepo(),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
  const children: FakeStreamChild[] = [];
  const spawner: Spawner = (_command, _args, _opts) => {
    const child = new FakeStreamChild();
    children.push(child);
    return child;
  };
  const pool = pinnedPool(config, 1);
  const system = buildSystem(config, { streamSpawner: spawner, worktrees: pool.worktrees });
  pool.attach(system);
  return { system, children };
}

/** Dispatch a code agent for an injected issue; returns its task (whose worktree now exists). */
async function codeAgent(sys: ReturnType<typeof build>['system'], issueNumber: number) {
  sys.connector.inject({ kind: 'new_issue', number: issueNumber, title: `Bug ${issueNumber}` });
  failPlanningOpen(sys.store, issueNumber);
  await sys.harness.runCycle('manual');
  const task = sys.store.listTasks().find((t) => t.kind === 'code' && t.branch === `issue/${issueNumber}`);
  assert.ok(task, 'a code task should have been dispatched');
  return task!;
}

/**
 * Whether the slot is free — asked the only way that is observable from here. With
 * the pool at one, a held slot makes `ensure` throw rather than hand back another
 * directory, and that refusal is the same answer.
 */
async function reissued(sys: ReturnType<typeof build>['system'], cwd: string, branch: string): Promise<boolean> {
  try {
    return (await sys.worktrees.ensure(branch, 'main')) === cwd;
  } catch {
    return false;
  }
}

test('a finished code agent has its worktree slot released once the process exits', async () => {
  const { system, backend } = build();
  const task = await codeAgent(system, 7);
  const agent = system.store.listAgentsByStatus('starting', 'running')[0]!;
  const cwd = agent.cwd;
  assert.ok(existsSync(cwd), 'the slot should exist while the agent runs');

  backend.last().emit('@@LUBBDUBB_DONE@@\r\n');
  assert.equal(system.store.getTask(task.id)!.status, 'done');
  // The release waits for the actual process exit — the agent is still sitting in
  // that directory, and the next occupant cleans and switches it.
  await tick(50);
  assert.equal(await reissued(system, cwd, 'someone/else'), false, 'held until the process is reaped');
  await system.worktrees.remove('someone/else');

  const reaped = new Promise<void>((r) => system.agents.on('reaped', () => r()));
  backend.last().emitExit(0);
  await reaped;
  await tick(20);

  assert.ok(existsSync(cwd), 'nothing is deleted — the ignored build state is what makes the branch’s next run warm');
  assert.equal(await reissued(system, cwd, 'someone/later'), true, 'and the slot is back in the pool');
  system.store.close();
});

test('a failed agent keeps its worktree for debugging, but not its lease', async () => {
  const { system, backend } = build();
  await codeAgent(system, 8);
  const cwd = system.store.listAgentsByStatus('starting', 'running')[0]!.cwd;

  backend.last().emitExit(1);
  await tick(100);

  assert.ok(existsSync(cwd), 'a failed agent worktree must not be removed');
  // Nothing else releases a lease, so skipping the failed ones would shrink the
  // pool by one per failure with nothing at all to say so.
  assert.equal(await reissued(system, cwd, 'someone/else'), true, 'the slot goes back to the pool');
  system.store.close();
});

test('a killed agent keeps its worktree, and its lease releases once the process exits', async () => {
  const { system, children } = buildStream();
  await codeAgent(system, 10);
  const agent = system.store.listAgentsByStatus('starting', 'running')[0]!;
  const cwd = agent.cwd;

  assert.equal(system.agents.kill(agent.id), true);
  assert.equal(system.store.getAgent(agent.id)!.status, 'killed');
  assert.equal(
    await reissued(system, cwd, 'someone/else'),
    false,
    'held until the process the kill signalled has actually exited',
  );

  const reaped = new Promise<void>((r) => system.agents.on('reaped', () => r()));
  children[0]!.crash(143);
  await reaped;
  await tick(20);

  assert.ok(existsSync(cwd), 'a killed agent worktree must not be removed');
  assert.equal(await reissued(system, cwd, 'someone/later'), true, 'and the slot is back in the pool');
  system.store.close();
});

test('a shared-branch slot is not released while another task on the branch is active', async () => {
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

  assert.equal(await reissued(system, cwd, 'someone/else'), false, 'not yanked from an active sibling task');
  system.store.close();
});
