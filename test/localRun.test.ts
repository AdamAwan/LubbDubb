import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { WorktreeManager } from '../src/worktree/worktreeManager.js';
import { gitRepo } from './support/gitRepo.js';
import { Store } from '../src/store/store.js';
import { LocalRunner } from '../src/localRun/runner.js';
import { localRunChoices } from '../src/localRun/ref.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { buildSystem } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import type { AgentSession, AgentSessionSpec, AgentSessionStatus } from '../src/agents/session.js';
import type { PlanPart } from '../src/types.js';
import { repoText } from './support/paths.js';

class FakeSession extends EventEmitter implements AgentSession {
  status: AgentSessionStatus = 'starting';
  pid: number | null = 4242;
  readonly log: string[] = [];
  readonly sent: string[] = [];
  constructor(readonly spec: AgentSessionSpec) {
    super();
  }
  start(): void {
    this.log.push('start');
    this.status = 'running';
  }
  send(text: string): void {
    this.sent.push(text);
  }
  sendRaw(): void {}
  kill(): void {
    this.log.push('kill');
    this.status = 'killed';
  }
}

interface Harness {
  store: Store;
  runner: LocalRunner;
  worktrees: FakeWorktreeManager;
  sessions: FakeSession[];
  reaped: number[];
}

function build(
  over: {
    instruction?: string;
    stopInstruction?: string;
    resumeInstruction?: string;
    stopTimeoutMs?: number;
    resumeWindowMs?: number;
    refreshInstruction?: string;
    url?: string;
    ref?: string | null;
    parts?: PlanPart[];
    store?: Store;
    now?: () => number;
  } = {},
): Harness {
  const store = over.store ?? new Store(':memory:');
  const worktrees = new FakeWorktreeManager();
  const sessions: FakeSession[] = [];
  const reaped: number[] = [];
  const runner = new LocalRunner({
    store,
    worktrees,
    sessions: (spec) => {
      const session = new FakeSession(spec);
      sessions.push(session);
      return session;
    },
    policy: () => ({
      instruction: over.instruction ?? 'Run the dev server.',
      stopInstruction: over.stopInstruction ?? '',
      resumeInstruction: over.resumeInstruction ?? '',
      resumeWindowMs: over.resumeWindowMs ?? 2 * 60 * 60 * 1000,
      refreshInstruction: over.refreshInstruction ?? '',
      url: over.url ?? '',
    }),
    claudeCommand: 'claude',
    claudeArgs: [],
    permissionMode: 'acceptEdits',
    defaultBranch: 'main',
    stopTimeoutMs: over.stopTimeoutMs,
    now: over.now,
    choicesFor: () =>
      localRunChoices(over.parts ?? (over.ref == null ? [] : [part({ slug: 'x', seq: 1, branch: over.ref })])),
    reap: (pid) => {
      reaped.push(pid);
      for (const s of sessions) if (s.pid === pid) s.log.push('reap');
    },
    errors: {
      record: (input) => ({ ...input, id: 'e1', detail: input.detail ?? null, createdAt: '2026-08-20T00:00:00.000Z' }),
    },
  });
  return { store, runner, worktrees, sessions, reaped };
}

test('a start with nothing configured refuses, and names the field that fixes it', async () => {
  const { runner, store } = build({ instruction: '   ' });
  const result = await runner.start('issue:284');
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /localRun\.instruction/);
  assert.equal(store.currentLocalRun(), null, 'a refusal records nothing at all');
  store.close();
});

test('a start prepares the checkout, writes the run, and tells the session what to do', async () => {
  const { runner, store, worktrees, sessions } = build({ ref: 'issue/284/viewer', url: 'http://localhost:4200' });
  const result = await runner.start('issue:284');
  assert.ok(result.ok, result.ok ? '' : result.error);

  assert.deepEqual(worktrees.previewed, ['issue/284/viewer']);
  const run = store.liveLocalRun();
  assert.equal(run?.originRef, 'issue:284');
  assert.equal(run?.ref, 'issue/284/viewer');
  assert.equal(run?.pid, 4242);
  assert.equal(run?.status, 'starting');
  assert.equal(run?.url, 'http://localhost:4200');

  const sent = sessions[0]?.sent[0] ?? '';
  assert.match(sent, /^Run the dev server\./);
  assert.match(sent, /background/);
  assert.match(sent, /Do not commit/);
  store.close();
});

test('a goal whose parts have all merged runs from the integration branch', async () => {
  const { runner, store, worktrees } = build({ ref: null });
  await runner.start('issue:284');
  assert.deepEqual(worktrees.previewed, ['main']);
  store.close();
});

test('the turn ending means the environment is up, not that the run is over', async () => {
  const { runner, store, sessions } = build();
  await runner.start('issue:284');
  assert.equal(store.liveLocalRun()?.status, 'starting');

  sessions[0]?.emit('done');
  assert.equal(store.liveLocalRun()?.status, 'running');
  assert.deepEqual(sessions[0]?.log, ['start']);
  store.close();
});

test('the newest phase line is the stage, and the output between them leaves it standing', async () => {
  const { runner, store, sessions } = build();
  await runner.start('issue:284');
  const session = sessions[0];
  assert.equal(runner.phase(), null, 'nothing has been said yet');

  session?.emit('output', 'phase: starting the containers\n');
  assert.equal(runner.phase(), 'starting the containers');

  session?.emit('output', 'postgres ready\nredis ready\n');
  assert.equal(runner.phase(), 'starting the containers');

  session?.emit('output', '- **phase:** building the services\n');
  assert.equal(runner.phase(), 'building the services');

  assert.equal(runner.output().length, 4);
  store.close();
});

test('the stage goes when the environment comes up, and when the run is stopped', async () => {
  const { runner, store, sessions } = build();
  await runner.start('issue:284');
  sessions[0]?.emit('output', 'phase: starting the web app\n');
  assert.equal(runner.phase(), 'starting the web app');

  sessions[0]?.emit('done');
  assert.equal(runner.phase(), null);

  await runner.start('issue:285');
  assert.equal(runner.phase(), null, 'a new run starts with nothing said about it');
  sessions[1]?.emit('output', 'phase: starting the containers\n');
  await runner.stop();
  assert.equal(runner.phase(), null, 'a stopped environment is not doing anything');
  store.close();
});

test('a session that fails settles the run with what it last said', async () => {
  const { runner, store, sessions } = build();
  await runner.start('issue:284');
  sessions[0]?.emit('output', 'EADDRINUSE: port 4200 is already taken\n');
  sessions[0]?.emit('failed');

  assert.equal(store.liveLocalRun(), null);
  const last = store.currentLocalRun();
  assert.equal(last?.status, 'failed');
  assert.match(last?.note ?? '', /EADDRINUSE/);
  store.close();
});

test('a stop runs the stop instruction, then reaps', async () => {
  const { runner, store, sessions } = build({ stopInstruction: 'Run /dev-environment stop.' });
  await runner.start('issue:284');
  const session = sessions[0];

  const stopping = runner.stop();
  const told = session?.sent[1] ?? '';
  assert.match(told, /^Run \/dev-environment stop\./);
  assert.match(told, /Stop everything that start brought up/);
  assert.equal(store.currentLocalRun()?.status, 'stopping', 'and the run says so while it happens');
  assert.deepEqual(session?.log, ['start'], 'nothing is killed until the instruction has run');

  session?.emit('output', 'stopped 6 containers; port 5173 is free\n');
  session?.emit('done');
  await stopping;

  assert.deepEqual(session?.log, ['start', 'reap', 'kill']);
  const run = store.currentLocalRun();
  assert.equal(run?.status, 'stopped');
  assert.match(run?.note ?? '', /6 containers/, 'what it said it stopped is the record of the stop');
  store.close();
});

test('a stop with nothing configured says what it could not do', async () => {
  const { runner, store, sessions } = build();
  await runner.start('issue:284');
  await runner.stop();

  assert.deepEqual(sessions[0]?.log, ['start', 'reap', 'kill']);
  assert.equal(sessions[0]?.sent.length, 1, 'nothing was asked of it');
  const note = store.currentLocalRun()?.note ?? '';
  assert.match(note, /may still be running/);
  assert.match(note, /localRun\.stopInstruction/, 'and names the field that fixes it');
  store.close();
});

test('a stop that never finishes is killed anyway, and says it was not confirmed', async () => {
  const { runner, store, sessions } = build({ stopInstruction: 'Run /dev-environment stop.', stopTimeoutMs: 5 });
  await runner.start('issue:284');
  await runner.stop();

  assert.deepEqual(sessions[0]?.log, ['start', 'reap', 'kill']);
  assert.match(store.currentLocalRun()?.note ?? '', /did not finish within/);
  store.close();
});

test('a stop with no session left spawns one in the run’s own checkout', async () => {
  const first = build({ stopInstruction: 'Run /dev-environment stop.' });
  await first.runner.start('issue:284');
  const dir = first.store.liveLocalRun()?.dir ?? '';

  const after = build({ store: first.store, stopInstruction: 'Run /dev-environment stop.' });
  const stopping = after.runner.stop();
  const spawned = after.sessions[0];
  assert.ok(spawned, 'a session was spawned to do the stopping');
  assert.equal(spawned.spec.cwd, dir, 'in the checkout the run was using');
  assert.match(spawned.sent[0] ?? '', /You did not start this/);

  spawned.emit('done');
  await stopping;
  assert.deepEqual(spawned.log, ['start', 'reap', 'kill'], 'and it is closed again afterwards');
  assert.equal(after.store.liveLocalRun(), null);
  first.store.close();
});

test('a swap waits for the stop before it touches the checkout', async () => {
  const { runner, store, worktrees, sessions } = build({ stopInstruction: 'Run /dev-environment stop.' });
  await runner.start('issue:284');
  assert.deepEqual(worktrees.previewed, ['main']);

  const swapping = runner.start('issue:285');
  assert.deepEqual(worktrees.previewed, ['main'], 'nothing is prepared while the old one is coming down');
  assert.equal(store.currentLocalRun()?.status, 'stopping');

  sessions[0]?.emit('done');
  const result = await swapping;
  assert.ok(result.ok, result.ok ? '' : result.error);
  assert.deepEqual(worktrees.previewed, ['main', 'main']);
  assert.equal(sessions.length, 2, 'the new run got its own session');
  store.close();
});

test('a stopping run is live: nothing may begin beside it, and a restart settles it', async () => {
  const { runner, store, sessions } = build({ stopInstruction: 'Run /dev-environment stop.' });
  await runner.start('issue:284');
  const stopping = runner.stop();
  const live = store.liveLocalRun();
  assert.equal(live?.status, 'stopping', 'a run coming down still holds the environment');

  const after = build({ store, resumeInstruction: 'Run /dev-environment continue.' });
  const settled = after.runner.resumeInterrupted();
  assert.equal(settled.outcome, 'settled');
  assert.equal(store.liveLocalRun(), null);
  assert.equal(after.sessions.length, 0, 'and nothing was brought back');
  assert.match(store.currentLocalRun()?.note ?? '', /taken down/);

  sessions[0]?.emit('done');
  await stopping;
  store.close();
});

test('the shutdown path kills without a turn, and records that it did', async () => {
  const { runner, store, sessions } = build({ stopInstruction: 'Run /dev-environment stop.' });
  await runner.start('issue:284');
  runner.stopFast('the harness shut down');

  assert.equal(sessions[0]?.sent.length, 1, 'the stop instruction was not run');
  assert.deepEqual(sessions[0]?.log, ['start', 'reap', 'kill']);
  const note = store.currentLocalRun()?.note ?? '';
  assert.match(note, /the harness shut down/);
  assert.match(note, /may still be running/);
  store.close();
});

test('stopping reaps the subtree before it signals the child', async () => {
  const { runner, store, sessions, reaped } = build();
  await runner.start('issue:284');
  await runner.stop();

  assert.deepEqual(reaped, [4242]);
  assert.deepEqual(sessions[0]?.log, ['start', 'reap', 'kill']);
  assert.equal(store.liveLocalRun(), null);
  assert.equal(store.currentLocalRun()?.status, 'stopped');
  store.close();
});

test('starting another goal stops the first — one environment, one run', async () => {
  const { runner, store, sessions } = build();
  await runner.start('issue:284');
  const first = store.liveLocalRun();
  await runner.start('issue:285');

  const second = store.liveLocalRun();
  assert.equal(second?.originRef, 'issue:285');
  assert.notEqual(second?.id, first?.id);
  assert.deepEqual(sessions[0]?.log, ['start', 'reap', 'kill']);
  assert.equal(sessions.length, 2);
  store.close();
});

test('a restart settles a run it cannot bring back, and names the field that would', () => {
  const { runner, store } = build();
  store.beginLocalRun({ originRef: 'issue:284', ref: 'main', dir: '/tmp/x', commit: 'abc123', url: null });
  assert.equal(store.liveLocalRun()?.originRef, 'issue:284');

  const outcome = runner.resumeInterrupted();
  assert.equal(outcome.outcome, 'settled');
  assert.equal(store.liveLocalRun(), null);
  const note = store.currentLocalRun()?.note ?? '';
  assert.match(note, /restarted/);
  assert.match(note, /localRun\.resumeInstruction/, 'and the operator is told what would have changed it');
  store.close();
});

test('nothing live is nothing to do', () => {
  const { runner, store } = build({ resumeInstruction: 'Run /dev-environment continue.' });
  assert.equal(runner.resumeInterrupted().outcome, 'nothing');
  store.close();
});

test('a restart brings an interrupted run back in its own checkout, without preparing it', async () => {
  const first = build({ resumeInstruction: 'Run /dev-environment continue.' });
  await first.runner.start('issue:284');
  const dir = first.store.liveLocalRun()?.dir ?? '';
  first.runner.stopFast('the harness shut down');
  assert.deepEqual(first.sessions[0]?.log, ['start', 'reap', 'kill']);
  const held = first.store.liveLocalRun();
  assert.ok(held, 'the row outlives the process it was holding');
  assert.match(held.note ?? '', /next boot/);

  const after = build({ store: first.store, resumeInstruction: 'Run /dev-environment continue.' });
  const outcome = after.runner.resumeInterrupted();
  assert.equal(outcome.outcome, 'resumed');
  const brought = after.sessions[0];
  assert.ok(brought, 'a session was spawned to bring it back');
  assert.equal(brought.spec.cwd, dir, 'in the checkout the run was already using');
  assert.match(brought.sent[0] ?? '', /continue/);
  assert.match(brought.sent[0] ?? '', /You did not start this/);
  assert.match(brought.sent[0] ?? '', /not a collision/);
  assert.deepEqual(after.worktrees.previewed, [], 'the checkout already stands at the run’s own commit');
  assert.equal(after.store.liveLocalRun()?.id, held.id, 'the same run, continued — not a second one');

  brought.emit('done');
  assert.equal(after.store.liveLocalRun()?.status, 'running');
  first.store.close();
});

const HOUR = 60 * 60 * 1000;

test('a run interrupted longer ago than the window is not brought back', async () => {
  const at = Date.parse('2026-09-02T09:00:00.000Z');
  const first = build({ resumeInstruction: 'Run /dev-environment continue.', now: () => at });
  await first.runner.start('issue:284');
  first.runner.stopFast('the harness shut down');
  assert.equal(
    first.store.liveLocalRun()?.interruptedAt,
    new Date(at).toISOString(),
    'the fast stop dates the interruption — the one thing the next boot can judge',
  );

  const after = build({
    store: first.store,
    resumeInstruction: 'Run /dev-environment continue.',
    now: () => at + 3 * HOUR,
  });
  const outcome = after.runner.resumeInterrupted();
  assert.equal(outcome.outcome, 'settled');
  assert.equal(after.sessions.length, 0, 'no session was spent bringing back an environment nobody is watching');
  assert.equal(after.store.liveLocalRun(), null, 'and the row stops claiming a process that is gone');
  const note = after.store.currentLocalRun()?.note ?? '';
  assert.match(note, /3 hours ago/);
  assert.match(note, /may still be running/, 'the operator is told what may still be up');
  assert.match(note, /localRun\.resumeWindowMs/, 'and what would have changed it');
  first.store.close();
});

test('a run interrupted inside the window still comes back', async () => {
  const at = Date.parse('2026-09-02T09:00:00.000Z');
  const first = build({ resumeInstruction: 'Run /dev-environment continue.', now: () => at });
  await first.runner.start('issue:284');
  first.runner.stopFast('the harness shut down');

  const after = build({
    store: first.store,
    resumeInstruction: 'Run /dev-environment continue.',
    now: () => at + HOUR,
  });
  assert.equal(after.runner.resumeInterrupted().outcome, 'resumed');
  assert.equal(after.sessions.length, 1);
  assert.equal(after.store.liveLocalRun()?.interruptedAt, null);
  first.store.close();
});

test('a live row with neither stamp is unknown, not recent, and is not brought back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-local-run-undated-'));
  const file = join(dir, 'undated.sqlite');
  let store: Store | null = null;
  try {
    const before = new Store(file);
    const run = before.beginLocalRun({
      originRef: 'issue:284',
      ref: 'main',
      dir: process.cwd(),
      commit: 'abc123',
      url: null,
    });
    before.close();
    const raw = new Database(file);
    raw.prepare(`UPDATE local_runs SET interrupted_at = NULL, last_seen_at = NULL WHERE id = ?`).run(run.id);
    raw.close();

    store = new Store(file);
    const after = build({ store, resumeInstruction: 'Run /dev-environment continue.' });
    assert.equal(after.runner.resumeInterrupted().outcome, 'settled');
    assert.match(store.currentLocalRun()?.note ?? '', /not known/);
    assert.equal(store.liveLocalRun(), null);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('no window means no bound, which is the behaviour before there was one', async () => {
  const at = Date.parse('2026-09-02T09:00:00.000Z');
  const first = build({ resumeInstruction: 'Run /dev-environment continue.', now: () => at, resumeWindowMs: 0 });
  await first.runner.start('issue:284');
  first.runner.stopFast('the harness shut down');

  const after = build({
    store: first.store,
    resumeInstruction: 'Run /dev-environment continue.',
    resumeWindowMs: 0,
    now: () => at + 40 * HOUR,
  });
  assert.equal(after.runner.resumeInterrupted().outcome, 'resumed');
  first.store.close();
});

test('a force close is dated by the pulse, and its run still comes back', async () => {
  const at = Date.parse('2026-09-02T09:00:00.000Z');
  const first = build({ resumeInstruction: 'Run /dev-environment continue.', now: () => at });
  await first.runner.start('issue:284');
  first.runner.noteAlive();
  const held = first.store.liveLocalRun();
  assert.equal(held?.interruptedAt, null, 'nothing was shut down, so nothing stamped an interruption');
  assert.ok(held?.lastSeenAt, 'but the pulse recorded that the harness was holding it');

  const after = build({
    store: first.store,
    resumeInstruction: 'Run /dev-environment continue.',
    now: () => at + 10 * 60 * 1000,
  });
  assert.equal(after.runner.resumeInterrupted().outcome, 'resumed', 'ten minutes after a kill is still a restart');
  first.store.close();
});

test('a force close long enough ago is not brought back, and the note says what it knows', async () => {
  const at = Date.parse('2026-09-02T09:00:00.000Z');
  const first = build({ resumeInstruction: 'Run /dev-environment continue.', now: () => at });
  await first.runner.start('issue:284');
  first.runner.noteAlive();

  const after = build({
    store: first.store,
    resumeInstruction: 'Run /dev-environment continue.',
    now: () => at + 5 * HOUR,
  });
  assert.equal(after.runner.resumeInterrupted().outcome, 'settled');
  assert.equal(after.sessions.length, 0);
  assert.match(after.store.currentLocalRun()?.note ?? '', /last holding it 5 hours ago/);
  first.store.close();
});

test('a boot never dates a run it declined to bring back', () => {
  const at = Date.parse('2026-09-02T09:00:00.000Z');
  const { runner, store } = build({ resumeInstruction: 'Run /dev-environment continue.', now: () => at });
  store.beginLocalRun({ originRef: 'issue:284', ref: 'main', dir: process.cwd(), commit: 'abc123', url: null });
  const before = store.liveLocalRun()?.lastSeenAt ?? null;

  runner.noteAlive();
  assert.equal(store.liveLocalRun()?.lastSeenAt, before, 'a harness holding nothing dates nothing');
  store.close();
});

test('a pulse dates the run the harness is holding, at the buildSystem seam', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lubbdubb-local-run-pulse-'));
  const file = join(root, 'pulse.sqlite');
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: file,
      agentMode: 'raw',
      deskRoot: join(root, 'desk'),
      worktreeRoot: join(root, 'wt'),
      heartbeatIntervalMs: 999_999,
      localRun: { instruction: 'Run the dev server.' } as never,
    }),
    {
      worktrees: new FakeWorktreeManager(),
      backend: new FakePtyBackend(),
      gitObserver: new FakeGitObserver(),
      errorMirror: () => {},
    },
  );
  try {
    const started = await system.localRun.start('issue:12');
    assert.ok(started.ok, started.ok ? '' : started.error);
    const run = system.store.liveLocalRun();
    assert.ok(run?.lastSeenAt, 'a run starts held, as of now');

    const stale = '2020-01-01T00:00:00.000Z';
    const raw = new Database(file);
    raw.prepare(`UPDATE local_runs SET last_seen_at = ? WHERE id = ?`).run(stale, run.id);
    raw.close();
    assert.equal(system.store.liveLocalRun()?.lastSeenAt, stale, 'backdated, as a harness left running would be');

    await system.harness.runCycle('manual');
    const seen = system.store.liveLocalRun()?.lastSeenAt ?? null;
    assert.ok(seen !== null && seen > stale, 'the pulse re-dated it');
  } finally {
    system.store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('the pulse dates the run above its own recovery hold', () => {
  const text = repoText('src/harness.ts');
  const stamp = text.indexOf('localRun?.noteAlive()');
  const hold = text.indexOf('recovery?.pendingCount()');
  assert.ok(stamp > 0, 'the pulse stamps the local run it is holding');
  assert.ok(hold > 0, 'and asks the recovery hold');
  assert.ok(stamp < hold, 'the stamp comes first: a held pulse is still a live harness');
});

test('the boot that adds the stamp dates the run it is upgrading over', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-local-run-stamp-'));
  const file = join(dir, 'before-the-stamp.sqlite');
  const at = '2026-09-02T09:00:00.000Z';
  let store: Store | null = null;
  try {
    const before = new Store(file);
    before.beginLocalRun({ originRef: 'issue:284', ref: 'main', dir: process.cwd(), commit: 'abc123', url: null });
    before.close();

    const raw = new Database(file);
    raw.exec(`CREATE TABLE local_runs_pre AS SELECT id, origin_ref, ref, dir, pid, status, url, note,
                started_at, ended_at, cost_usd, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, num_turns FROM local_runs;
              DROP TABLE local_runs;
              ALTER TABLE local_runs_pre RENAME TO local_runs;`);
    raw.close();

    store = new Store(file, () => at);
    assert.equal(store.liveLocalRun()?.interruptedAt, at, 'the row this boot inherited is dated to this boot');
    const after = build({ store, resumeInstruction: 'Run /dev-environment continue.', now: () => Date.parse(at) });
    assert.equal(after.runner.resumeInterrupted().outcome, 'resumed');
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('a run whose checkout has gone is not brought back', () => {
  const { runner, store } = build({ resumeInstruction: 'Run /dev-environment continue.' });
  store.beginLocalRun({
    originRef: 'issue:284',
    ref: 'main',
    dir: join(tmpdir(), 'lubbdubb-gone-' + String(process.pid)),
    commit: 'abc123',
    url: null,
  });

  const outcome = runner.resumeInterrupted();
  assert.equal(outcome.outcome, 'settled');
  assert.match(store.currentLocalRun()?.note ?? '', /is gone/);
  assert.equal(store.liveLocalRun(), null);
  store.close();
});

function usage(costUsd: number, turns: number) {
  return {
    costUsd,
    inputTokens: turns * 1000,
    outputTokens: turns * 50,
    cacheReadTokens: turns * 700,
    cacheCreationTokens: turns * 60,
    numTurns: turns,
  };
}

test('what the session spends lands on the run, cumulative reports and all', async () => {
  const { runner, store, sessions } = build();
  await runner.start('issue:284');
  const session = sessions[0];

  session?.emit('usage', usage(0.4, 3));
  session?.emit('usage', usage(1.1, 8));

  const run = store.currentLocalRun();
  assert.equal(run?.costUsd, 1.1);
  assert.equal(run?.numTurns, 8);
  assert.equal(run?.inputTokens, 8000);
  store.close();
});

test('a teardown by a fresh session adds to the run rather than replacing it', async () => {
  const first = build({ stopInstruction: 'Run /dev-environment stop.' });
  await first.runner.start('issue:284');
  first.sessions[0]?.emit('usage', usage(2, 12));

  const second = build({ store: first.store, stopInstruction: 'Run /dev-environment stop.' });
  const stopping = second.runner.stop();
  const stopper = second.sessions[0];
  stopper?.emit('usage', usage(0.15, 2));
  stopper?.emit('done');
  await stopping;

  const run = first.store.currentLocalRun();
  assert.equal(run?.costUsd, 2.15, 'the stop is part of what the run cost');
  assert.equal(run?.numTurns, 14);
  first.store.close();
});

test('a run that reports nothing stays unmeasured, not free', async () => {
  const { runner, store } = build();
  await runner.start('issue:284');
  assert.equal(store.currentLocalRun()?.costUsd, null);
  assert.equal(store.currentLocalRun()?.numTurns, null);
  store.close();
});

test('a local run’s money is in the rolling window, dated', async () => {
  const { runner, store, sessions } = build();
  await runner.start('issue:284');
  sessions[0]?.emit('usage', usage(0.75, 4));

  assert.equal(store.sumUsageCostSince('2000-01-01T00:00:00.000Z'), 0.75);
  const deltas = store.listCostDeltasSince('2000-01-01T00:00:00.000Z');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0]?.costUsd, 0.75);
  assert.deepEqual(store.listUsageEventsSince('2000-01-01T00:00:00.000Z'), []);
  store.close();
});

test('a database from before the columns reads them as unmeasured, and can be written', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'lubbdubb-lr-')), 'db.sqlite');
  const old = new Database(path);
  old.exec(`CREATE TABLE local_runs (
      id TEXT PRIMARY KEY, origin_ref TEXT NOT NULL, ref TEXT NOT NULL, dir TEXT NOT NULL,
      pid INTEGER, status TEXT NOT NULL, url TEXT, note TEXT, started_at TEXT NOT NULL, ended_at TEXT)`);
  old
    .prepare(
      `INSERT INTO local_runs (id, origin_ref, ref, dir, status, started_at)
     VALUES ('r-old', 'issue:9', 'issue/9', '/preview', 'stopped', '2026-08-01T00:00:00.000Z')`,
    )
    .run();
  old.close();

  const store = new Store(path);
  const run = store.currentLocalRun();
  assert.equal(run?.id, 'r-old');
  assert.equal(run?.costUsd, null, 'that run measured nothing, which is not the same as costing nothing');
  assert.equal(run?.commit, null);
  store.setLocalRunCommit('r-old', 'abc123');
  assert.equal(store.currentLocalRun()?.commit, 'abc123', 'and the column can be written on an old database');
  store.addLocalRunUsage('r-old', {
    costUsd: 0.2,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: 1,
  });
  assert.equal(store.currentLocalRun()?.costUsd, 0.2);
  assert.equal(store.sumUsageCostSince('2000-01-01T00:00:00.000Z'), 0.2, 'and the deltas table was created too');
  store.close();
});

function part(over: Partial<PlanPart> & { slug: string; seq: number }): PlanPart {
  return {
    id: `plan:${over.slug}`,
    planId: 'plan',
    title: over.slug,
    scope: '',
    touches: [],
    rationale: null,
    acceptance: null,
    acceptanceMet: [],
    size: null,
    expectedKind: null,
    outcomeKind: null,
    outcomeRef: null,
    outcomeSummary: null,
    dependsOn: [],
    branch: null,
    prNumber: null,
    status: 'pending',
    blockedReason: null,
    blockedBy: null,
    taskId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

test('the default ref is the tip of the stack, not the first unmerged part', () => {
  const choices = localRunChoices([
    part({ slug: 'b', seq: 2, branch: 'issue/1/b' }),
    part({ slug: 'a', seq: 1, branch: 'issue/1/a' }),
  ]);
  assert.equal(choices.target, 'issue/1/b');
  assert.deepEqual(
    choices.options.map((o) => o.ref),
    ['issue/1/a', 'issue/1/b'],
  );
});

test('merged, retired and concluded parts are never the tip, but stay on offer', () => {
  const choices = localRunChoices([
    part({ slug: 'a', seq: 1, branch: 'issue/1/a', status: 'merged' }),
    part({ slug: 'b', seq: 2, branch: 'issue/1/b', status: 'retired' }),
    part({ slug: 'c', seq: 3, branch: 'issue/1/c', status: 'concluded' }),
    part({ slug: 'd', seq: 4, branch: 'issue/1/d', status: 'in_review' }),
  ]);
  assert.equal(choices.target, 'issue/1/d');
  assert.equal(choices.options.length, 4);
  assert.equal(choices.parts.merged, 1);

  const allMerged = localRunChoices([part({ slug: 'a', seq: 1, branch: 'issue/1/a', status: 'merged' })]);
  assert.equal(allMerged.target, null, 'a goal whose parts have all merged *is* the integration branch');
  const undispatched = localRunChoices([part({ slug: 'a', seq: 1 })]);
  assert.equal(undispatched.target, null);
  assert.deepEqual(undispatched.options, []);
});

test('a goal nobody decomposed runs on its own branch, not the integration branch', () => {
  const own = localRunChoices([], 'issue/284');
  assert.equal(own.target, 'issue/284');
  assert.deepEqual(own.options, [{ ref: 'issue/284', part: null }]);

  const both = localRunChoices([part({ slug: 'a', seq: 1, branch: 'issue/284/a' })], 'issue/284');
  assert.equal(both.target, 'issue/284/a');
  assert.deepEqual(
    both.options.map((o) => o.ref),
    ['issue/284', 'issue/284/a'],
  );
});

test('an override runs an earlier part, and only a branch of that goal', async () => {
  const parts = [part({ slug: 'a', seq: 1, branch: 'issue/1/a' }), part({ slug: 'b', seq: 2, branch: 'issue/1/b' })];
  const { runner, store, worktrees } = build({ parts });

  await runner.start('issue:284', 'issue/1/a');
  assert.deepEqual(worktrees.previewed, ['issue/1/a'], 'the override is what gets checked out');

  const refused = await runner.start('issue:284', 'refs/heads/somebody-elses-branch');
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.error, /issue:284/);
  assert.deepEqual(worktrees.previewed, ['issue/1/a'], 'and nothing was prepared for it');
  store.close();
});

test('the preview checkout changes ref without losing what makes it warm', async () => {
  const repo = gitRepo('lubbdubb-preview-');
  const git = (args: string[]): void => void execFileSync('git', args, { cwd: repo });
  writeFileSync(join(repo, '.gitignore'), 'deps/\n');
  writeFileSync(join(repo, 'app.txt'), 'first\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'first']);
  git(['branch', 'feature']);
  writeFileSync(join(repo, 'app.txt'), 'second\n');
  git(['commit', '-q', '-am', 'second']);

  const wt = new WorktreeManager(repo, join(repo, '.wt'), { size: 2, held: () => false }, join(repo, '.preview'));
  const { dir } = await wt.ensurePreview('main');
  mkdirSync(join(dir, 'deps'), { recursive: true });
  writeFileSync(join(dir, 'deps', 'installed.txt'), 'a cold install is the thing this avoids\n');
  writeFileSync(join(dir, 'app.txt'), 'scribbled over\n');
  writeFileSync(join(dir, 'scratch.txt'), 'left over\n');

  const again = (await wt.ensurePreview('feature')).dir;
  assert.equal(again, dir, 'one directory, whatever ref it is pointed at');
  assert.ok(existsSync(join(dir, 'deps', 'installed.txt')), 'ignored files survive the change of ref');
  assert.equal(readFileSync(join(dir, 'app.txt'), 'utf8').trim(), 'first');
  assert.ok(!existsSync(join(dir, 'scratch.txt')), 'the last run drops its leftovers');
});

test('an unresolvable ref leaves the checkout exactly as it was', async () => {
  const repo = gitRepo('lubbdubb-preview-bad-');
  const wt = new WorktreeManager(repo, join(repo, '.wt'), { size: 2, held: () => false }, join(repo, '.preview'));
  const { dir } = await wt.ensurePreview('main');
  writeFileSync(join(dir, 'kept.txt'), 'still here\n');

  await assert.rejects(() => wt.ensurePreview('no/such/branch'), /resolves to no commit/);
  assert.ok(existsSync(join(dir, 'kept.txt')), 'nothing was reset or cleaned on the way to the refusal');
});

test('ensurePreview reports the commit it stands at, and previewCommit resolves without touching the tree', async () => {
  const repo = gitRepo('lubbdubb-preview-commit-');
  const wt = new WorktreeManager(repo, join(repo, '.wt'), { size: 2, held: () => false }, join(repo, '.preview'));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const { dir, commit } = await wt.ensurePreview('main');
  assert.equal(commit, head, 'the run records where the checkout actually stands');

  writeFileSync(join(dir, 'kept.txt'), 'still here\n');
  assert.equal(await wt.previewCommit('main'), head);
  assert.ok(existsSync(join(dir, 'kept.txt')), 'resolving is not resetting');
  await assert.rejects(() => wt.previewCommit('no/such/branch'), /resolves to no commit/);
});

test('a turn that ends with no sentinel is the environment up', async () => {
  const { runner, store, sessions } = build();
  await runner.start('issue:284');
  assert.equal(runner.turn(), 'start');
  sessions[0]?.emit('stalled', 'Up on :5173');
  assert.equal(store.liveLocalRun()?.status, 'running');
  assert.equal(runner.turn(), null, 'nothing is in flight once the turn has ended');
  assert.deepEqual(sessions[0]?.log, ['start'], 'nothing was killed');
  store.close();
});

test('a stop whose session stalls rather than saying done still settles, reap before kill', async () => {
  const { runner, store, sessions } = build({ stopInstruction: 'Run /dev-environment stop.' });
  await runner.start('issue:284');
  sessions[0]?.emit('stalled', '');
  const stopping = runner.stop();
  assert.equal(runner.turn(), 'stop');
  sessions[0]?.emit('output', 'stopped 6 containers\n');
  sessions[0]?.emit('stalled', 'stopped 6 containers');
  await stopping;
  assert.equal(store.currentLocalRun()?.status, 'stopped');
  assert.match(store.currentLocalRun()?.note ?? '', /stopped 6 containers/);
  assert.deepEqual(sessions[0]?.log, ['start', 'reap', 'kill']);
  assert.equal(runner.turn(), null);
  store.close();
});

test('a start records the commit the checkout stands at', async () => {
  const { runner, store, worktrees } = build({ ref: 'issue/284/viewer' });
  await runner.start('issue:284');
  const run = store.liveLocalRun();
  assert.equal(run?.commit, await worktrees.previewCommit('issue/284/viewer'));
  assert.match(run?.commit ?? '', /^[0-9a-f]{40}$/, 'sha-shaped, as production will be');
  store.close();
});

test('a message is echoed into the tail, handed to the session, and is a turn until it ends', async () => {
  const { runner, store, sessions } = build();
  await runner.start('issue:284');
  sessions[0]?.emit('stalled', '');
  const sent = runner.send('restart the api');
  assert.ok(sent.ok, sent.ok ? '' : sent.error);
  assert.equal(sessions[0]?.sent[1], 'restart the api');
  assert.ok(
    runner.output().some((line) => line.includes('restart the api')),
    'the message is in the tail',
  );
  assert.equal(runner.turn(), 'message');
  assert.equal(store.liveLocalRun()?.status, 'running', 'a message is not a change of status');
  sessions[0]?.emit('stalled', 'Restarted.');
  assert.equal(runner.turn(), null);
  assert.equal(store.liveLocalRun()?.status, 'running');
  store.close();
});

test('a message is refused while starting, while busy, while stopping, and when nothing holds the environment', async () => {
  const first = build({ stopInstruction: 'Run /dev-environment stop.' });
  const nobody = first.runner.send('hello');
  assert.equal(nobody.ok, false, 'nothing is running');

  await first.runner.start('issue:284');
  const starting = first.runner.send('hello');
  assert.equal(starting.ok, false);
  assert.match(starting.ok ? '' : starting.error, /coming up/);

  first.sessions[0]?.emit('stalled', '');
  assert.ok(first.runner.send('one').ok);
  const busy = first.runner.send('two');
  assert.equal(busy.ok, false);
  assert.match(busy.ok ? '' : busy.error, /busy/);

  first.sessions[0]?.emit('stalled', '');
  const stopping = first.runner.stop();
  const midStop = first.runner.send('three');
  assert.equal(midStop.ok, false);
  assert.match(midStop.ok ? '' : midStop.error, /being stopped/);
  first.sessions[0]?.emit('stalled', '');
  await stopping;
  assert.equal(first.sessions[0]?.sent.length, 3, 'the start, the one message that went, and the stop');

  const store = new Store(':memory:');
  const before = build({ store });
  await before.runner.start('issue:284');
  before.sessions[0]?.emit('stalled', '');
  const after = build({ store });
  const orphan = after.runner.send('hello');
  assert.equal(orphan.ok, false);
  assert.match(orphan.ok ? '' : orphan.error, /nothing holds/);
  first.store.close();
  store.close();
});

test('a session that records what is sent is not echoed twice', async () => {
  const { runner, sessions, store } = build();
  await runner.start('issue:284');
  const session = sessions[0];
  assert.ok(session);
  (session as { recordsSentMessages?: boolean }).recordsSentMessages = true;
  session.emit('stalled', '');
  const before = runner.output().length;
  assert.ok(runner.send('hello').ok);
  assert.equal(runner.output().length, before, 'the PTY runtime carries both halves itself');
  store.close();
});

test('a refresh moves the checkout to the tip, records it, and tells the session what moved', async () => {
  const { runner, store, worktrees, sessions } = build({
    ref: 'issue/284/viewer',
    refreshInstruction: 'Run the migrations.',
  });
  await runner.start('issue:284');
  sessions[0]?.emit('stalled', '');
  const was = store.liveLocalRun()?.commit ?? '';
  const tip = 'f'.repeat(40);
  worktrees.setPreviewCommit('issue/284/viewer', tip);

  const result = await runner.refresh();
  assert.ok(result.ok, result.ok ? '' : result.error);
  assert.deepEqual(result.moved, { from: was, to: tip });
  assert.deepEqual(worktrees.resolved, ['issue/284/viewer']);
  assert.deepEqual(worktrees.previewed, ['issue/284/viewer', 'issue/284/viewer']);
  assert.equal(store.liveLocalRun()?.commit, tip);

  const told = sessions[0]?.sent[1] ?? '';
  assert.match(told, /^Run the migrations\./, 'the operator’s own sentence first');
  assert.match(told, /moved/);
  assert.match(told, new RegExp(tip.slice(0, 12)));
  assert.match(told, /Do not commit/);
  assert.equal(runner.turn(), 'refresh');
  sessions[0]?.emit('stalled', 'Restarted the API.');
  assert.equal(runner.turn(), null);
  assert.equal(store.liveLocalRun()?.status, 'running');
  store.close();
});

test('a refresh at the tip refuses without touching the checkout', async () => {
  const { runner, store, worktrees, sessions } = build({ ref: 'issue/284/viewer' });
  await runner.start('issue:284');
  sessions[0]?.emit('stalled', '');
  const result = await runner.refresh();
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /already at the tip/);
  assert.deepEqual(worktrees.previewed, ['issue/284/viewer'], 'no reset, no clean — the tree was not touched');
  assert.equal(sessions[0]?.sent.length, 1, 'and the session was not told anything');
  store.close();
});

test('a refresh is refused while starting, while a turn is in flight, and during a stop', async () => {
  const { runner, store, worktrees, sessions } = build({ ref: 'issue/284/viewer', stopInstruction: 'Stop it.' });
  worktrees.setPreviewCommit('issue/284/viewer', 'a'.repeat(40));
  const nothing = await runner.refresh();
  assert.equal(nothing.ok, false, 'nothing is running');

  await runner.start('issue:284');
  worktrees.setPreviewCommit('issue/284/viewer', 'b'.repeat(40));
  const starting = await runner.refresh();
  assert.equal(starting.ok, false);
  assert.match(starting.ok ? '' : starting.error, /coming up/);

  sessions[0]?.emit('stalled', '');
  assert.ok(runner.send('one').ok);
  const busy = await runner.refresh();
  assert.equal(busy.ok, false);
  assert.match(busy.ok ? '' : busy.error, /busy/);

  sessions[0]?.emit('stalled', '');
  const stopping = runner.stop();
  const midStop = await runner.refresh();
  assert.equal(midStop.ok, false);
  assert.match(midStop.ok ? '' : midStop.error, /being stopped/);
  sessions[0]?.emit('stalled', '');
  await stopping;
  assert.deepEqual(worktrees.previewed, ['issue/284/viewer'], 'none of the refusals moved the checkout');
  store.close();
});

test('a refresh whose checkout will not move leaves the recorded commit alone', async () => {
  const { runner, store, worktrees, sessions } = build({ ref: 'issue/284/viewer' });
  await runner.start('issue:284');
  sessions[0]?.emit('stalled', '');
  const was = store.liveLocalRun()?.commit;
  worktrees.setPreviewCommit('issue/284/viewer', 'c'.repeat(40));
  worktrees.failPreview = new Error('EBUSY: resource busy or locked');
  const result = await runner.refresh();
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /part-reset/);
  assert.equal(store.liveLocalRun()?.commit, was, 'a commit the tree does not stand at is not recorded');
  assert.equal(sessions[0]?.sent.length, 1, 'and the session was not told about a move that did not happen');
  store.close();
});

test('a refresh with nothing holding the environment moves the checkout and says so', async () => {
  const store = new Store(':memory:');
  const before = build({ store, ref: 'issue/284/viewer' });
  await before.runner.start('issue:284');
  before.sessions[0]?.emit('stalled', '');
  const after = build({ store, ref: 'issue/284/viewer' });
  after.worktrees.setPreviewCommit('issue/284/viewer', 'd'.repeat(40));
  const result = await after.runner.refresh();
  assert.ok(result.ok, result.ok ? '' : result.error);
  assert.equal(store.liveLocalRun()?.commit, 'd'.repeat(40), 'the git half is still done');
  assert.match(store.liveLocalRun()?.note ?? '', /nothing holds/);
  assert.equal(after.sessions.length, 0, 'and no session was spawned to be told');
  store.close();
});
