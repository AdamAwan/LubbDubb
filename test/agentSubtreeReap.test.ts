import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { Spawner, StreamChild } from '../src/agents/streamJsonSession.js';

/**
 * An agent's children outlive the agent unless something takes the subtree down.
 * The failure this covers is silent and expensive: a shell an agent started with
 * the Bash tool keeps the worktree as its cwd, Windows refuses `rmdir` on a live
 * process's cwd, and every later dispatch onto that branch fails `EBUSY` in
 * `WorktreeManager.reclaim` — indefinitely, ~45s apart, with nothing but rejected
 * dispatches in the log to say why.
 *
 * Both runtimes are exercised, because `agentMode` defaults to `stream` and the
 * PTY runtime is the one with terminal semantics — a fix that only understood
 * terminals would cover neither the default nor the whole fleet.
 *
 * The reaper is **injected**, and that is not only for observation: the real one
 * signals whatever pid it is handed, and these tests' transports are fakes whose
 * pids name unrelated processes on the host running the suite.
 */

/** Every pid a kill asked to be reaped, with what had already happened to the process. */
interface Reap {
  pid: number;
  /** Whether the direct child had been signalled by the time the reap ran. */
  childAlreadyKilled: boolean;
}

function testConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-reap-'));
  return loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    ...overrides,
  });
}

/** Minimal fake claude stream-JSON process (same shape as usage.test.ts's). */
class FakeChild extends EventEmitter implements StreamChild {
  pid = 4242;
  killed = false;
  private out = new EventEmitter();
  stdout = { on: (ev: string, cb: (d: string) => void) => this.out.on(ev, cb) } as unknown as NodeJS.ReadableStream;
  stderr = null;
  stdin = { write: () => {}, end: () => {} } as unknown as NodeJS.WritableStream;
  override on(event: 'exit', cb: (code: number | null) => void): this {
    return super.on(event, cb);
  }
  kill(): void {
    this.killed = true;
    this.emit('exit', 143);
  }
}

/** Dispatch one code agent and hand back its id. */
async function dispatch(system: System, issueNumber: number): Promise<string> {
  system.connector.inject({ kind: 'new_issue', number: issueNumber, title: 'Add login' });
  await system.harness.runCycle('manual');
  const agent = system.store.listAgentsByStatus('starting', 'running')[0];
  assert.ok(agent, 'a code agent was dispatched');
  return agent.id;
}

test('stream mode: killing an agent reaps its process subtree, not just the direct child', async () => {
  const reaps: Reap[] = [];
  const children: FakeChild[] = [];
  const spawner: Spawner = () => {
    const c = new FakeChild();
    children.push(c);
    return c;
  };
  const system = buildSystem(testConfig({ agentMode: 'stream' }), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: spawner,
    reapProcessTree: (pid) => reaps.push({ pid, childAlreadyKilled: children.some((c) => c.killed) }),
    errorMirror: () => {},
  });

  const agentId = await dispatch(system, 901);
  const child = children[0]!;
  assert.equal(reaps.length, 0, 'nothing is reaped while the agent is working');

  system.agents.kill(agentId);

  assert.deepEqual(
    reaps.map((r) => r.pid),
    [child.pid],
    'the kill reaps the subtree rooted at the agent process',
  );
  // Ordering is the load-bearing half: both mechanisms (taskkill /T, kill(-pgid))
  // resolve descendants *through* the root, so a root that has already been
  // signalled can leave children that are no longer reachable from here.
  assert.equal(reaps[0]!.childAlreadyKilled, false, 'the subtree is reaped before the root is signalled');
  assert.equal(child.killed, true, 'and the root is still signalled afterwards');
  system.store.close();
});

test('pty mode: killing an agent reaps its process subtree too', async () => {
  const reaps: Reap[] = [];
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig({ agentMode: 'raw' }), {
    worktrees: new FakeWorktreeManager(),
    backend,
    reapProcessTree: (pid) => reaps.push({ pid, childAlreadyKilled: backend.last().killed }),
    errorMirror: () => {},
  });

  const agentId = await dispatch(system, 902);
  const proc = backend.last();

  system.agents.kill(agentId);

  assert.deepEqual(
    reaps.map((r) => r.pid),
    [proc.pid],
    'the terminal runtime reaps the subtree as well — a Bash-tool shell survives either transport',
  );
  assert.equal(reaps[0]!.childAlreadyKilled, false, 'reaped before the pty process is signalled');
  system.store.close();
});

test('a shutdown interrupt reaps every live agent subtree', async () => {
  const reaps: number[] = [];
  const backend = new FakePtyBackend();
  const system = buildSystem(testConfig({ agentMode: 'raw', maxConcurrentAgents: 3 }), {
    worktrees: new FakeWorktreeManager(),
    backend,
    reapProcessTree: (pid) => reaps.push(pid),
    errorMirror: () => {},
  });

  system.connector.inject({ kind: 'new_issue', number: 903, title: 'Add login' });
  system.connector.inject({ kind: 'new_issue', number: 904, title: 'Add logout' });
  await system.harness.runCycle('manual');
  const live = system.store.listAgentsByStatus('starting', 'running');
  assert.ok(live.length >= 2, 'two agents are up');

  // Server shutdown. The agents are left resumable, but their children must not
  // be: this is the exact path the two-day wedge came down — a task interrupted,
  // the agent gone, its shell still sitting in the worktree.
  system.agents.interruptAll();

  assert.equal(reaps.length, live.length, 'every live agent had its subtree reaped');
  assert.deepEqual(
    [...reaps].sort(),
    backend.spawned.slice(0, live.length).map((s) => s.proc.pid),
    'each by its own pid',
  );
  system.store.close();
});
