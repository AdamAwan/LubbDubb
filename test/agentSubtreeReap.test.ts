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

interface Reap {
  pid: number;
  childAlreadyKilled: boolean;
}

function testConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-reap-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    ...overrides,
  });
}

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

  system.agents.interruptAll();

  assert.equal(reaps.length, live.length, 'every live agent had its subtree reaped');
  assert.deepEqual(
    [...reaps].sort(),
    backend.spawned.slice(0, live.length).map((s) => s.proc.pid),
    'each by its own pid',
  );
  system.store.close();
});
