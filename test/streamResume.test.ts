import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import type { Spawner, StreamChild } from '../src/agents/streamJsonSession.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { planAsSingle } from './support/plans.js';

/**
 * Crash recovery on the **default** runtime (issue #318).
 *
 * `test/resume.test.ts` covers the same ground for PTY; this file exists because
 * the deployment default is `stream`, and until #318 that path pinned no session
 * id at all — so the recovery desk could only ever offer requeue/remove on the
 * mode nearly every deployment actually runs.
 */

/** Fake headless `claude`: records what was written to it, replays events on demand. */
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
  /** Assistant prose mid-turn: output lands, the turn does not end, so the agent stays at work. */
  speak(text: string): void {
    this.emitLine({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  }
  /** A whole turn: prose then `result`. Ending a turn without DONE is how a stream agent parks. */
  say(text: string): void {
    this.speak(text);
    this.emitLine({ type: 'result', subtype: 'success' });
  }
  override on(event: 'exit', cb: (code: number | null) => void): this {
    return super.on(event, cb);
  }
  /**
   * Deliberately silent. A real signalled `claude` exits *later*, by which time
   * `StreamJsonSession` has already recorded the kill — a fake that exits
   * synchronously inside `kill()` is instead seen dying mid-turn, which settles
   * the task `failed` and takes the orphan out of recovery's reach. That is the
   * mid-run crash path, and it belongs to a different part of #318.
   */
  kill(): void {}
}

interface Launch {
  args: string[];
  cwd: string;
  child: FakeChild;
}

/** A spawner that records every launch, so argv and cwd can be asserted per run. */
function recordingSpawner(): { spawner: Spawner; launches: Launch[] } {
  const launches: Launch[] = [];
  const spawner: Spawner = (_command, args, opts) => {
    const child = new FakeChild();
    launches.push({ args, cwd: opts.cwd, child });
    return child;
  };
  return { spawner, launches };
}

// A file-backed db so a second buildSystem on the same path sees the first run's
// state — i.e. a real server restart, not a fresh in-memory store.
function streamConfig(dir: string): Config {
  return loadConfig({
    labelPrefix: '',
    dbPath: join(dir, 'db.sqlite'),
    agentMode: 'stream',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    // The funnel in front of pickup defaults on; this file is about the transport,
    // so pin it off and let rule `issue-pickup` dispatch directly.
    assessment: { enabled: false } as never,
    assay: { enabled: false } as never,
    retrospective: { enabled: false } as never,
  });
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'lubbdubb-stream-resume-'));
}

/** Bring up a stream-mode system, dispatch one agent, and return its live handle. */
async function spawnAgent(dir: string, issue = 901) {
  const { spawner, launches } = recordingSpawner();
  const system = buildSystem(streamConfig(dir), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: spawner,
    errorMirror: () => {},
  });
  system.connector.inject({ kind: 'new_issue', number: issue, title: 'Add login' });
  planAsSingle(system.store, issue);
  await system.harness.runCycle('manual');
  const agent = system.store.listAgentsByStatus('starting', 'running')[0]!;
  return { launches, system, agent };
}

/** A server restart: a fresh system on the same db, then boot detection. */
function reboot(dir: string) {
  const { spawner, launches } = recordingSpawner();
  const system = buildSystem(streamConfig(dir), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: spawner,
    errorMirror: () => {},
  });
  const crashed = system.recovery.detect();
  return { launches, system, crashed };
}

test('a stream agent launches with a chosen, persisted --session-id', async () => {
  const dir = tmp();
  const { launches, system, agent } = await spawnAgent(dir);

  assert.ok(agent.sessionId, 'the default runtime now owns a session id');
  const args = launches[0]!.args;
  assert.equal(args[args.indexOf('--session-id') + 1], agent.sessionId);
  assert.equal(args.includes('--resume'), false, 'a fresh launch does not resume');
  system.store.close();
});

test('a restored stream agent re-attaches to the same session in the same worktree', async () => {
  const dir = tmp();
  const { launches: l1, system: s1, agent } = await spawnAgent(dir);
  const { sessionId, cwd, id } = agent;

  // It gets some work done — mid-turn, so it is at work rather than parked, which
  // is the arm that gets the resume nudge.
  l1[0]!.child.speak('Read the router. Adding the login route now.');

  // Graceful shutdown marks the agent resumable (interrupted), not killed.
  s1.agents.interruptAll();
  assert.equal(s1.store.getAgent(id)!.status, 'interrupted');
  const before = s1.store.getTranscript(id);
  assert.ok(before.includes('Adding the login route'));
  s1.store.close();

  const { launches, system: s2, crashed } = reboot(dir);
  assert.equal(crashed.length, 1, 'the orphan is offered, not resumed');
  assert.equal(crashed[0]!.restorable, true, 'restore is on offer on the default runtime');
  assert.equal(crashed[0]!.restoreBlocked, null);
  assert.equal(launches.length, 0, 'nothing relaunches before a verdict');

  assert.equal(s2.recovery.decide(crashed[0]!.taskId, 'restore').ok, true);

  const relaunch = launches[0]!;
  assert.equal(relaunch.args[relaunch.args.indexOf('--resume') + 1], sessionId, 'resumes the original session id');
  assert.equal(relaunch.args.includes('--session-id'), false, 'does not also mint a new id');
  assert.ok(relaunch.args.includes('--append-system-prompt'), 're-applies the protocol on resume');
  assert.ok(relaunch.args.includes('-p'), 'still the headless transport');
  assert.equal(relaunch.cwd, cwd, 'resumes in the original worktree');

  // Same agent row, live again and counting toward the concurrency cap.
  assert.equal(s2.store.getAgent(id)!.status, 'running');
  assert.ok(s2.agents.isLive(id));
  assert.equal(s2.store.countLiveAgents(), 1);
  // A mid-work agent is nudged to carry on.
  assert.ok(
    relaunch.child.writes.some((w) => w.includes('Continue the task')),
    'a resumed mid-work agent is nudged to continue',
  );

  // The transcript continues rather than repeating: a resumed headless session
  // replays none of the prior conversation, so only the new turn is appended.
  relaunch.child.speak('Route added; running the tests.');
  const after = s2.store.getTranscript(id);
  assert.ok(after.startsWith(before), 'what was already there is untouched');
  assert.ok(after.includes('running the tests'), 'the new turn lands');
  assert.equal(after.split('Adding the login route').length - 1, 1, 'the pre-crash turn is not written twice');
  s2.store.close();
});

test('a crashed stream agent (row still live) is offered restore on the next boot', async () => {
  const dir = tmp();
  const { system: s1, agent } = await spawnAgent(dir);
  // Crash: no graceful shutdown. The process is gone but the row still says running.
  assert.equal(s1.store.getAgent(agent.id)!.status, 'running');
  s1.store.close();

  const { launches, system: s2, crashed } = reboot(dir);
  assert.equal(crashed[0]!.died, 'crashed');
  assert.equal(crashed[0]!.restorable, true);

  s2.recovery.decide(crashed[0]!.taskId, 'restore');
  const args = launches[0]!.args;
  assert.equal(args[args.indexOf('--resume') + 1], agent.sessionId);
  assert.equal(s2.store.getAgent(agent.id)!.status, 'running');
  s2.store.close();
});

test('a parked stream agent is restored still parked, and its escalation is answerable', async () => {
  const dir = tmp();
  const { launches: l1, system: s1, agent } = await spawnAgent(dir);

  // The agent parks on a question -> one open escalation.
  l1[0]!.child.say('@@LUBBDUBB_WAITING:Which database should I use?@@');
  assert.equal(s1.store.getAgent(agent.id)!.status, 'waiting');
  assert.equal(s1.store.listOpenEscalations().length, 1);

  s1.agents.interruptAll();
  s1.store.close();

  const { launches, system: s2, crashed } = reboot(dir);
  assert.equal(crashed[0]!.waitingReason, 'Which database should I use?', 'the park is carried onto the card');
  assert.equal(s2.recovery.decide(crashed[0]!.taskId, 'restore').ok, true);

  // Restored to waiting, with the same still-open escalation.
  assert.equal(s2.store.getAgent(agent.id)!.status, 'waiting');
  const open = s2.store.listOpenEscalations();
  assert.equal(open.length, 1, 'the escalation is restored, not duplicated');
  assert.equal(open[0]!.agentId, agent.id);
  // A parked agent must NOT be nudged — it is waiting on a human, not mid-work.
  const child = launches[0]!.child;
  assert.ok(!child.writes.some((w) => w.includes('Continue the task')));

  // Answering now routes straight into the resumed live session.
  const answered = s2.escalations.answer(open[0]!.id, 'Postgres');
  assert.equal(answered.routing, 'typed_into_agent');
  assert.match(child.writes.at(-1)!, /Postgres/);
  assert.equal(s2.store.getAgent(agent.id)!.status, 'running');
  s2.store.close();
});
