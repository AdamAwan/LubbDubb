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

/**
 * The wedge: an agent that stops *inside* a turn rather than at the end of one.
 *
 * Every ending the stream runtime reads — done, waiting, the unannounced stop — is
 * read off a turn boundary, and an agent whose tool call never returns reaches no
 * boundary. It emits no `result`, so it emits no stop, so no nudge is sent and no
 * countdown is armed: it holds a worktree lease and a slot against the cap until a
 * person notices. Nothing is red the whole time, because an agent wedged and an
 * agent thinking look identical from outside.
 *
 * So the wall clock is the observation, and it is the only one there is.
 */

/** Fake claude stream-JSON process (same shape the other stream tests drive). */
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
  /** The agent doing something, as opposed to saying something. */
  toolCall(name: string): void {
    this.emitLine({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu_1', name, input: {} }] },
    });
  }
  /** Every message the harness has typed into this agent, prompt included. */
  sent(): string[] {
    return this.writes.map((w) => String((JSON.parse(w) as { message: { content: string } }).message.content));
  }
  nudges(): string[] {
    return this.sent().filter((m) => m.includes('without a status sentinel'));
  }
}

/**
 * Shut a test's system down the way the server does. Not a formality: a live
 * agent's silence window is a real timer, and a store closed out from under one
 * still armed is a write into a closed database once it fires.
 */
function shutdown(system: { agents: { interruptAll(): void }; store: { close(): void } }): void {
  system.agents.interruptAll();
  system.store.close();
}

/** Short enough to run a test against, and the shape of the real thing. */
const WINDOW_MS = 25;
const past = (ms: number) => new Promise((r) => setTimeout(r, ms));

function streamConfig(patch: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-silence-'));
  return loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'stream',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    agentSilenceParkMs: WINDOW_MS,
    // Off, or the teardown below resurrects the agent it just killed: a fake child
    // reports a non-zero exit, which is a mid-run crash to re-attach to. Crash
    // recovery has its own tests; here it would only spawn a second session with a
    // second window on it.
    agentResumeAttempts: 0,
    auth: { enabled: false } as never,
    ...patch,
  });
}

/** Boot a stream-mode system with one dispatched agent, mid-turn. */
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

  // Three windows' worth of work, speaking once per window — which is what a slow
  // install or a full test run looks like, and must never be read as silence.
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
  // The reason the clock carries a grace as well as a deadline. The wedge that comes
  // back is rare and the cost of settling it mid-turn is a thrown-away turn, so the
  // deadline moves for the agent as well as for the operator.
  const { system, child, agentId } = await dispatched({ agentStallParkMs: WINDOW_MS });

  await past(WINDOW_MS * 3);
  const [armed] = system.agents.stallDeadlines();
  assert.ok(armed, 'parked and counting');

  child.toolCall('Bash'); // ...and then it comes back
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
  // The exclusion is the same one the stop's countdown has, for the same reason: an
  // agent waiting on a person is *supposed* to be silent, and a park that settles
  // itself after a window is worse than no question at all.
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
