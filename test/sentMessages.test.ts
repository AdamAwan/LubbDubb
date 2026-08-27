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
import { PtySession } from '../src/pty/ptySession.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';

/**
 * A message *sent to* an agent belongs in that agent's transcript.
 *
 * The stream runtime — the default — renders only what comes back, so an answer
 * typed into the drawer used to leave no trace whatsoever: the pane sat unchanged,
 * the cockpit deliberately does not refetch after an answer, and the only evidence
 * the message went anywhere was the agent eventually replying to a question the
 * transcript never showed. That reads as a feature that does not work.
 */

/** Fake claude stream-JSON process (same shape the other stream tests drive). */
class FakeChild extends EventEmitter implements StreamChild {
  pid = 707;
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
}

function streamConfig(patch: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-sent-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
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
  system.connector.inject({ kind: 'new_issue', number: 902, title: 'Add login' });
  await system.harness.runCycle('manual');
  const agentId = system.store.listAgentsByStatus('starting', 'running')[0]!.id;
  return { system, child: children[0]!, agentId };
}

test('an answer typed into an agent appears in its transcript', async () => {
  const { system, child, agentId } = await dispatched();

  const asked = system.agents.ask(agentId, { question: 'Which auth provider?' });
  assert.ok(asked.ok);

  const live: string[] = [];
  system.agents.on('output', ({ agentId: id, delta }) => {
    if (id === agentId) live.push(delta);
  });

  assert.equal(system.agents.respond(agentId, 'Use OAuth, and keep the sessions short.'), true);

  const transcript = system.store.getTranscript(agentId);
  assert.match(transcript, /Use OAuth, and keep the sessions short\./, 'the message you sent is in the transcript');
  assert.match(transcript, /▸ sent/, 'labelled as a turn you took, not as something the agent said');
  assert.ok(
    live.some((d) => d.includes('Use OAuth')),
    'and it goes out live, so the open drawer shows it without a refetch',
  );
  assert.ok(
    child.writes.some((w) => w.includes('Use OAuth')),
    'the agent got it too — the echo is a copy, never a substitute',
  );

  system.store.close();
});

test('the transcript never shows a message that was not delivered', async () => {
  const { system, agentId } = await dispatched();

  system.agents.kill(agentId);
  const before = system.store.getTranscript(agentId);
  assert.equal(system.agents.respond(agentId, 'Are you there?'), false);
  assert.equal(system.store.getTranscript(agentId), before, 'nothing to send it to, so nothing is claimed');

  system.store.close();
});

test('ending a usage-limit park says so in the transcript', async () => {
  const { system, child, agentId } = await dispatched();

  child.rateLimit();
  assert.equal(system.store.getAgent(agentId)!.status, 'waiting');

  const resumed = system.agents.resumeParked(agentId);
  assert.ok(resumed.ok, 'the park ends');
  assert.match(
    system.store.getTranscript(agentId),
    /The limit has cleared/,
    'and the agent picking the work back up is not an unexplained jump',
  );

  system.store.close();
});

test('the terminal runtime carries its own sent messages, so the manager must not echo them', () => {
  // A terminal echoes what is typed into it, and that echo *is* the transcript —
  // a manager-side echo on top of it would double every message.
  const session = new PtySession(new FakePtyBackend(), { command: 'x', args: [], cwd: '/tmp', submitDelayMs: 0 });
  assert.equal(session.recordsSentMessages, true);
});
