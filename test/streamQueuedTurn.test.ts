import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { StreamJsonSession, type Spawner, type StreamChild } from '../src/agents/streamJsonSession.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

/**
 * A `result` event is the end of *a* turn, not of the session — and the two come
 * apart whenever a message is sent into a turn that is still running.
 *
 * The `escalate` tool is what makes that ordinary rather than exotic: it parks the
 * agent mid-turn and returns at once, so an answer (a human's, or a whitelist
 * rule's) routinely lands before the interrupted turn has ended. Reading that
 * turn's `result` as an unannounced stop parked an agent that was already working
 * on the answer, and filed "Agent ended its turn without finishing" against it.
 */

/** Fake claude stream-JSON process (same shape the other stream tests drive). */
class FakeChild extends EventEmitter implements StreamChild {
  pid = 555;
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
    this.emit('exit', 143);
  }
}

function streamConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-queued-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'stream',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    auth: { enabled: false } as never,
  });
}

/** Boot a stream-mode system with one dispatched agent, mid-turn. */
async function dispatched() {
  const children: FakeChild[] = [];
  const spawner: Spawner = () => {
    const c = new FakeChild();
    children.push(c);
    return c;
  };
  const system = buildSystem(streamConfig(), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: spawner,
    errorMirror: () => {},
  });
  system.connector.inject({ kind: 'new_issue', number: 901, title: 'Add login' });
  await system.harness.runCycle('manual');
  const agentId = system.store.listAgentsByStatus('starting', 'running')[0]!.id;
  return { system, child: children[0]!, agentId };
}

test('answering a mid-turn park does not park the agent again when the interrupted turn ends', async () => {
  const { system, child, agentId } = await dispatched();

  // The agent asks through `escalate` — which returns at once, so the turn that
  // asked is still running.
  const asked = system.agents.ask(agentId, { question: 'Which auth provider?' });
  assert.ok(asked.ok && asked.escalationId);
  const escalation = system.store.listOpenEscalations()[0]!;

  // The human answers before that turn has ended. `claude` queues the answer and
  // runs it as the next turn.
  system.escalations.answer(escalation.id, 'Azure AD');
  assert.equal(system.store.getAgent(agentId)!.status, 'running');

  // The interrupted turn ends. It carries no sentinel because the agent was cut off
  // mid-thought, and it is *not* the session coming to rest.
  child.emitLine({ type: 'result', subtype: 'success' });
  assert.deepEqual(
    system.store.listOpenEscalations().map((e) => e.prompt),
    [],
    'a queued answer means the agent is working, not waiting',
  );
  assert.equal(system.store.getAgent(agentId)!.status, 'running');

  // It works through the answer and finishes for real.
  child.emitLine({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Wired up Azure AD. @@LUBBDUBB_DONE@@' }] },
  });
  child.emitLine({ type: 'result', subtype: 'success' });
  assert.equal(system.store.getAgent(agentId)!.status, 'done');

  system.store.close();
});

test('the turn behind a queued message is still judged on its own text', () => {
  // The queued turn is skipped, not swallowed: the one that comes to rest is read
  // for sentinels as it always was, and reads only its own text.
  const child = new FakeChild();
  const session = new StreamJsonSession(
    { command: 'claude', args: [], cwd: '/tmp', env: {} },
    () => child as StreamChild,
  );
  const waits: string[] = [];
  // A turn ending with no sentinel is reported as a stall rather than a park, so
  // that is the event this test's second half counts (see `stall`).
  session.on('waiting', (reason) => waits.push(reason));
  const stalls: string[] = [];
  session.on('stalled', (lastWords: string) => stalls.push(lastWords));
  session.start();

  session.send('go'); // turn 1
  child.emitLine({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '@@LUBBDUBB_WAITING:Which provider?@@' }] },
  });
  session.send('Azure AD'); // queued into turn 1, so turn 1's sentinel is spent
  child.emitLine({ type: 'result', subtype: 'success' }); // turn 1 ends
  assert.deepEqual(waits, [], 'the interrupted turn is not judged');
  assert.deepEqual(stalls, [], 'and it is not read as a stop either');
  assert.equal(session.status, 'running');

  // Turn 2 ends with nothing, and that *is* a park — read off turn 2's own text,
  // not turn 1's leftovers.
  child.emitLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hmm.' }] } });
  child.emitLine({ type: 'result', subtype: 'success' });
  assert.deepEqual(waits, [], "turn 1's sentinel is spent, so nothing reads as a question");
  assert.deepEqual(stalls, ['Hmm.'], "and the stop is judged on turn 2's own text");
  assert.equal(session.status, 'waiting');
});

/**
 * The queued-turn rule above skips a turn's *question*, and that is right: the
 * message queued behind it is usually the answer, so re-parking on it would ask
 * again. A **done** is not that. Nothing anyone types afterwards makes "I finished"
 * untrue, and a done honoured only when the queue happened to be empty is one lost
 * to a race — the agent announces it, the harness hears nothing, and the session it
 * should have torn down sits holding a worktree lease, looking exactly like an
 * agent that stopped without saying why.
 */
test('a done printed before a message landed mid-turn is still a finish', () => {
  const child = new FakeChild();
  const session = new StreamJsonSession(
    { command: 'claude', args: [], cwd: '/tmp', env: {} },
    () => child as StreamChild,
  );
  const stalls: string[] = [];
  session.on('stalled', (lastWords: string) => stalls.push(lastWords));
  session.start();

  session.send('go');
  child.emitLine({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Pushed, CI green. @@LUBBDUBB_DONE@@' }] },
  });
  // An operator reads the transcript and types into the turn that just announced it.
  session.send("did you forget to tell LubbDubb you're done?");
  child.emitLine({ type: 'result', subtype: 'success' });

  assert.equal(session.status, 'done', 'the announcement survives the message that raced it');
  assert.deepEqual(stalls, [], 'and it is never read as an unannounced stop');
});
