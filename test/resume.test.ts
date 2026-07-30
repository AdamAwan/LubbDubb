import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

// A file-backed db so a second buildSystem on the same path sees the first run's
// state — i.e. a real server restart, not a fresh in-memory store.
function ptyConfig(dir: string): Config {
  return loadConfig({
    labelPrefix: '',
    dbPath: join(dir, 'db.sqlite'),
    dispatcher: 'rule',
    agentMode: 'pty',
    agentPromptDelayMs: 0, // deliver synchronously; no TUI boot wait in tests
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'lubbdubb-resume-'));
}

/** Bring up a system, dispatch one desk agent, and return its live handle. */
async function spawnAgent(dir: string) {
  const backend = new FakePtyBackend();
  const system = buildSystem(ptyConfig(dir), { worktrees: new FakeWorktreeManager(), backend, errorMirror: () => {} });
  system.connector.inject({ kind: 'new_issue', number: 901, title: 'Add login' });
  await system.harness.runCycle('manual');
  const agent = system.store.listAgentsByStatus('starting', 'running')[0]!;
  return { backend, system, agent };
}

/**
 * Simulate a server restart: build a fresh system on the same db and run boot
 * detection. Nothing is resumed here — a restart now parks its orphans for an
 * operator's verdict, so the restore below is an explicit second step.
 */
function reboot(dir: string) {
  const backend = new FakePtyBackend();
  const system = buildSystem(ptyConfig(dir), { worktrees: new FakeWorktreeManager(), backend, errorMirror: () => {} });
  const crashed = system.recovery.detect();
  return { backend, system, crashed };
}

test('a PTY agent launches with a chosen, persisted --session-id', async () => {
  const dir = tmp();
  const { backend, system, agent } = await spawnAgent(dir);

  assert.ok(agent.sessionId, 'a session id is chosen and persisted');
  const spawn = backend.spawned[0]!;
  assert.equal(spawn.args[spawn.args.indexOf('--session-id') + 1], agent.sessionId);
  assert.equal(spawn.args.includes('--resume'), false, 'fresh launch does not resume');
  system.store.close();
});

test('a restored agent re-attaches to the same session in the same worktree', async () => {
  const dir = tmp();
  const { system: s1, agent } = await spawnAgent(dir);
  const { sessionId, cwd, id } = agent;

  // Graceful shutdown marks the agent resumable (interrupted), not killed.
  s1.agents.interruptAll();
  assert.equal(s1.store.getAgent(id)!.status, 'interrupted');
  s1.store.close();

  const { backend, system: s2, crashed } = reboot(dir);
  assert.equal(crashed.length, 1, 'the orphan is offered, not resumed');
  assert.equal(backend.spawned.length, 0, 'nothing relaunches before a verdict');
  assert.equal(crashed[0]!.restorable, true);

  const result = s2.recovery.decide(crashed[0]!.taskId, 'restore');
  assert.equal(result.ok, true);

  const spawn = backend.spawned[0]!;
  assert.equal(spawn.args[spawn.args.indexOf('--resume') + 1], sessionId, 'resumes the original session id');
  assert.equal(spawn.args.includes('--session-id'), false, 'does not also mint a new id');
  assert.ok(spawn.args.includes('--append-system-prompt'), 're-applies the protocol on resume');
  assert.equal(spawn.opts.cwd, cwd, 'resumes in the original worktree');

  // Same agent row, live again and counting toward the concurrency cap.
  assert.equal(s2.store.getAgent(id)!.status, 'running');
  assert.ok(s2.agents.isLive(id));
  assert.equal(s2.store.countLiveAgents(), 1);
  // A mid-work agent is nudged to carry on.
  assert.ok(
    backend.last().writes.some((w) => w.includes('Continue the task')),
    'a resumed mid-work agent is nudged to continue',
  );
  s2.store.close();
});

test('a crash (DB still marks the agent live) is offered for restore on the next boot', async () => {
  const dir = tmp();
  const { system: s1, agent } = await spawnAgent(dir);
  // Crash: no graceful shutdown. The process is gone but the row still says running.
  assert.equal(s1.store.getAgent(agent.id)!.status, 'running');
  s1.store.close();

  const { backend, system: s2, crashed } = reboot(dir);
  assert.equal(crashed.length, 1);
  assert.equal(crashed[0]!.died, 'crashed', 'a fallen-over process is distinguished from a clean shutdown');
  assert.equal(s2.store.getAgent(agent.id)!.status, 'crashed');

  s2.recovery.decide(crashed[0]!.taskId, 'restore');
  assert.equal(backend.spawned[0]!.args[backend.spawned[0]!.args.indexOf('--resume') + 1], agent.sessionId);
  assert.equal(s2.store.getAgent(agent.id)!.status, 'running');
  s2.store.close();
});

test('a cockpit kill is NOT offered for recovery on the next boot', async () => {
  const dir = tmp();
  const { system: s1, agent } = await spawnAgent(dir);

  // Deliberate per-agent kill from the cockpit.
  s1.agents.kill(agent.id);
  assert.equal(s1.store.getAgent(agent.id)!.status, 'killed');
  s1.store.close();

  const { backend, system: s2, crashed } = reboot(dir);
  assert.equal(crashed.length, 0, 'killed agents are not candidates');
  assert.equal(backend.spawned.length, 0, 'nothing is re-spawned');
  assert.equal(s2.store.getAgent(agent.id)!.status, 'killed', 'the kill stays dead');
  s2.store.close();
});

test('an orphan with no usable session id is offered requeue and remove, not restore', () => {
  const dir = tmp();
  const backend = new FakePtyBackend();
  const system = buildSystem(ptyConfig(dir), { worktrees: new FakeWorktreeManager(), backend, errorMirror: () => {} });

  // A legacy/partial agent row with no session id (e.g. died before one existed).
  const task = system.store.createTask({ kind: 'code', title: 't', prompt: 'p', branch: 'b', originRef: 'r' });
  system.store.updateTask(task.id, { status: 'running' });
  const agent = system.store.createAgent({ taskId: task.id, cwd: dir, pid: 1, status: 'running', sessionId: null });

  const crashed = system.recovery.detect();
  assert.equal(crashed.length, 1);
  assert.equal(crashed[0]!.restorable, false);
  assert.match(crashed[0]!.restoreBlocked!, /session id/);

  const refused = system.recovery.decide(crashed[0]!.taskId, 'restore');
  assert.equal(refused.ok, false, 'restore is refused rather than half-attempted');
  assert.equal(system.store.getAgent(agent.id)!.status, 'crashed', 'a refusal leaves the decision outstanding');
  assert.equal(backend.spawned.length, 0);
  system.store.close();
});

test("a waiting agent's escalation is restored with it and answers route into the live session", async () => {
  const dir = tmp();
  const { backend: b1, system: s1, agent } = await spawnAgent(dir);

  // The agent parks on a question -> one open escalation.
  b1.last().emit('@@LUBBDUBB_WAITING:Which database should I use?@@');
  assert.equal(s1.store.getAgent(agent.id)!.status, 'waiting');
  assert.equal(s1.store.listOpenEscalations().length, 1);

  s1.agents.interruptAll();
  s1.store.close();

  const { backend: b2, system: s2, crashed } = reboot(dir);
  assert.equal(crashed[0]!.waitingReason, 'Which database should I use?', 'the park is carried onto the card');
  assert.equal(s2.recovery.decide(crashed[0]!.taskId, 'restore').ok, true);

  // Restored to waiting, with the same still-open escalation.
  assert.equal(s2.store.getAgent(agent.id)!.status, 'waiting');
  const open = s2.store.listOpenEscalations();
  assert.equal(open.length, 1, 'the escalation is restored, not duplicated');
  assert.equal(open[0]!.agentId, agent.id);
  // A waiting agent must NOT be nudged — it's parked on a human, not mid-work.
  assert.ok(!b2.last().writes.some((w) => w.includes('Continue the task')));

  // Answering now routes straight into the resumed live session.
  const answered = s2.escalations.answer(open[0]!.id, 'Postgres');
  assert.equal(answered.routing, 'typed_into_agent');
  assert.ok(b2.last().writes.at(-1)!.includes('Postgres'));
  assert.equal(s2.store.getAgent(agent.id)!.status, 'running');
  s2.store.close();
});

test('detection is idempotent: a second detect does not re-park or double-count', async () => {
  const dir = tmp();
  const { system: s1, agent } = await spawnAgent(dir);
  s1.agents.interruptAll();
  s1.store.close();

  const { backend, system: s2 } = reboot(dir);
  // A repeat detect (e.g. boot ran twice) sees the same one pending decision.
  assert.equal(s2.recovery.detect().length, 1);
  assert.equal(s2.recovery.pendingCount(), 1);
  assert.equal(backend.spawned.length, 0, 'still nothing relaunched');

  // And a restore is applied exactly once: the second call finds nothing pending.
  const taskId = s2.store.getAgent(agent.id)!.taskId;
  assert.equal(s2.recovery.decide(taskId, 'restore').ok, true);
  assert.equal(backend.spawned.length, 1);
  assert.equal(s2.recovery.decide(taskId, 'restore').ok, false);
  assert.equal(backend.spawned.length, 1, 'already-live agent is not re-spawned');
  s2.store.close();
});
