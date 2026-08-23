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
  /** The reading `claude` emits when the five-hour window is spent. */
  rateLimit(): void {
    this.emitLine({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'rejected',
        resetsAt: Math.floor((Date.now() + 3_600_000) / 1000),
        rateLimitType: 'five_hour',
        overageStatus: 'allowed',
        isUsingOverage: false,
      },
      uuid: '9d2e1c4a-0000-4000-8000-00000000fead',
      session_id: 'f0e1d2c3-0000-4000-8000-00000000beef',
    });
    this.emitLine({ type: 'result', subtype: 'error_during_execution', is_error: true });
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
    /check it now, then keep going/,
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

/**
 * And what happens to the item the park leaves behind.
 *
 * The stop that survives the nudges is still, overwhelmingly, an agent that
 * finished and did not say so — the operator's own answer to nearly every one of
 * these cards is "Mark work done". So the card is filed with a countdown on it and
 * the harness makes that click itself if nobody makes it: five minutes is the
 * window to disagree, not the harness's confidence. Nothing it does is
 * irrecoverable — the branch, the commits and the pull request are kept, and the
 * worktree slot goes back to the fleet rather than the checkout being deleted.
 */

test('a stop nobody answers settles itself as done, and says so in the audit', async () => {
  const { system, child, agentId } = await dispatched({ agentStallNudges: 0, agentStallParkMs: 1 });

  child.stop('Pushed 6b4b9c7; the build is green and there are no threads left.');
  const [escalation] = system.store.listOpenEscalations();
  assert.ok(escalation, 'the item is still filed — you get to see it and to disagree');
  assert.equal(system.store.getAgent(agentId)!.status, 'waiting');
  assert.deepEqual(
    system.agents.stallDeadlines().map((p) => p.agentId),
    [agentId],
    'and it is counting down, which is what the card draws',
  );

  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(system.agents.completeExpiredStalls(), [agentId]);

  const agent = system.store.getAgent(agentId)!;
  assert.equal(agent.status, 'done', 'the click you were going to make, made for you');
  assert.equal(system.store.getTask(agent.taskId)!.status, 'done');
  assert.equal(system.store.listOpenEscalations().length, 0, 'and the card goes with it');
  assert.equal(system.agents.stallDeadlines().length, 0);

  const decision = system.store.listDecisions().find((d) => d.cycleId === `stall:${agentId}`);
  assert.ok(decision, 'recorded under its own cycle id: who ended the run is a question the log answers');
  assert.match(decision.action.reason ?? '', /unannounced stop stood unanswered/);

  system.store.close();
});

test('extending buys time, and only for a park that is actually counting', async () => {
  const { system, child, agentId } = await dispatched({
    agentStallNudges: 0,
    agentStallParkMs: 1,
    agentStallExtendMs: 900_000,
  });

  child.stop('Handing over.');
  const extended = system.agents.extendStallPark(agentId);
  assert.ok(extended.ok && Date.parse(extended.expiresAt) > Date.now() + 800_000);

  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(system.agents.completeExpiredStalls(), [], 'the countdown is the operator’s to hold');
  assert.equal(system.store.getAgent(agentId)!.status, 'waiting', 'so the agent is still theirs to answer');

  const other = system.agents.extendStallPark('agent_nobody');
  assert.equal(other.ok, false, 'a park with no clock refuses rather than reporting time bought on nothing');

  system.store.close();
});

test('a question the agent asked never expires, and neither does a stop when the window is off', async () => {
  // The two exclusions, together because they are one rule: only a stop the harness
  // could not get an account of counts down. A question a person is genuinely
  // blocked on, answering itself after five minutes, is worse than no question.
  const parked = await dispatched({ agentStallParkMs: 60_000 });
  const asked = parked.system.agents.ask(parked.agentId, { question: 'Which auth provider?' });
  assert.ok(asked.ok);
  parked.child.emitLine({ type: 'result', subtype: 'success' }); // the turn that asked, ended
  assert.equal(parked.system.agents.stallDeadlines().length, 0, 'a real question stands until it is answered');
  parked.system.store.close();

  const off = await dispatched({ agentStallNudges: 0, agentStallParkMs: 0 });
  off.child.stop('Handing over.');
  assert.equal(off.system.store.listOpenEscalations().length, 1);
  assert.equal(off.system.agents.stallDeadlines().length, 0, '0 restores the park that stands forever');
  off.system.store.close();
});

test('the account running out takes the stop’s clock with it, whichever arrived first', async () => {
  // The order the arm-time guard cannot see: the stop parks and arms the countdown,
  // and the limit lands *after* it. `handleStalled` checked `limited` and found
  // nothing, because there was nothing yet.
  const { system, child, agentId } = await dispatched({ agentStallNudges: 0, agentStallParkMs: 1 });

  child.stop('Halfway through the migration.');
  assert.equal(system.agents.stallDeadlines().length, 1, 'armed by the stop');

  child.rateLimit();
  assert.deepEqual(system.agents.limitedAgentIds(), [agentId], 'and then the account ran out');
  assert.equal(system.agents.stallDeadlines().length, 0, 'the limit’s ending is the one that holds');

  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(system.agents.completeExpiredStalls(), [], 'so nothing settles it');
  assert.equal(system.store.getAgent(agentId)!.status, 'waiting', 'the conversation is still there to continue');
  assert.deepEqual(system.agents.limitedAgentIds(), [agentId], 'with the park that has its own ending intact');

  system.store.close();
});

test('a park the harness resumed takes its clock with it: a working agent is never settled', async () => {
  const { system, child, agentId } = await dispatched({ agentStallNudges: 0, agentStallParkMs: 1 });

  child.stop('Halfway through the migration.');
  child.rateLimit();
  assert.ok(system.agents.resumeParked(agentId).ok, 'the window turned over');

  assert.equal(system.store.getAgent(agentId)!.status, 'running', 'the agent is back at work');
  assert.equal(system.agents.stallDeadlines().length, 0, 'and no clock is left running over it');

  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(system.agents.completeExpiredStalls(), [], 'so the countdown kills nothing mid-turn');
  assert.equal(system.store.getAgent(agentId)!.status, 'running');

  system.store.close();
});
