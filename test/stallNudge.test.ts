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
 * The unannounced stop: a turn that ends with neither sentinel in it.
 *
 * It used to raise an escalation on the spot, and that population is dominated by
 * two things with nothing for a person to answer — an agent that finished the work
 * and narrated it instead of printing the done sentinel, and an agent that started
 * a build, a test run or a CI check and stopped as though something would wake it.
 * The operator could not tell which without reading the transcript, because the
 * card said only that the agent had stopped.
 *
 * So the agent is asked first, `agentStallNudges` times, and only a stop that
 * survives the budget is put to a human — with the agent's own last words in the
 * reason, which is the diagnosis the old sentence made you go and find.
 */

/** Fake claude stream-JSON process (same shape the other stream tests drive). */
class FakeChild extends EventEmitter implements StreamChild {
  pid = 606;
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
  /** A turn that says something and then ends with no sentinel in it. */
  stop(text: string): void {
    this.emitLine({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    this.emitLine({ type: 'result', subtype: 'success' });
  }
  /** Every message the harness has typed into this agent, prompt included. */
  sent(): string[] {
    return this.writes.map((w) => String((JSON.parse(w) as { message: { content: string } }).message.content));
  }
  nudges(): string[] {
    return this.sent().filter((m) => m.includes('without a status sentinel'));
  }
}

function streamConfig(patch: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-stall-'));
  return loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'stream',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
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
  system.connector.inject({ kind: 'new_issue', number: 901, title: 'Add login' });
  await system.harness.runCycle('manual');
  const agentId = system.store.listAgentsByStatus('starting', 'running')[0]!.id;
  return { system, child: children[0]!, agentId };
}

test('a stop is put to the agent before it is ever put to a human', async () => {
  const { system, child, agentId } = await dispatched();

  child.stop('Kicked off the test run; waiting for it to finish.');

  assert.equal(system.store.listOpenEscalations().length, 0, 'nobody is asked a question the agent can answer');
  assert.equal(child.nudges().length, 1, 'the agent is asked instead');
  assert.equal(system.store.getAgent(agentId)!.status, 'running', 'and it is still the harness working, not you');
  assert.match(
    system.store.getTranscript(agentId),
    /go and look at it yourself/,
    'the nudge is in the transcript, so the agent carrying on is not an unexplained jump',
  );

  // The commonest answer: it had finished and had not said so.
  child.emitLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'All green. @@LUBBDUBB_DONE@@' }] } });
  child.emitLine({ type: 'result', subtype: 'success' });
  assert.equal(system.store.getAgent(agentId)!.status, 'done');
  assert.equal(system.store.listOpenEscalations().length, 0, 'and it never cost you an inbox item');

  system.store.close();
});

test('a stop that survives the budget reaches the operator, quoting the agent', async () => {
  const { system, child, agentId } = await dispatched({ agentStallNudges: 2 });

  child.stop('Waiting for CI.');
  child.stop('Still waiting for CI.');
  assert.equal(child.nudges().length, 2, 'the budget is spent');
  assert.equal(system.store.listOpenEscalations().length, 0, 'and nothing has reached you yet');

  child.stop('Blocked until CI goes green on PR #412.');
  assert.equal(child.nudges().length, 2, 'the budget is a whole-life one — a third stop is not a third nudge');

  const [escalation] = system.store.listOpenEscalations();
  assert.ok(escalation, 'a stop the agent will not account for is yours after all');
  assert.match(escalation.prompt, /Stopped without finishing/, 'the headline says what happened');
  assert.match(
    escalation.prompt,
    /Blocked until CI goes green on PR #412\./,
    'and the body quotes the agent, which is the diagnosis you used to open the transcript for',
  );
  assert.equal(system.store.getAgent(agentId)!.status, 'waiting');
  assert.equal(system.store.getTask(system.store.getAgent(agentId)!.taskId)!.status, 'waiting');

  system.store.close();
});

test('nudges off restores the immediate park', async () => {
  // The operator who wants every stop in the inbox keeps it, and the reason still
  // carries the agent's last words — that half is not a policy.
  const { system, child, agentId } = await dispatched({ agentStallNudges: 0 });

  child.stop('Handing over.');

  assert.equal(child.nudges().length, 0);
  const [escalation] = system.store.listOpenEscalations();
  assert.match(escalation!.prompt, /Handing over\./);
  assert.equal(system.store.getAgent(agentId)!.status, 'waiting');

  system.store.close();
});

test('an agent parked on a question is not nudged when the turn it asked in ends', async () => {
  // `escalate` parks mid-turn and returns at once, so the turn that asked ends with
  // no sentinel in it — a stop by the letter of it, and a real question in fact.
  // Nudging here types "carry on" into an agent that is waiting on a person.
  const { system, child, agentId } = await dispatched();

  const asked = system.agents.ask(agentId, { question: 'Which auth provider?' });
  assert.ok(asked.ok);
  child.emitLine({ type: 'result', subtype: 'success' }); // the turn that asked, now ended

  assert.equal(child.nudges().length, 0, 'the park owns the agent');
  assert.equal(system.store.listOpenEscalations().length, 1, 'and its question stands alone');
  assert.equal(system.store.getAgent(agentId)!.status, 'waiting');

  system.store.close();
});
