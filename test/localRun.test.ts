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

/**
 * The local run: the machine's one dev environment, and the process holding it up.
 *
 * Three properties carry the design, and each has a plausible twin that would be
 * wrong in a way nothing else would catch:
 *
 * 1. **One at a time, enforced by the store.** A runner that checked before it
 *    wrote would leave two servers on one port with the cockpit drawing one.
 * 2. **The reap goes before the kill.** Descendants resolve through the root pid,
 *    and the descendant here *is* the dev server — so reaping after the process
 *    dies finds nothing and leaves the port held and the checkout unremovable.
 * 3. **The turn ending is the environment being up, not the run being over.** The
 *    session is kept alive deliberately; treating `done` as terminal would kill the
 *    thing the run exists to hold.
 */

/** A session that starts nothing, and records what was done to it in what order. */
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
  /** Every pid handed to the reaper, in order, interleaved with kills via each session's log. */
  reaped: number[];
}

function build(
  over: {
    instruction?: string;
    /** Blank by default, so a stop takes the unconfigured path and needs no turn. */
    stopInstruction?: string;
    /** Blank by default, so an interrupted run settles rather than being brought back. */
    resumeInstruction?: string;
    stopTimeoutMs?: number;
    /** Two hours by default, as the default config says. `0` is no bound at all. */
    resumeWindowMs?: number;
    refreshInstruction?: string;
    url?: string;
    ref?: string | null;
    parts?: PlanPart[];
    /** A second runner over the same database — a restart, where the row is live and nothing holds it. */
    store?: Store;
    /**
     * What this runner thinks the time is, in ms. Held rather than read, so a test can
     * put a boot two hours after the interruption without sleeping through one.
     */
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
      // Recorded on the session too, so the *ordering* against `kill` is assertable
      // rather than merely the fact that both happened.
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
  // The operator reading this is the one who can fix it, and it is a config field
  // precisely so they can — without a restart.
  assert.match(result.ok ? '' : result.error, /localRun\.instruction/);
  assert.equal(store.currentLocalRun(), null, 'a refusal records nothing at all');
  store.close();
});

test('a start prepares the checkout, writes the run, and tells the session what to do', async () => {
  const { runner, store, worktrees, sessions } = build({ ref: 'issue/284/viewer', url: 'http://localhost:4200' });
  const result = await runner.start('issue:284');
  assert.ok(result.ok, result.ok ? '' : result.error);

  // The directory came from the manager rather than being chosen here: that class is
  // the only thing that hands one out.
  assert.deepEqual(worktrees.previewed, ['issue/284/viewer']);
  const run = store.liveLocalRun();
  assert.equal(run?.originRef, 'issue:284');
  assert.equal(run?.ref, 'issue/284/viewer');
  assert.equal(run?.pid, 4242);
  assert.equal(run?.status, 'starting');
  // The URL is frozen as configured at the start, so a later config edit does not
  // rewrite what this run reported.
  assert.equal(run?.url, 'http://localhost:4200');

  // The operator's instruction, with the harness's rules **appended** rather than
  // interpolated — an instruction that had to remember them would be one edit from
  // dropping one, and each is a way for the run to break looking like something else.
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
  // Nothing was killed. The session is held open on purpose: the dev server is its
  // child, and a runner that treated `done` as terminal would take it down at the
  // moment it came up.
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

  // A page of that phase's own output is not a new stage: "starting the containers"
  // is still the true answer for as long as the containers are starting. This is the
  // whole reason the line is *asked for* rather than inferred from the last thing
  // the session said.
  session?.emit('output', 'postgres ready\nredis ready\n');
  assert.equal(runner.phase(), 'starting the containers');

  // Decoration is the common case rather than the odd one — what comes back is a
  // model's prose, and a bullet or a bolded label is how the line usually arrives.
  session?.emit('output', '- **phase:** building the services\n');
  assert.equal(runner.phase(), 'building the services');

  // And every line is still in the tail. The stage is a caption on the output, not
  // a replacement for it.
  assert.equal(runner.output().length, 4);
  store.close();
});

test('the stage goes when the environment comes up, and when the run is stopped', async () => {
  const { runner, store, sessions } = build();
  await runner.start('issue:284');
  sessions[0]?.emit('output', 'phase: starting the web app\n');
  assert.equal(runner.phase(), 'starting the web app');

  // The turn ending is the environment being up, so there is nothing in flight to
  // caption. Left standing, the last step of a bring-up would describe a finished
  // one for as long as it ran.
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
  // The reason is the case an operator actually hits, so it is kept on the row —
  // a panel that said `failed` with nowhere to look sends them back to a terminal.
  assert.match(last?.note ?? '', /EADDRINUSE/);
  store.close();
});

/**
 * **A dev environment is not a process tree**, which is the whole reason a stop is a
 * turn. Reaping the session's subtree is right and cannot touch a Docker container —
 * it belongs to the daemon — so the row read `stopped` while the containers ran on.
 */
test('a stop runs the stop instruction, then reaps', async () => {
  const { runner, store, sessions } = build({ stopInstruction: 'Run /dev-environment stop.' });
  await runner.start('issue:284');
  const session = sessions[0];

  const stopping = runner.stop();
  // Told to, before anything is killed: the session that started it is the one that
  // knows what it started, and it is still alive to be asked.
  const told = session?.sent[1] ?? '';
  assert.match(told, /^Run \/dev-environment stop\./);
  assert.match(told, /Stop everything that start brought up/);
  assert.equal(store.currentLocalRun()?.status, 'stopping', 'and the run says so while it happens');
  assert.deepEqual(session?.log, ['start'], 'nothing is killed until the instruction has run');

  session?.emit('output', 'stopped 6 containers; port 5173 is free\n');
  session?.emit('done');
  await stopping;

  // The reap is after the instruction and still before the kill.
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

  // The session is killed, which is all a signal can do — and the row says so rather
  // than claiming an environment came down. Blank is a supported state: plenty of
  // projects are one process, where the reap *is* the whole story.
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
  // Nothing is emitted: the session takes the instruction and never comes back. A
  // harness that waited for ever here could never start anything again, because a
  // swap waits for the stop.
  await runner.stop();

  assert.deepEqual(sessions[0]?.log, ['start', 'reap', 'kill']);
  assert.match(store.currentLocalRun()?.note ?? '', /did not finish within/);
  store.close();
});

test('a stop with no session left spawns one in the run’s own checkout', async () => {
  const first = build({ stopInstruction: 'Run /dev-environment stop.' });
  await first.runner.start('issue:284');
  const dir = first.store.liveLocalRun()?.dir ?? '';

  // A second runner over the same database: the row is live and nothing in memory
  // holds it, which is exactly the state a restart leaves behind. This is the case
  // that hurt most — the containers are up, the harness knows of nothing holding
  // them, and a swap would have started a second stack on the same ports.
  const after = build({ store: first.store, stopInstruction: 'Run /dev-environment stop.' });
  const stopping = after.runner.stop();
  const spawned = after.sessions[0];
  assert.ok(spawned, 'a session was spawned to do the stopping');
  assert.equal(spawned.spec.cwd, dir, 'in the checkout the run was using');
  // Told outright that it did not start this: left to infer it, a session finds
  // nothing of its own running and reasonably reports there is nothing to do.
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
  // The stop is in flight and the checkout has **not** been re-pointed. The order is
  // load-bearing: the stop instruction runs in this checkout, and `ensurePreview` is
  // a `reset --hard` and a `clean -fd` on the same directory — preparing first pulls
  // the compose file out from under the session being asked to shut it down.
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

  // The store's own rule, not the runner's: `stopping` has to be in the live set in
  // every statement that reads it, or a second run begins beside one being torn down.
  // And a restart cannot vouch for it either — a second runner over the same database
  // is what a boot sees.
  const after = build({ store, resumeInstruction: 'Run /dev-environment continue.' });
  const settled = after.runner.resumeInterrupted();
  assert.equal(settled.outcome, 'settled');
  assert.equal(store.liveLocalRun(), null);
  // Settled even though this deployment *can* bring a run back, because a teardown in
  // flight is an operator who asked for this environment to go away. Bringing it back
  // answers the opposite of the last thing they said.
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

  // No turn: Ctrl-C and the upgrade handoff are the two paths that must not hang, and
  // an upgrade is a restart. The cost is a container that outlives the harness, which
  // the note is what makes visible on the next boot.
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
  // The order is the assertion, not the pair. Descendants are resolved through the
  // root pid, so a reap after the process dies finds nothing — and on Windows the
  // surviving shell then makes the checkout unremovable for good.
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
  // The old session is gone, subtree first.
  assert.deepEqual(sessions[0]?.log, ['start', 'reap', 'kill']);
  assert.equal(sessions.length, 2);
  store.close();
});

test('a restart settles a run it cannot bring back, and names the field that would', () => {
  const { runner, store } = build();
  store.beginLocalRun({ originRef: 'issue:284', ref: 'main', dir: '/tmp/x', commit: 'abc123', url: null });
  assert.equal(store.liveLocalRun()?.originRef, 'issue:284');

  // A row saying `running` after a restart describes a process this harness never
  // spawned — the pid belongs to something dead, or to whatever has since been given
  // that number. With nothing configured to bring it back it is settled rather than
  // trusted, which is the behaviour every deployment had before the third instruction.
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
  // The shutdown: the session and its subtree go, and the row is deliberately left
  // standing — nothing else records that there is an environment to come back to.
  first.runner.stopFast('the harness shut down');
  assert.deepEqual(first.sessions[0]?.log, ['start', 'reap', 'kill']);
  const held = first.store.liveLocalRun();
  assert.ok(held, 'the row outlives the process it was holding');
  assert.match(held.note ?? '', /next boot/);

  // The boot: a second runner over the same database, which is what a restart is.
  const after = build({ store: first.store, resumeInstruction: 'Run /dev-environment continue.' });
  const outcome = after.runner.resumeInterrupted();
  assert.equal(outcome.outcome, 'resumed');
  const brought = after.sessions[0];
  assert.ok(brought, 'a session was spawned to bring it back');
  assert.equal(brought.spec.cwd, dir, 'in the checkout the run was already using');
  // Not the start instruction: attaching to what survived a reap is a different
  // sentence from starting from nothing, and only the project knows which of its
  // pieces survive one.
  assert.match(brought.sent[0] ?? '', /continue/);
  assert.match(brought.sent[0] ?? '', /You did not start this/);
  assert.match(brought.sent[0] ?? '', /not a collision/);
  // **Nothing prepared.** `ensurePreview` is a `reset --hard` and a `clean -fd`, and
  // running it here would pull the project out from under containers that are still
  // up — the swap's stop-before-prepare hazard, pointed the other way.
  assert.deepEqual(after.worktrees.previewed, [], 'the checkout already stands at the run’s own commit');
  assert.equal(after.store.liveLocalRun()?.id, held.id, 'the same run, continued — not a second one');

  // And the turn ending means the environment is up again, exactly as on a start.
  brought.emit('done');
  assert.equal(after.store.liveLocalRun()?.status, 'running');
  first.store.close();
});

/**
 * The resume window: what stops a boot bringing back an environment nobody has been
 * near since yesterday.
 *
 * A resume is for a *restart* — an Apply, a Ctrl-C, an upgrade handoff — where the
 * operator wants their environment back in a minute and the containers the reap could
 * not touch are still up. A harness that was off overnight has neither: the machine
 * has probably been rebooted, and what the boot does is spend a session on an
 * environment nobody asked for. The row is still live either way, which is why the
 * age has to be recorded rather than inferred.
 */
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

  // The boot, three hours later. The row still says live, which is exactly the state
  // the old behaviour trusted.
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
  // The stamp described an interruption that has now been answered. Left on, the next
  // hard crash would be dated to *this* one — and a run interrupted a minute later
  // would be refused as an hour old.
  assert.equal(after.store.liveLocalRun()?.interruptedAt, null);
  first.store.close();
});

test('a live row with neither stamp is unknown, not recent, and is not brought back', () => {
  // The defensive end of the pair. Every row a running build writes is dated by one
  // stamp or the other — a shutdown's, or the pulse's — so this is the shape only a
  // database somebody edited, or a boot that lost both migrations, can be in. Unknown
  // is not folded into recent: the safe direction is the operator clicking Start.
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

  // A supported setting, not a loophole: a deployment whose environment really does
  // survive anything says so on the Config page and gets what it always had.
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
  // The case the interruption stamp alone cannot reach. `taskkill /F`, Task Manager's
  // End task, a power cut — none of them run a line, so `stopFast` never happens and
  // `interruptedAt` stays null. Those are the crashes a resume is most wanted for, and
  // judged on the shutdown stamp alone they are exactly the ones it refuses.
  const at = Date.parse('2026-09-02T09:00:00.000Z');
  const first = build({ resumeInstruction: 'Run /dev-environment continue.', now: () => at });
  await first.runner.start('issue:284');
  // One beat of the pulse, which is all the harness leaves behind when it is killed.
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
  // Anchored to the real clock, because `noteAlive` stamps `last_seen_at` through the
  // store's own clock and only the runner's is injected here: a fixed date read as
  // "five hours later" the day it was written and as "in the past" every day after.
  const at = Date.now();
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
  // "Last holding it" rather than "interrupted": an operator who pulled the power is
  // owed a sentence that matches what they did.
  assert.match(after.store.currentLocalRun()?.note ?? '', /last holding it 5 hours ago/);
  first.store.close();
});

test('a boot never dates a run it declined to bring back', () => {
  // The one way the pulse stamp could undo the window. `runId` is this process's claim
  // on the row, and a boot that refused the row never takes it — so a beat of the
  // refusing harness must leave the row exactly as stale as it found it. Stamping
  // "whatever is live" instead would hand the boot after this one an environment two
  // harnesses ago, freshly dated.
  const at = Date.parse('2026-09-02T09:00:00.000Z');
  const { runner, store } = build({ resumeInstruction: 'Run /dev-environment continue.', now: () => at });
  store.beginLocalRun({ originRef: 'issue:284', ref: 'main', dir: process.cwd(), commit: 'abc123', url: null });
  const before = store.liveLocalRun()?.lastSeenAt ?? null;

  runner.noteAlive();
  assert.equal(store.liveLocalRun()?.lastSeenAt, before, 'a harness holding nothing dates nothing');
  store.close();
});

test('a pulse dates the run the harness is holding, at the buildSystem seam', async () => {
  // The wiring, rather than the rule: the stamp is only worth anything if something
  // actually calls it every beat. The heartbeat interval is enormous here, so the one
  // cycle this drives is the only one.
  const root = mkdtempSync(join(tmpdir(), 'lubbdubb-local-run-pulse-'));
  // On a file rather than in memory, so the row can be **backdated** from a second
  // handle: two timestamps a millisecond apart would make "it advanced" an assertion
  // that passes whether or not anything wrote.
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
      // Without this the test cuts a real branch in this checkout — see CLAUDE.md.
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
  // Structural, because the two orderings are indistinguishable from the outside on
  // any pulse that is not held — and the one that is held is the case this protects.
  // A harness sitting on a recovery decision for three hours is a harness that was up
  // for three hours: dated from the last cycle that reached the *work*, a run killed
  // at the end of that would read three hours stale and never come back.
  const text = readFileSync(new URL('../src/harness.ts', import.meta.url), 'utf8');
  const stamp = text.indexOf('localRun?.noteAlive()');
  const hold = text.indexOf('recovery?.pendingCount()');
  assert.ok(stamp > 0, 'the pulse stamps the local run it is holding');
  assert.ok(hold > 0, 'and asks the recovery hold');
  assert.ok(stamp < hold, 'the stamp comes first: a held pulse is still a live harness');
});

test('the boot that adds the stamp dates the run it is upgrading over', () => {
  // A column whose null means something needs a backfill as well, and here null means
  // "nobody knows when this was interrupted" — which the resume refuses. Right for a
  // hard crash and wrong for the one row a deployment is upgrading over: it was left
  // live by a fast stop moments ago, and refusing it would make taking this build cost
  // every operator the environment they had up at the time.
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-local-run-stamp-'));
  const file = join(dir, 'before-the-stamp.sqlite');
  const at = '2026-09-02T09:00:00.000Z';
  // Closed in the `finally`, because Windows refuses to unlink a sqlite file whose
  // handle is still open — an assertion failing above would otherwise come back as an
  // `EBUSY` from the cleanup rather than as what it was.
  let store: Store | null = null;
  try {
    const before = new Store(file);
    before.beginLocalRun({ originRef: 'issue:284', ref: 'main', dir: process.cwd(), commit: 'abc123', url: null });
    before.close();

    // Take the column away, which is the one state no fixture built from `SCHEMA` can
    // reach. The reopen runs the real `ensureColumns`, which adds it back as NULL on
    // every row already there — exactly what a deployment sees on the boot it takes
    // this build.
    const raw = new Database(file);
    raw.exec(`CREATE TABLE local_runs_pre AS SELECT id, origin_ref, ref, dir, pid, status, url, note,
                started_at, ended_at, cost_usd, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, num_turns FROM local_runs;
              DROP TABLE local_runs;
              ALTER TABLE local_runs_pre RENAME TO local_runs;`);
    raw.close();

    store = new Store(file, () => at);
    assert.equal(store.liveLocalRun()?.interruptedAt, at, 'the row this boot inherited is dated to this boot');
    // So the boot brings it back, as the build before this one would have.
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
  // Checked rather than discovered through a spawn: a bad `cwd` surfaces as an async
  // spawn error rather than a throw, so a resume would report success and then not
  // have happened.
  assert.match(store.currentLocalRun()?.note ?? '', /is gone/);
  assert.equal(store.liveLocalRun(), null);
  store.close();
});

// -- what it costs -----------------------------------------------------------

/** One cumulative report, in the shape the stream runtime emits it. */
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

  // Cumulative, as the runtime ships it: the second report is the session's whole
  // life, not its last turn. Read as a delta it would double the bill.
  session?.emit('usage', usage(0.4, 3));
  session?.emit('usage', usage(1.1, 8));

  const run = store.currentLocalRun();
  assert.equal(run?.costUsd, 1.1);
  assert.equal(run?.numTurns, 8);
  assert.equal(run?.inputTokens, 8000);
  store.close();
});

/**
 * The regression the accumulate rule exists for. A teardown by a *fresh* session
 * reports its own cumulative total, which starts at zero — folded onto the row it
 * would replace the bring-up's spend with the teardown's, downwards, and clamped as
 * a delta it would report nothing at all. Both under-report in silence.
 */
test('a teardown by a fresh session adds to the run rather than replacing it', async () => {
  const first = build({ stopInstruction: 'Run /dev-environment stop.' });
  await first.runner.start('issue:284');
  first.sessions[0]?.emit('usage', usage(2, 12));

  // A second runner over the same database: the row is live and nothing holds it,
  // which is what a restart leaves behind.
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
  // The PTY runtime has no usage channel at all, so this is every run on a
  // deployment in that mode. Null, because $0.00 would describe it as free.
  assert.equal(store.currentLocalRun()?.costUsd, null);
  assert.equal(store.currentLocalRun()?.numTurns, null);
  store.close();
});

test('a local run’s money is in the rolling window, dated', async () => {
  const { runner, store, sessions } = build();
  await runner.start('issue:284');
  sessions[0]?.emit('usage', usage(0.75, 4));

  // The same sum the cost gauges and the pets' beats read. Agents and local runs are
  // money on one account, and this is the one place the two are added.
  assert.equal(store.sumUsageCostSince('2000-01-01T00:00:00.000Z'), 0.75);
  const deltas = store.listCostDeltasSince('2000-01-01T00:00:00.000Z');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0]?.costUsd, 0.75);
  // And not among the agents' own, which the reliability breakdown joins by id.
  assert.deepEqual(store.listUsageEventsSince('2000-01-01T00:00:00.000Z'), []);
  store.close();
});

/**
 * A deployment that took this build has a `local_runs` table from before the usage
 * columns existed. `CREATE TABLE IF NOT EXISTS` never alters an existing table, so
 * without an entry in `LOCAL_RUN_COLUMNS` the columns are invisible there — every
 * read `undefined`, every write a thrown statement, and a fresh clone that passes.
 */
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
  // Where that checkout stood was never written down either: null, and the
  // freshness reading says "could not compare" rather than inventing a count.
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

// -- which ref a goal runs from ----------------------------------------------

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
  // The whole stack rather than a section of it: a part is cut from its
  // predecessor's branch, so the last unmerged one contains everything behind it.
  // The old rule returned the *first*, which showed the least of the goal's work and
  // said nothing about doing so.
  const choices = localRunChoices([
    part({ slug: 'b', seq: 2, branch: 'issue/1/b' }),
    part({ slug: 'a', seq: 1, branch: 'issue/1/a' }),
  ]);
  assert.equal(choices.target, 'issue/1/b');
  // And plan order, not the order the rows arrived in: the options are what the
  // panel draws under the tip.
  assert.deepEqual(
    choices.options.map((o) => o.ref),
    ['issue/1/a', 'issue/1/b'],
  );
});

test('merged, retired and concluded parts are never the tip, but stay on offer', () => {
  // Merged code is in the integration branch already, and a retired or concluded
  // part can still carry a branch from before it got there — which is exactly the
  // stale checkout the default avoids. They stay in `options`, labelled by status:
  // looking at what a merged part delivered is a legitimate thing to ask for.
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
  // A part nothing has dispatched has no branch to run, which is not the same as
  // having one — null sends the caller to the integration branch, and it is not an
  // option either.
  const undispatched = localRunChoices([part({ slug: 'a', seq: 1 })]);
  assert.equal(undispatched.target, null);
  assert.deepEqual(undispatched.options, []);
});

test('a goal nobody decomposed runs on its own branch, not the integration branch', () => {
  // The common simple case, and the one this could not see at all: no plan parts
  // meant no candidate branch, so a goal with an open pull request in front of you
  // started on the integration branch and said nothing about it — and the panel
  // filtered the row out, because a goal that resolves to the integration branch is
  // not offering a choice.
  const own = localRunChoices([], 'issue/284');
  assert.equal(own.target, 'issue/284');
  assert.deepEqual(own.options, [{ ref: 'issue/284', part: null }]);

  // A goal that *has* been decomposed has its current work on its parts, so the tip
  // outranks the goal's own branch — which is left on offer.
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

  // Not an allow-list and this route is a way to check out anything in the
  // repository. The refusal names the goal, because that is what makes it fixable.
  const refused = await runner.start('issue:284', 'refs/heads/somebody-elses-branch');
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.error, /issue:284/);
  assert.deepEqual(worktrees.previewed, ['issue/1/a'], 'and nothing was prepared for it');
  store.close();
});

// -- the checkout the run uses -----------------------------------------------

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
  // The dependency tree in miniature: ignored, and the only thing the warm-versus-
  // wiped distinction can be observed through.
  mkdirSync(join(dir, 'deps'), { recursive: true });
  writeFileSync(join(dir, 'deps', 'installed.txt'), 'a cold install is the thing this avoids\n');
  // Junk a previous run left behind, tracked-file edits included.
  writeFileSync(join(dir, 'app.txt'), 'scribbled over\n');
  writeFileSync(join(dir, 'scratch.txt'), 'left over\n');

  const again = (await wt.ensurePreview('feature')).dir;
  assert.equal(again, dir, 'one directory, whatever ref it is pointed at');
  // The whole point: `clean -fd` without `-x`, so dependencies survive a swap
  // between goals and the next start is warm rather than a cold install.
  assert.ok(existsSync(join(dir, 'deps', 'installed.txt')), 'ignored files survive the change of ref');
  // ...and everything else does not: tracked edits reset, untracked junk gone.
  // Trimmed: this machine checks out CRLF (`core.autocrlf`), and the subject here
  // is warm-versus-wiped, not line endings.
  assert.equal(readFileSync(join(dir, 'app.txt'), 'utf8').trim(), 'first');
  assert.ok(!existsSync(join(dir, 'scratch.txt')), 'the last run drops its leftovers');
});

test('an unresolvable ref leaves the checkout exactly as it was', async () => {
  const repo = gitRepo('lubbdubb-preview-bad-');
  const wt = new WorktreeManager(repo, join(repo, '.wt'), { size: 2, held: () => false }, join(repo, '.preview'));
  const { dir } = await wt.ensurePreview('main');
  writeFileSync(join(dir, 'kept.txt'), 'still here\n');

  // Resolved before the directory is touched, `switchOnto`'s rule: silently running
  // a different goal's code than the one asked for is the failure this refuses.
  await assert.rejects(() => wt.ensurePreview('no/such/branch'), /resolves to no commit/);
  assert.ok(existsSync(join(dir, 'kept.txt')), 'nothing was reset or cleaned on the way to the refusal');
});

test('ensurePreview reports the commit it stands at, and previewCommit resolves without touching the tree', async () => {
  const repo = gitRepo('lubbdubb-preview-commit-');
  const wt = new WorktreeManager(repo, join(repo, '.wt'), { size: 2, held: () => false }, join(repo, '.preview'));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const { dir, commit } = await wt.ensurePreview('main');
  assert.equal(commit, head, 'the run records where the checkout actually stands');

  // A refresh asks this first, and the whole reason it exists is that the answer
  // costs nothing: no reset, no clean, a file left in the tree is still there.
  writeFileSync(join(dir, 'kept.txt'), 'still here\n');
  assert.equal(await wt.previewCommit('main'), head);
  assert.ok(existsSync(join(dir, 'kept.txt')), 'resolving is not resetting');
  await assert.rejects(() => wt.previewCommit('no/such/branch'), /resolves to no commit/);
});

// -- the turn ending, in the shapes the runtime actually produces -------------

test('a turn that ends with no sentinel is the environment up', async () => {
  const { runner, store, sessions } = build();
  await runner.start('issue:284');
  assert.equal(runner.turn(), 'start');
  // The stream runtime says `stalled` for a turn that ended without a sentinel — and a
  // local run's session carries no protocol prompt, so this is the ending every one of
  // its turns produces. For three revisions nothing listened for it, and on a real
  // deployment the row sat in `starting` for the life of the environment.
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

// -- talking to the environment ----------------------------------------------

test('a message is echoed into the tail, handed to the session, and is a turn until it ends', async () => {
  const { runner, store, sessions } = build();
  await runner.start('issue:284');
  sessions[0]?.emit('stalled', '');
  const sent = runner.send('restart the api');
  assert.ok(sent.ok, sent.ok ? '' : sent.error);
  assert.equal(sessions[0]?.sent[1], 'restart the api');
  // The stream runtime renders only what comes back, so without the echo a message
  // leaves no trace on the one surface an operator is watching.
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
  // A stream session queues the message behind the bring-up turn, so `running` would
  // arrive only when *this* turn ended and the panel would say "starting" throughout.
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

  // A restart that left the row live and nothing holding it: there is no session to
  // tell, and the answer says so rather than queueing a message for nobody.
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

// -- picking up new code -----------------------------------------------------

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
  // Resolved first, then moved: `previewCommit` exists so a refresh at the tip never
  // pays for a reset it did not need.
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
  // A file held open on Windows is the real case: the reset gets partway and stops.
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
  // A second harness over the same row: live, running, and held by nobody.
  const after = build({ store, ref: 'issue/284/viewer' });
  after.worktrees.setPreviewCommit('issue/284/viewer', 'd'.repeat(40));
  const result = await after.runner.refresh();
  assert.ok(result.ok, result.ok ? '' : result.error);
  assert.equal(store.liveLocalRun()?.commit, 'd'.repeat(40), 'the git half is still done');
  assert.match(store.liveLocalRun()?.note ?? '', /nothing holds/);
  assert.equal(after.sessions.length, 0, 'and no session was spawned to be told');
  store.close();
});
