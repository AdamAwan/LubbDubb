import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { WorktreeManager } from '../src/worktree/worktreeManager.js';
import { gitRepo } from './support/gitRepo.js';
import { Store } from '../src/store/store.js';
import { LocalRunner } from '../src/localRun/runner.js';
import { localRunChoices } from '../src/localRun/ref.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
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
    stopTimeoutMs?: number;
    url?: string;
    ref?: string | null;
    parts?: PlanPart[];
    /** A second runner over the same database — a restart, where the row is live and nothing holds it. */
    store?: Store;
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
      url: over.url ?? '',
    }),
    claudeCommand: 'claude',
    claudeArgs: [],
    permissionMode: 'acceptEdits',
    defaultBranch: 'main',
    stopTimeoutMs: over.stopTimeoutMs,
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
  const settled = store.endStaleLocalRuns('the harness restarted');
  assert.equal(settled, 1, 'a stopping row is one a restart cannot vouch for either');

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

test('a restart settles the rows it cannot vouch for', () => {
  const store = new Store(':memory:');
  store.beginLocalRun({ originRef: 'issue:284', ref: 'main', dir: '/tmp/x', url: null });
  assert.equal(store.liveLocalRun()?.originRef, 'issue:284');

  // A row saying `running` after a restart describes a process this harness never
  // spawned — the pid belongs to something dead, or to whatever has since been given
  // that number. Settled rather than trusted.
  assert.equal(store.endStaleLocalRuns('the harness restarted'), 1);
  assert.equal(store.liveLocalRun(), null);
  assert.match(store.currentLocalRun()?.note ?? '', /restarted/);
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
  const dir = await wt.ensurePreview('main');
  // The dependency tree in miniature: ignored, and the only thing the warm-versus-
  // wiped distinction can be observed through.
  mkdirSync(join(dir, 'deps'), { recursive: true });
  writeFileSync(join(dir, 'deps', 'installed.txt'), 'a cold install is the thing this avoids\n');
  // Junk a previous run left behind, tracked-file edits included.
  writeFileSync(join(dir, 'app.txt'), 'scribbled over\n');
  writeFileSync(join(dir, 'scratch.txt'), 'left over\n');

  const again = await wt.ensurePreview('feature');
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
  const dir = await wt.ensurePreview('main');
  writeFileSync(join(dir, 'kept.txt'), 'still here\n');

  // Resolved before the directory is touched, `switchOnto`'s rule: silently running
  // a different goal's code than the one asked for is the failure this refuses.
  await assert.rejects(() => wt.ensurePreview('no/such/branch'), /resolves to no commit/);
  assert.ok(existsSync(join(dir, 'kept.txt')), 'nothing was reset or cleaned on the way to the refusal');
});
