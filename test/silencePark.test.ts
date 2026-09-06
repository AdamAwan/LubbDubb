import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { type Spawner, type StreamChild } from '../src/agents/streamJsonSession.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

class FakeChild extends EventEmitter implements StreamChild {
  pid = 707;
  killed = false;
  writes: string[] = [];
  private out = new EventEmitter();
  stdout = { on: (ev: string, cb: (d: string) => void) => this.out.on(ev, cb) } as unknown as NodeJS.ReadableStream;
  stderr = null;
  stdin = { write: (d: string) => this.writes.push(d), end: () => {} } as unknown as NodeJS.WritableStream;
  emitLine(obj: unknown): void {
    this.out.emit('data', JSON.stringify(obj) + '\n');
  }
  override on(event: 'exit', cb: (code: number | null) => void): this {
    return super.on(event, cb);
  }
  kill(): void {
    this.killed = true;
    this.emit('exit', 143);
  }
  toolCall(name: string): void {
    this.emitLine({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu_1', name, input: {} }] },
    });
  }
  sent(): string[] {
    return this.writes.map((w) => String((JSON.parse(w) as { message: { content: string } }).message.content));
  }
  nudges(): string[] {
    return this.sent().filter((m) => m.includes('without a status sentinel'));
  }
}

function shutdown(system: { agents: { interruptAll(): void }; store: { close(): void } }): void {
  system.agents.interruptAll();
  system.store.close();
}

const WINDOW_MS = 25;
const past = (ms: number) => new Promise((r) => setTimeout(r, ms));

function streamConfig(patch: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-silence-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'stream',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    agentSilenceParkMs: WINDOW_MS,
    agentResumeAttempts: 0,
    auth: { enabled: false } as never,
    ...patch,
  });
}

async function dispatched(patch: Record<string, unknown> = {}) {
  const children: FakeChild[] = [];
  const spawner: Spawner = () => {
    const c = new FakeChild();
    children.push(c);
    return c;
  };
  const system = buildSystem(streamConfig(patch), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: spawner,
    errorMirror: () => {},
  });
  system.connector.inject({ kind: 'new_issue', number: 902, title: 'Add login' });
  await system.harness.runCycle('manual');
  const agentId = system.store.listAgentsByStatus('starting', 'running')[0]!.id;
  return { system, child: children[0]!, agentId };
}

test('an agent that says nothing at all is parked — and told, not asked', async () => {
  const { system, child, agentId } = await dispatched({ agentStallParkMs: 60_000 });

  await past(WINDOW_MS * 3);

  const [escalation] = system.store.listOpenEscalations();
  assert.ok(escalation, 'the wedge reaches you, where before it reached nobody');
  assert.match(escalation.prompt, /Went silent mid-turn/, 'the headline says what happened');
  assert.match(escalation.prompt, /no output at all/, 'and why nothing was asked of it');
  assert.equal(
    child.nudges().length,
    0,
    'a nudge is read at the end of a turn, and this agent is not going to reach one — asking spends the budget on a pipe nobody is reading',
  );
  assert.equal(system.store.getAgent(agentId)!.status, 'waiting');
  assert.deepEqual(
    system.agents.stallDeadlines().map((p) => p.agentId),
    [agentId],
    'and it counts down like any other park, because the ending is the same ending',
  );

  shutdown(system);
});

test('the countdown settles the wedge, and the settle is what reaps the process', async () => {
  const { system, child, agentId } = await dispatched({ agentStallParkMs: 1 });

  await past(WINDOW_MS * 3);
  assert.deepEqual(system.agents.completeExpiredStalls(), [agentId]);

  const agent = system.store.getAgent(agentId)!;
  assert.equal(agent.status, 'done', 'settled the way an unanswered stop is settled');
  assert.equal(system.store.getTask(agent.taskId)!.status, 'done');
  assert.ok(child.killed, 'and the wedged process goes with it — the tool call holding the worktree open is the point');
  assert.equal(system.store.listOpenEscalations().length, 0, 'the card goes with it too');

  shutdown(system);
});

test('a long step is not a wedge: anything on stdout starts the window over', async () => {
  const { system, child, agentId } = await dispatched({ agentStallParkMs: 60_000 });

  for (let i = 0; i < 3; i += 1) {
    await past(WINDOW_MS * 0.5);
    child.toolCall('Bash');
  }

  assert.equal(system.store.listOpenEscalations().length, 0, 'nobody is told anything about an agent that is working');
  assert.equal(system.store.getAgent(agentId)!.status, 'running');
  assert.equal(system.agents.stallDeadlines().length, 0);

  shutdown(system);
});

test('a parked agent that starts working again is never settled under its own hands', async () => {
  const { system, child, agentId } = await dispatched({ agentStallParkMs: WINDOW_MS });

  await past(WINDOW_MS * 3);
  const [armed] = system.agents.stallDeadlines();
  assert.ok(armed, 'parked and counting');

  child.toolCall('Bash');
  const [pushed] = system.agents.stallDeadlines();
  assert.ok(
    Date.parse(pushed!.expiresAt) > Date.parse(armed.expiresAt),
    'a tool call from a parked agent contradicts its clock, so the clock moves',
  );
  assert.deepEqual(system.agents.completeExpiredStalls(), [], 'and nothing settles an agent that is visibly working');
  assert.equal(system.store.getAgent(agentId)!.status, 'waiting', 'the card stands: it is still yours to read');

  shutdown(system);
});

test('a question the agent asked is never turned into a wedge, and 0 turns the clock off', async () => {
  const asked = await dispatched({ agentStallParkMs: 60_000 });
  assert.ok(asked.system.agents.ask(asked.agentId, { question: 'Which auth provider?' }).ok);
  await past(WINDOW_MS * 3);
  assert.equal(asked.system.store.listOpenEscalations().length, 1, 'its own question, and only that');
  assert.equal(asked.system.agents.stallDeadlines().length, 0, 'standing until somebody answers it');
  shutdown(asked.system);

  const off = await dispatched({ agentSilenceParkMs: 0, agentStallParkMs: 60_000 });
  await past(WINDOW_MS * 3);
  assert.equal(off.system.store.listOpenEscalations().length, 0, '0 restores the wedge that stands forever');
  assert.equal(off.system.store.getAgent(off.agentId)!.status, 'running');
  shutdown(off.system);
});
