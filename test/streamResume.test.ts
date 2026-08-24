import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import type { Spawner, StreamChild } from '../src/agents/streamJsonSession.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { Store } from '../src/store/store.js';
import { AgentManager } from '../src/agents/agentManager.js';
import type { AgentSession, AgentSessionStatus } from '../src/agents/session.js';
import { FileEventsSpool } from '../src/agents/fileEvents.js';
import { failPlanningOpen } from './support/plans.js';

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
  /** The process dies mid-run with nobody having asked it to — the crash path. */
  crash(code = 137): void {
    this.emit('exit', code);
  }
  /**
   * Deliberately silent. A real signalled `claude` exits *later*, by which time
   * `StreamJsonSession` has already recorded the kill — a fake that exits
   * synchronously inside `kill()` is instead seen dying mid-turn, which settles
   * the task `failed` and takes the orphan out of recovery's reach. Use
   * {@link crash} when that is what the test is about.
   */
  kill(): void {}
}

/** A session that does nothing but let a test drive its events. */
class FakeSession extends EventEmitter implements AgentSession {
  status: AgentSessionStatus = 'starting';
  pid: number | null = 42;
  start(): void {}
  send(): void {}
  sendRaw(): void {}
  kill(): void {}
  /** The runtime contract for a crash: the exit code lands before the terminal. */
  die(code = 137): void {
    this.emit('exit', code);
    this.emit('failed');
  }
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
function streamConfig(dir: string, extra: Partial<Config> = {}): Config {
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    ...extra,
    labelPrefix: '',
    dbPath: join(dir, 'db.sqlite'),
    agentMode: 'stream',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    // The funnel in front of pickup defaults on; this file is about the transport,
    // so pin it off and let rule `issue-pickup` dispatch directly.
  });
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'lubbdubb-stream-resume-'));
}

/** Bring up a stream-mode system, dispatch one agent, and return its live handle. */
async function spawnAgent(dir: string, issue = 901, extra: Partial<Config> = {}) {
  const { spawner, launches } = recordingSpawner();
  const system = buildSystem(streamConfig(dir, extra), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: spawner,
    errorMirror: () => {},
  });
  system.connector.inject({ kind: 'new_issue', number: issue, title: 'Add login' });
  failPlanningOpen(system.store, issue);
  await system.harness.runCycle('manual');
  const agent = system.store.listAgentsByStatus('starting', 'running')[0]!;
  return { launches, system, agent };
}

/** A server restart: a fresh system on the same db, then boot detection. */
function reboot(dir: string, extra: Partial<Config> = {}) {
  const { spawner, launches } = recordingSpawner();
  const system = buildSystem(streamConfig(dir, extra), {
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

// -- A crash while the harness is up (issue #318, phase 2) -------------------
//
// The tests above are about a crash the *harness* did not outlive. These are the
// other half: the harness is up, watching, and the agent's own process dies. That
// used to settle the row and the task `failed`, throwing away a conversation
// `--resume` can re-open in the same worktree. Now it is re-attached, bounded by
// `agentResumeAttempts`, and only the death past the bound is a failure.

test('an agent whose process dies mid-run is re-attached to the same session', async () => {
  const dir = tmp();
  const { launches, system, agent } = await spawnAgent(dir);
  const eventsDir = system.agents.fileEventsDir(agent.id);

  launches[0]!.child.speak('Read the router. Adding the login route now.');
  launches[0]!.child.crash();

  // Same row, live again — not settled, and not a new agent.
  assert.equal(system.store.listAgents().length, 1, 'the crash does not mint a second agent row');
  const after = system.store.getAgent(agent.id)!;
  assert.equal(after.status, 'running');
  assert.equal(after.sessionId, agent.sessionId, 'the same conversation, not a new one');
  assert.equal(after.endedAt, null);
  assert.equal(after.resumeAttempts, 1, 'the death is counted against the budget');
  assert.ok(system.agents.isLive(agent.id));
  assert.equal(system.store.getTask(agent.taskId)!.status, 'running', 'the task is not settled');
  assert.deepEqual(system.store.listErrors(), [], 'a recovered crash is not an error the operator must read');

  // Relaunched onto its own transcript, in its own worktree, and nudged on.
  const relaunch = launches[1]!;
  assert.equal(relaunch.args[relaunch.args.indexOf('--resume') + 1], agent.sessionId);
  assert.equal(relaunch.args.includes('--session-id'), false, 'never both flags on one launch');
  assert.equal(relaunch.cwd, agent.cwd);
  assert.ok(relaunch.child.writes.some((w) => w.includes('Continue the task')));

  // The dead launch's spool is disposed rather than written over: the resumed
  // session drains a fresh dir, and the old one is not left behind.
  assert.notEqual(system.agents.fileEventsDir(agent.id), eventsDir);

  // And the transcript is one conversation, continued.
  relaunch.child.speak('Route added; running the tests.');
  const transcript = system.store.getTranscript(agent.id);
  assert.ok(transcript.includes('Adding the login route') && transcript.includes('running the tests'));
  system.store.close();
});

test('an agent that crashes past agentResumeAttempts fails, naming how many resumes were tried', async () => {
  const dir = tmp();
  const { launches, system, agent } = await spawnAgent(dir, 902, { agentResumeAttempts: 2 });

  // Two deaths are absorbed...
  launches[0]!.child.crash();
  assert.equal(system.store.getAgent(agent.id)!.status, 'running');
  launches[1]!.child.crash();
  assert.equal(system.store.getAgent(agent.id)!.status, 'running');
  assert.equal(system.store.getAgent(agent.id)!.resumeAttempts, 2);
  assert.equal(launches.length, 3, 'one launch, then one per resume');

  // ...the third is not.
  launches[2]!.child.crash();
  const dead = system.store.getAgent(agent.id)!;
  assert.equal(dead.status, 'failed');
  assert.notEqual(dead.endedAt, null);
  assert.equal(system.agents.isLive(agent.id), false);
  assert.equal(system.store.getTask(agent.taskId)!.status, 'failed');
  assert.equal(launches.length, 3, 'and nothing relaunches past the bound');

  // Exactly one error, and it says the loop was a loop.
  const errors = system.store.listErrors().filter((e) => e.message.includes(agent.id));
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /failed .*after 2 automatic resumes/);
  system.store.close();
});

test('the resume budget is read off the row, so a harness restart does not refill it', async () => {
  const dir = tmp();
  const { launches: l1, system: s1, agent } = await spawnAgent(dir, 903, { agentResumeAttempts: 1 });

  l1[0]!.child.crash();
  assert.equal(s1.store.getAgent(agent.id)!.resumeAttempts, 1, 'the budget is spent');
  s1.agents.interruptAll();
  s1.store.close();

  // A whole new process against the same file-backed db: nothing is in memory.
  const { launches, system: s2, crashed } = reboot(dir, { agentResumeAttempts: 1 });
  assert.equal(s2.store.getAgent(agent.id)!.resumeAttempts, 1, 'the count survived the restart');
  assert.equal(s2.recovery.decide(crashed[0]!.taskId, 'restore').ok, true);

  // An operator's `restore` is their call and spends nothing — but the crash budget
  // it comes back with is the one it left with, so the next death is terminal.
  launches[0]!.child.crash();
  assert.equal(s2.store.getAgent(agent.id)!.status, 'failed');
  assert.equal(launches.length, 1, 'no automatic resume: the budget was spent before the restart');
  s2.store.close();
});

test('agentResumeAttempts 0 keeps a mid-run crash terminal', async () => {
  const dir = tmp();
  const { launches, system, agent } = await spawnAgent(dir, 904, { agentResumeAttempts: 0 });

  launches[0]!.child.crash();
  assert.equal(system.store.getAgent(agent.id)!.status, 'failed');
  assert.equal(launches.length, 1);
  const errors = system.store.listErrors().filter((e) => e.message.includes(agent.id));
  assert.equal(errors.length, 1);
  assert.doesNotMatch(errors[0]!.message, /automatic resume/, 'nothing was tried, so nothing is claimed');
  system.store.close();
});

test('a cockpit kill and a clean done stay terminal, whatever the budget says', async () => {
  const dir = tmp();
  const { launches, system, agent } = await spawnAgent(dir, 905);

  // A killed agent's process exits *after* the kill. That exit must not resurrect it.
  assert.equal(system.agents.kill(agent.id), true);
  launches[0]!.child.crash();
  assert.equal(system.store.getAgent(agent.id)!.status, 'killed');
  assert.equal(system.store.getAgent(agent.id)!.resumeAttempts, 0);
  assert.equal(launches.length, 1, 'a decided ending is not re-opened');

  // And a clean finish is a clean finish.
  const { launches: l2, system: s2, agent: a2 } = await spawnAgent(tmp(), 906);
  l2[0]!.child.say('All done. @@LUBBDUBB_DONE@@');
  assert.equal(s2.store.getAgent(a2.id)!.status, 'done');
  assert.equal(l2.length, 1);
  system.store.close();
  s2.store.close();
});

/**
 * The teardown a mid-run resume must do, at the seam where it is observable.
 *
 * `AgentManager.resume` was written for boot, where its in-memory maps are empty:
 * it `set`s the spool key and the MCP token rather than replacing them. Called
 * mid-run without dropping what the dead process held, it leaks a spool directory
 * and — the one that matters — leaves a bearer credential bound and live with
 * nothing left to revoke it. Everything compiles and the agent visibly comes back,
 * which is why this is asserted rather than reasoned about.
 */
test('a mid-run resume revokes the dead launch credential and drops its spool', () => {
  const store = new Store(':memory:');
  const opened: string[] = [];
  const released: string[] = [];
  const sessions: FakeSession[] = [];
  const spool = new FileEventsSpool(join(tmp(), 'events'));
  const agents = new AgentManager(store, {
    command: 'claude',
    buildArgs: () => [],
    whitelistedApprovals: [],
    createSession: () => {
      const s = new FakeSession();
      sessions.push(s);
      return s;
    },
    resumable: true,
    resumeAttempts: 1,
    fileEvents: spool,
    mcp: {
      open: () => {
        const token = `tok${opened.length}`;
        opened.push(token);
        return { token, configPath: null };
      },
      bind: () => {},
      release: (token: string) => released.push(token),
    },
  });

  const task = store.createTask({ kind: 'code', title: 't', prompt: 'p', branch: 'b', originRef: null });
  const agent = agents.spawn(task, tmpdir()); // an existing cwd: a resume needs its worktree
  const firstSpool = agents.fileEventsDir(agent.id);

  sessions[0]!.die();

  assert.equal(store.getAgent(agent.id)!.status, 'running', 're-attached rather than settled');
  assert.deepEqual(opened, ['tok0', 'tok1'], 'the resume mints its own credential');
  assert.deepEqual(released, ['tok0'], "the dead launch's credential is revoked, not written over");
  assert.equal(existsSync(firstSpool!), false, 'and its spool dir is disposed, not orphaned');
  assert.notEqual(agents.fileEventsDir(agent.id), firstSpool);

  // The budget is spent, so the next death settles — and takes both down with it.
  const secondSpool = agents.fileEventsDir(agent.id);
  sessions[1]!.die();
  assert.equal(store.getAgent(agent.id)!.status, 'failed');
  assert.deepEqual(released, ['tok0', 'tok1']);
  assert.equal(existsSync(secondSpool!), false);
  store.close();
});
