import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig, type Config } from '../src/config.js';
import { EventEmitter } from 'node:events';
import type { Spawner, StreamChild } from '../src/agents/streamJsonSession.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { UpdateDesk } from '../src/selfUpdate/updateDesk.js';
import {
  applyUpgradeAction,
  autoUpgradeStep,
  buildReading,
  upgradability,
  IDLE_INTENT,
} from '../src/selfUpdate/upgradePlan.js';
import { readBuildStanding, type BuildStanding } from '../src/selfUpdate/buildStanding.js';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpDir } from './support/gitRepo.js';

/** A headless `claude` that spawns, says nothing and never exits: enough to be interrupted. */
class SilentChild extends EventEmitter implements StreamChild {
  pid = 4321;
  stdout = { on: () => {} } as unknown as NodeJS.ReadableStream;
  stderr = null;
  stdin = { write: () => {}, end: () => {} } as unknown as NodeJS.WritableStream;
  override on(event: 'exit', cb: (code: number | null) => void): this {
    return super.on(event, cb);
  }
  kill(): void {}
}

const silentSpawner: Spawner = () => new SilentChild();

function testConfig(overrides: Partial<Config> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'stream',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    ...overrides,
  });
}

/** A standing with sensible defaults, so each test names only the field it is about. */
function standing(over: Partial<BuildStanding> = {}): BuildStanding {
  return {
    head: 'aaaaaaa',
    upstream: 'bbbbbbb',
    behind: 3,
    ahead: 0,
    commits: [
      {
        sha: 'bbbbbbb',
        author: 'A Contributor',
        authoredAt: '2026-08-16T09:00:00.000Z',
        subject: 'Tidy the questions a dead agent leaves',
      },
    ],
    dirty: false,
    branch: 'main',
    checkedAt: '2026-08-17T00:00:00.000Z',
    unavailable: null,
    ...over,
  };
}

// -- The pure half ---------------------------------------------------------

test('an update is refused when taking it would not be a clean fast-forward', () => {
  assert.equal(upgradability(standing()).can, true);
  assert.equal(upgradability(standing({ behind: 0 })).can, false);
  // The three refusals that are not "nothing to do", each of which the supervisor
  // would otherwise hit with nobody watching.
  assert.match(upgradability(standing({ dirty: true })).blocked!, /uncommitted/);
  assert.match(upgradability(standing({ ahead: 2 })).blocked!, /fast-forward/);
  assert.match(upgradability(standing({ unavailable: 'no remote' })).blocked!, /no remote/);
});

test('the gauge is quiet when current and names the count when behind', () => {
  const quiet = buildReading({ standing: standing({ behind: 0 }), intent: IDLE_INTENT, live: 0, supervised: true });
  assert.equal(quiet.state, 'current');
  assert.equal(quiet.label, 'current');

  const due = buildReading({ standing: standing(), intent: IDLE_INTENT, live: 0, supervised: true });
  assert.equal(due.state, 'behind');
  assert.equal(due.label, '3 behind');
});

test('a drain in progress outranks the standing on the gauge', () => {
  // What is happening beats how far behind we were when it was asked for — the
  // count an operator wants mid-drain is the one still to go.
  const draining = buildReading({
    standing: standing(),
    intent: { state: 'draining', targetSha: 'bbbbbbb', requestedAt: null, pausedByDrain: true },
    live: 2,
    supervised: true,
  });
  assert.equal(draining.state, 'draining');
  assert.equal(draining.label, 'draining 2');
});

test('a drain with an empty fleet is already ready', () => {
  const result = applyUpgradeAction(IDLE_INTENT, { action: 'drain' }, ctx({ live: 0 }));
  assert.ok(result.ok);
  assert.equal(result.intent.state, 'ready', 'a state that exists only to be left is not a state');
});

test('a drain records whether it was the thing that paused dispatch', () => {
  const fresh = applyUpgradeAction(IDLE_INTENT, { action: 'drain' }, ctx({ live: 1, alreadyPaused: false }));
  assert.ok(fresh.ok);
  assert.equal(fresh.intent.pausedByDrain, true);

  // The operator had already paused the fleet themselves, so cancelling this must
  // not start it dispatching again.
  const onPaused = applyUpgradeAction(IDLE_INTENT, { action: 'drain' }, ctx({ live: 1, alreadyPaused: true }));
  assert.ok(onPaused.ok);
  assert.equal(onPaused.intent.pausedByDrain, false);
});

test('apply refuses while agents are live, and says how to override it', () => {
  const refused = applyUpgradeAction(IDLE_INTENT, { action: 'apply' }, ctx({ live: 2 }));
  assert.equal(refused.ok, false);
  assert.match((refused as { error: string }).error, /2 agent\(s\) are still running/);
  assert.match((refused as { error: string }).error, /restored automatically/);

  const forced = applyUpgradeAction(IDLE_INTENT, { action: 'apply', interrupt: true }, ctx({ live: 2 }));
  assert.ok(forced.ok);
  assert.equal(forced.intent.state, 'applying');
});

test('an upgrade already going down cannot be cancelled', () => {
  const applying = { state: 'applying' as const, targetSha: null, requestedAt: null, pausedByDrain: true };
  const result = applyUpgradeAction(applying, { action: 'cancel' }, ctx({ live: 0 }));
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /too late/);
});

function ctx(over: { live: number; alreadyPaused?: boolean }) {
  return {
    upgradable: upgradability(standing()),
    live: over.live,
    alreadyPaused: over.alreadyPaused ?? false,
    targetSha: 'bbbbbbb',
    now: '2026-08-17T00:00:00.000Z',
  };
}

// -- The desk, against a real store ----------------------------------------

/** A desk on the system's own store, reading a standing the test dictates. */
function deskFor(
  system: System,
  over: Partial<BuildStanding> = {},
  opts: { autoUpdate?: boolean; drainDeadlineMs?: number; supervised?: boolean; now?: () => string } = {},
): UpdateDesk {
  return new UpdateDesk({
    store: system.store,
    runtimeControl: system.runtimeControl,
    errors: system.errors,
    remote: 'origin',
    branch: 'main',
    checkIntervalMs: 60_000,
    autoUpdate: opts.autoUpdate ?? false,
    drainDeadlineMs: opts.drainDeadlineMs ?? 0,
    supervised: opts.supervised ?? true,
    ...(opts.now ? { now: opts.now } : {}),
    read: () => Promise.resolve(standing(over)),
  });
}

test('a drain pauses dispatch, and cancelling it un-pauses', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: silentSpawner,
    errorMirror: () => {},
  });
  const desk = deskFor(system);
  await desk.check(true);

  assert.equal(system.runtimeControl.paused, false);
  assert.ok(desk.request('drain').ok);
  assert.equal(system.runtimeControl.paused, true, 'a drain stops new dispatch');
  // Nothing is live, so it is straight to ready rather than sitting in draining.
  assert.equal(system.store.readUpgradeIntent().state, 'ready');

  assert.ok(desk.request('cancel').ok);
  assert.equal(system.runtimeControl.paused, false);
  assert.equal(system.store.readUpgradeIntent().state, 'idle');
  system.store.close();
});

test('a cancel leaves a pause the operator set themselves alone', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: silentSpawner,
    errorMirror: () => {},
  });
  const desk = deskFor(system);
  await desk.check(true);

  system.runtimeControl.apply({ paused: true });
  assert.ok(desk.request('drain').ok);
  assert.ok(desk.request('cancel').ok);
  assert.equal(system.runtimeControl.paused, true, 'the upgrade only undoes its own pause');
  system.store.close();
});

test('a drain becomes ready on the pulse that finds the fleet clear', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: silentSpawner,
    errorMirror: () => {},
  });
  system.connector.inject({ kind: 'new_issue', number: 901, title: 'Add login' });
  await system.harness.runCycle('manual');
  const agent = system.store.listAgentsByStatus('starting', 'running')[0]!;

  const desk = deskFor(system);
  await desk.check(true);
  assert.ok(desk.request('drain').ok);
  assert.equal(system.store.readUpgradeIntent().state, 'draining', 'an agent is still live');

  await desk.run();
  assert.equal(system.store.readUpgradeIntent().state, 'draining', 'and still is');

  system.store.updateAgent(agent.id, { status: 'done', endedAt: new Date().toISOString() });
  await desk.run();
  assert.equal(system.store.readUpgradeIntent().state, 'ready');
  system.store.close();
});

test('an unavailable reading refuses every action, in the reason the reader gave', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: silentSpawner,
    errorMirror: () => {},
  });
  const desk = deskFor(system, { unavailable: 'LubbDubb is not running from a git checkout' });
  await desk.check(true);

  const result = desk.request('drain');
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /not running from a git checkout/);
  assert.equal(system.runtimeControl.paused, false, 'a refusal changes nothing');
  system.store.close();
});

test('apply hands off only once the intent is durable', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: silentSpawner,
    errorMirror: () => {},
  });
  const desk = deskFor(system);
  await desk.check(true);

  // The ordering that matters: a shutdown racing the write would leave the next
  // boot with interrupted agents and no record that anyone meant it.
  let stateAtHandoff: string | null = null;
  desk.onHandoff = () => {
    stateAtHandoff = system.store.readUpgradeIntent().state;
  };
  assert.ok(desk.request('apply').ok);
  assert.equal(stateAtHandoff, 'applying');
  system.store.close();
});

// -- Coming back up --------------------------------------------------------

test('an upgrade restores the agents it interrupted, without asking', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: silentSpawner,
    errorMirror: () => {},
  });
  system.connector.inject({ kind: 'new_issue', number: 901, title: 'Add login' });
  await system.harness.runCycle('manual');
  const agentId = system.store.listAgentsByStatus('starting', 'running')[0]!.id;

  // Exactly what going down for an upgrade does: the marker, then the interrupt.
  system.store.writeUpgradeIntent({
    state: 'applying',
    targetSha: 'bbbbbbb',
    requestedAt: new Date().toISOString(),
    pausedByDrain: true,
  });
  system.agents.interruptAll();
  system.recovery.detect();
  assert.equal(system.recovery.pendingCount(), 1, 'it is an orphan like any other until the marker is read');

  const settled = system.recovery.settleUpgrade();
  assert.equal(settled.restored.length, 1);
  assert.equal(settled.restored[0]!.agentId, agentId);
  assert.equal(settled.left.length, 0);
  assert.equal(system.recovery.pendingCount(), 0, 'and the pulse is not held');
  assert.equal(system.store.getAgent(agentId)!.status, 'running');
  system.store.close();
});

test('a restart that was not an upgrade restores nothing', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: silentSpawner,
    errorMirror: () => {},
  });
  system.connector.inject({ kind: 'new_issue', number: 901, title: 'Add login' });
  await system.harness.runCycle('manual');

  system.agents.interruptAll();
  system.recovery.detect();
  const settled = system.recovery.settleUpgrade();
  assert.equal(settled.restored.length, 0);
  assert.equal(settled.left.length, 1, 'an ordinary shutdown still asks');
  assert.equal(system.recovery.pendingCount(), 1);
  system.store.close();
});

test('a genuine crash inside the upgrade window is left to the operator', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: silentSpawner,
    errorMirror: () => {},
  });
  system.connector.inject({ kind: 'new_issue', number: 901, title: 'Add login' });
  await system.harness.runCycle('manual');

  system.store.writeUpgradeIntent({
    state: 'applying',
    targetSha: 'bbbbbbb',
    requestedAt: new Date().toISOString(),
    pausedByDrain: true,
  });
  // No `interruptAll`: the row still claims to be live, so detection stamps it
  // `crashed` — something killed this agent between the handoff and the restart,
  // and its work is in a state nobody has looked at.
  system.recovery.detect();

  const settled = system.recovery.settleUpgrade();
  assert.equal(settled.restored.length, 0);
  assert.equal(settled.left.length, 1);
  assert.equal(settled.left[0]!.died, 'crashed');
  assert.equal(system.recovery.pendingCount(), 1, 'the pulse is held, as it would be for any crash');
  system.store.close();
});

// -- The reading, against a real checkout -----------------------------------

/**
 * An install directory a few commits behind an upstream it can reach, both real
 * repositories: the dirty test's whole subject is what git reports, so a fake
 * would be asserting the fake.
 */
function behindCheckout(): { install: string; upstream: string } {
  const root = tmpDir('lubbdubb-install-');
  const upstream = join(root, 'upstream');
  const install = join(root, 'install');
  const git = (cwd: string, args: string[]): void => void execFileSync('git', args, { cwd });
  execFileSync('git', ['init', '-q', '-b', 'main', upstream]);
  git(upstream, ['config', 'user.email', 'test@example.com']);
  git(upstream, ['config', 'user.name', 'Test']);
  writeFileSync(join(upstream, 'version'), '1\n');
  git(upstream, ['add', 'version']);
  git(upstream, ['commit', '-q', '-m', 'the commit the install is on']);
  execFileSync('git', ['clone', '-q', upstream, install]);
  for (const n of [2, 3, 4]) {
    writeFileSync(join(upstream, 'version'), `${n}\n`);
    git(upstream, ['add', 'version']);
    git(upstream, ['commit', '-q', '-m', `release ${n}`]);
  }
  return { install, upstream };
}

const at = (): string => '2026-08-17T00:00:00.000Z';

test('an untracked file in the install directory does not take the upgrade away', async () => {
  const { install } = behindCheckout();
  // The kind of thing a long-neglected install picks up: a note, a dropped log, a
  // path a newer build writes that this checkout's `.gitignore` never learned. A
  // `pull --ff-only` over it succeeds, so the button must still be there.
  writeFileSync(join(install, 'notes.txt'), 'left here by an operator\n');

  const standing = await readBuildStanding({ remote: 'origin', branch: 'main', now: at, root: install });
  assert.equal(standing.unavailable, null);
  assert.equal(standing.behind, 3);
  assert.equal(standing.dirty, false);
  assert.equal(upgradability(standing).can, true);
});

/**
 * A desk watching a project checkout as well as its own install, each answering
 * with its own standing. The reader is told apart by `root`, which is the only
 * thing that differs between the two calls the desk makes in one pass.
 */
function deskWithProject(
  system: System,
  project: Partial<BuildStanding>,
  pull: (opts: {
    root: string;
    remote: string;
    branch: string;
  }) => Promise<{ ok: true } | { ok: false; error: string }>,
): UpdateDesk {
  return new UpdateDesk({
    store: system.store,
    runtimeControl: system.runtimeControl,
    errors: system.errors,
    remote: 'origin',
    branch: 'release',
    checkIntervalMs: 60_000,
    autoUpdate: false,
    drainDeadlineMs: 0,
    supervised: true,
    project: { root: '/repo', remote: 'origin', branch: 'main' },
    read: (opts) => Promise.resolve(opts.root === '/repo' ? standing(project) : standing()),
    pull: (opts) => pull(opts),
  });
}

test('pulling the project fast-forwards it, and re-reads so the card stops saying it is behind', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: silentSpawner,
    errorMirror: () => {},
  });
  let pulled: { root: string; remote: string; branch: string } | null = null;
  let caughtUp = false;
  const desk = new UpdateDesk({
    store: system.store,
    runtimeControl: system.runtimeControl,
    errors: system.errors,
    remote: 'origin',
    branch: 'release',
    checkIntervalMs: 60_000,
    autoUpdate: false,
    drainDeadlineMs: 0,
    supervised: true,
    project: { root: '/repo', remote: 'origin', branch: 'main' },
    read: (opts) =>
      Promise.resolve(opts.root === '/repo' ? standing({ behind: caughtUp ? 0 : 3, commits: [] }) : standing()),
    pull: (opts) => {
      pulled = opts;
      caughtUp = true;
      return Promise.resolve({ ok: true as const });
    },
  });
  await desk.check(true);

  const result = await desk.pullProject();

  assert.ok(result.ok);
  assert.deepEqual(pulled, { root: '/repo', remote: 'origin', branch: 'main' });
  // Forced, not left to the interval: the whole point of the click was to change
  // the answer, and a card still saying three are waiting is a button that looks
  // like it did nothing.
  assert.equal(result.build.project?.behind, 0);
  assert.equal(result.build.projectPull.can, false);

  system.store.close();
});

/**
 * `selfUpdate.projectAutoPull`, which is the answer to the question the Project
 * card could only ever ask: a fast-forward of a clean checkout is not a decision
 * anybody needs to make, and the project config layer arrives by exactly this
 * pull — so a clone days behind is a harness running a policy the team has already
 * changed.
 */
test('a pulse fast-forwards the project on its own when it cleanly can', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: silentSpawner,
    errorMirror: () => {},
  });
  let pulls = 0;
  let caughtUp = false;
  const desk = new UpdateDesk({
    store: system.store,
    runtimeControl: system.runtimeControl,
    errors: system.errors,
    remote: 'origin',
    branch: 'release',
    checkIntervalMs: 60_000,
    autoUpdate: false,
    drainDeadlineMs: 0,
    supervised: true,
    projectAutoPull: true,
    project: { root: '/repo', remote: 'origin', branch: 'main' },
    read: (opts) =>
      Promise.resolve(opts.root === '/repo' ? standing({ behind: caughtUp ? 0 : 3, commits: [] }) : standing()),
    pull: () => {
      pulls++;
      caughtUp = true;
      return Promise.resolve({ ok: true as const });
    },
  });

  await desk.run();
  // Not awaited by the pulse — a fast-forward nobody is waiting on must not put
  // the whole harness behind somebody's slow remote — so the assertion waits for
  // the pull rather than the cycle.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(pulls, 1);
  assert.equal(desk.reading().project?.behind, 0);

  // And it does not go round again on the next pulse: there is nothing to take.
  await desk.run();
  await new Promise((r) => setImmediate(r));
  assert.equal(pulls, 1);

  system.store.close();
});

test('auto-pull leaves a checkout it cannot fast-forward alone, and records no fault for it', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: silentSpawner,
    errorMirror: () => {},
  });
  const never = () => Promise.reject(new Error('the pull must not run'));
  // Dirty is the common one and the one the rail's row was written for: nothing
  // is broken, the harness simply will not walk over somebody's uncommitted work.
  const desk = new UpdateDesk({
    store: system.store,
    runtimeControl: system.runtimeControl,
    errors: system.errors,
    remote: 'origin',
    branch: 'release',
    checkIntervalMs: 60_000,
    autoUpdate: false,
    drainDeadlineMs: 0,
    supervised: true,
    projectAutoPull: true,
    project: { root: '/repo', remote: 'origin', branch: 'main' },
    read: (opts) => Promise.resolve(opts.root === '/repo' ? standing({ dirty: true }) : standing()),
    pull: never,
  });

  await desk.run();
  await new Promise((r) => setImmediate(r));

  // The refusal is not a fault. It is a thing to tell the operator once, on the
  // rail, in the place they answer things.
  assert.equal(system.store.listErrors().length, 0);
  assert.equal(desk.reading().projectPull.can, false);
  assert.match(desk.reading().projectPull.blocked ?? '', /uncommitted changes/);

  system.store.close();
});

test('auto-pull off leaves the checkout to the operator', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: silentSpawner,
    errorMirror: () => {},
  });
  const desk = deskWithProject(system, { behind: 3, commits: [] }, () =>
    Promise.reject(new Error('the pull must not run')),
  );

  await desk.run();
  await new Promise((r) => setImmediate(r));

  // `deskWithProject` leaves `projectAutoPull` unset, which is the shape an
  // embedded harness and every older test have — and it must mean *off* rather
  // than a pull nobody asked for.
  assert.equal(desk.reading().projectAutoPull, false);
  assert.equal(desk.reading().project?.behind, 3);

  system.store.close();
});

/**
 * Snooze, which is the whole of what makes the rail's update asks answerable
 * rather than furniture: an ask you can put down is one you can be shown.
 */
test('a snooze hides one ask for its window, and never the other', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: silentSpawner,
    errorMirror: () => {},
  });
  const desk = new UpdateDesk({
    store: system.store,
    runtimeControl: system.runtimeControl,
    errors: system.errors,
    remote: 'origin',
    branch: 'main',
    checkIntervalMs: 60_000,
    autoUpdate: false,
    drainDeadlineMs: 0,
    supervised: true,
    snoozeMs: 30 * 60 * 1000,
    read: () => Promise.resolve(standing()),
  });
  await desk.check(true);
  assert.deepEqual(desk.reading().snoozedUntil, { upgrade: null, projectPull: null });

  desk.snooze('upgrade');
  const after = desk.reading().snoozedUntil;
  assert.ok(after.upgrade !== null, 'the snoozed ask carries a stamp');
  // The two are separate asks about separate repositories: putting one down says
  // nothing about the other.
  assert.equal(after.projectPull, null);
  assert.ok(Date.parse(after.upgrade) - Date.now() > 29 * 60 * 1000);

  system.store.close();
});

test('a snooze of zero is no snooze at all, so a misconfigured window cannot hide an ask forever', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: silentSpawner,
    errorMirror: () => {},
  });
  // `snoozeMs` unset reads as zero, which is the shape every older construction of
  // this desk has. The stamp has to come back null rather than as a moment already
  // past, because a surface reading "snoozed until a second ago" would be a row
  // hidden by a clock nobody set.
  const desk = deskFor(system);
  await desk.check(true);
  desk.snooze('upgrade');
  assert.equal(desk.reading().snoozedUntil.upgrade, null);
  system.store.close();
});

test('a pull is refused on a checkout that is not on the branch, dirty, or already current', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: silentSpawner,
    errorMirror: () => {},
  });
  const never = () => Promise.reject(new Error('the pull must not run'));

  // On another branch: `pull --ff-only origin main` here merges origin/main into
  // whatever is checked out, which is a different and unasked-for operation.
  const elsewhere = deskWithProject(system, { branch: 'spike/indexes' }, never);
  await elsewhere.check(true);
  const onSpike = await elsewhere.pullProject();
  assert.equal(onSpike.ok, false);
  assert.match(onSpike.ok ? '' : onSpike.error, /not main/);

  const messy = deskWithProject(system, { dirty: true }, never);
  await messy.check(true);
  const onDirty = await messy.pullProject();
  assert.equal(onDirty.ok, false);
  assert.match(onDirty.ok ? '' : onDirty.error, /uncommitted changes/);

  const current = deskWithProject(system, { behind: 0 }, never);
  await current.check(true);
  const onCurrent = await current.pullProject();
  assert.equal(onCurrent.ok, false);
  assert.match(onCurrent.ok ? '' : onCurrent.error, /nothing to pull/);

  system.store.close();
});

test('a dirty project checkout refuses the upgrade, and an unreadable one does not', () => {
  // The restart is what makes this the build's business: it interrupts the agents
  // working from that checkout, and uncommitted work sitting in it is work nobody
  // has claimed.
  const dirtyProject = upgradability(standing(), standing({ dirty: true }));
  assert.equal(dirtyProject.can, false);
  assert.match(dirtyProject.blocked!, /project checkout has uncommitted changes/);

  // A project reading nobody could take is a second opinion about a different
  // repository. Letting it take the button away would park a fleet over a fact
  // that has nothing to do with the build.
  assert.equal(upgradability(standing(), standing({ unavailable: 'could not reach origin/main' })).can, true);
  assert.equal(upgradability(standing(), null).can, true);
  assert.equal(upgradability(standing()).can, true);
});

test('the reading carries the project standing beside the build it gates', () => {
  const project = standing({ dirty: true, behind: 2 });
  const reading = buildReading({ standing: standing(), intent: IDLE_INTENT, live: 0, supervised: true, project });

  assert.equal(reading.project, project);
  assert.equal(reading.upgradable, false);
  // The card beside it draws `blocked`, and it has to name the *other* checkout —
  // a build panel with no buttons and no reason is the refusal it was built
  // to word going missing.
  assert.match(reading.blocked!, /project checkout/);
  // Absent, nothing about the build changes.
  assert.equal(buildReading({ standing: standing(), intent: IDLE_INTENT, live: 0, supervised: true }).project, null);
});

test('each waiting commit carries who wrote it and when, newest first', async () => {
  const { install } = behindCheckout();

  const standing = await readBuildStanding({ remote: 'origin', branch: 'main', now: at, root: install });

  // The changelog is the card's whole reason to exist, and a subject with no name
  // and no age beside it is the gauge again with more words.
  assert.deepEqual(
    standing.commits.map((c) => c.subject),
    ['release 4', 'release 3', 'release 2'],
  );
  for (const commit of standing.commits) {
    assert.equal(commit.author, 'Test');
    // Parseable rather than a fixed string: the checkout stamps its own clock, and
    // what the cockpit needs is something `relTime` can subtract.
    assert.ok(Number.isFinite(new Date(commit.authoredAt).getTime()), commit.authoredAt);
  }
});

test('a modified tracked file still refuses the upgrade, because the pull would fail', async () => {
  const { install } = behindCheckout();
  writeFileSync(join(install, 'version'), 'edited by hand\n');

  const standing = await readBuildStanding({ remote: 'origin', branch: 'main', now: at, root: install });
  assert.equal(standing.dirty, true);
  assert.match(upgradability(standing).blocked!, /uncommitted changes/);
});

// -- Taking it unasked -----------------------------------------------------

function autoCtx(over: Partial<Parameters<typeof autoUpgradeStep>[0]> = {}) {
  return {
    intent: IDLE_INTENT,
    upgradable: upgradability(standing()),
    live: 0,
    supervised: true,
    drainDeadlineMs: 0,
    drainingForMs: null,
    ...over,
  };
}

test("an automatic upgrade asks for the operator's two transitions, in order", () => {
  assert.equal(autoUpgradeStep(autoCtx())?.action, 'drain');
  const ready = { state: 'ready' as const, targetSha: 'bbbbbbb', requestedAt: null, pausedByDrain: true };
  assert.equal(autoUpgradeStep(autoCtx({ intent: ready }))?.action, 'apply');
  // And never the override: `autoUpdate` authorizes the ordinary path, not the forced one.
  assert.equal(autoUpgradeStep(autoCtx({ intent: ready }))?.interrupt, undefined);
});

test('an automatic upgrade does nothing at all without a supervisor', () => {
  // The handoff is an exit. With nothing in front of the process to relaunch it,
  // that is the fleet going down and staying down, on a machine nobody is watching.
  assert.equal(autoUpgradeStep(autoCtx({ supervised: false })), null);
  const ready = { state: 'ready' as const, targetSha: null, requestedAt: null, pausedByDrain: true };
  assert.equal(autoUpgradeStep(autoCtx({ intent: ready, supervised: false })), null);
});

test('an automatic upgrade still takes every refusal the button takes', () => {
  assert.equal(autoUpgradeStep(autoCtx({ upgradable: upgradability(standing({ dirty: true })) })), null);
  assert.equal(autoUpgradeStep(autoCtx({ upgradable: upgradability(standing({ ahead: 2 })) })), null);
  assert.equal(autoUpgradeStep(autoCtx({ upgradable: upgradability(standing({ behind: 0 })) })), null);
});

test('a drain past its deadline stops waiting and interrupts what is left', () => {
  const draining = {
    state: 'draining' as const,
    targetSha: 'bbbbbbb',
    requestedAt: '2026-08-17T00:00:00.000Z',
    pausedByDrain: true,
  };
  const base = { intent: draining, live: 1, drainDeadlineMs: 60 * 60 * 1000 };

  // Inside the deadline it waits, which is the whole point of a drain.
  assert.equal(autoUpgradeStep(autoCtx({ ...base, drainingForMs: 59 * 60 * 1000 })), null);

  const forced = autoUpgradeStep(autoCtx({ ...base, drainingForMs: 61 * 60 * 1000 }));
  assert.equal(forced?.action, 'apply');
  assert.equal(forced?.interrupt, true, 'the agents it stops are restored on the way back up');

  // Zero is "wait forever" — the behaviour before the deadline existed.
  assert.equal(autoUpgradeStep(autoCtx({ ...base, drainDeadlineMs: 0, drainingForMs: 1e9 })), null);
  // And a drain with no stamp to measure from waits rather than firing immediately.
  assert.equal(autoUpgradeStep(autoCtx({ ...base, drainingForMs: null })), null);
});

test('an automatic upgrade reaches the handoff on one pulse when the fleet is clear', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: silentSpawner,
    errorMirror: () => {},
  });
  const desk = deskFor(system, {}, { autoUpdate: true });
  let handed = 0;
  desk.onHandoff = () => {
    handed++;
  };

  // Drain, ready and apply are one run of the machine, not three heartbeats: a
  // state whose whole meaning is "go now" should not wait an hour to be left.
  await desk.run();
  assert.equal(system.store.readUpgradeIntent().state, 'applying');
  assert.equal(handed, 1);
  system.store.close();
});

test('an automatic upgrade waits for a live agent rather than interrupting it', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: silentSpawner,
    errorMirror: () => {},
  });
  system.connector.inject({ kind: 'new_issue', number: 901, title: 'Add login' });
  await system.harness.runCycle('manual');
  const agent = system.store.listAgentsByStatus('starting', 'running')[0]!;

  const desk = deskFor(system, {}, { autoUpdate: true });
  let handed = 0;
  desk.onHandoff = () => {
    handed++;
  };

  await desk.run();
  assert.equal(system.store.readUpgradeIntent().state, 'draining');
  assert.equal(handed, 0, 'nobody is interrupted for an update that landed mid-run');
  assert.equal(system.runtimeControl.paused, true);

  system.store.updateAgent(agent.id, { status: 'done', endedAt: new Date().toISOString() });
  await desk.run();
  assert.equal(system.store.readUpgradeIntent().state, 'applying');
  assert.equal(handed, 1);
  system.store.close();
});

test('the desk stops waiting once an automatic drain outruns its deadline', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: silentSpawner,
    errorMirror: () => {},
  });
  system.connector.inject({ kind: 'new_issue', number: 901, title: 'Add login' });
  await system.harness.runCycle('manual');

  let clock = '2026-08-17T00:00:00.000Z';
  const desk = deskFor(system, {}, { autoUpdate: true, drainDeadlineMs: 60 * 60 * 1000, now: () => clock });
  let handed = 0;
  desk.onHandoff = () => {
    handed++;
  };

  await desk.run();
  assert.equal(system.store.readUpgradeIntent().state, 'draining');

  clock = '2026-08-17T02:00:00.000Z';
  await desk.run();
  assert.equal(system.store.readUpgradeIntent().state, 'applying', 'the drain stopped waiting');
  assert.equal(handed, 1);
  system.store.close();
});

// -- The pause the upgrade must not lose -----------------------------------

test('an upgrade hands the operator back the pause they had, not the configured one', async () => {
  // `RuntimeControl` is not persisted, so without this the fleet comes back on
  // `config.startPaused` — a cold-boot default overruling a live decision, in both
  // directions and silently in each.
  const system = buildSystem(testConfig({ startPaused: false }), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: silentSpawner,
    errorMirror: () => {},
  });
  const desk = deskFor(system);
  await desk.check(true);

  // The operator had parked the fleet themselves before the upgrade.
  system.runtimeControl.apply({ paused: true });
  assert.ok(desk.request('drain').ok);
  assert.ok(desk.request('apply').ok);

  // The restart: a fresh control seeded from the config, as `buildSystem` does.
  system.runtimeControl.apply({ paused: false });
  assert.equal(desk.restorePause(), true, 'their pause survives the upgrade');
  assert.equal(system.runtimeControl.paused, true);
  system.store.close();
});

test('an upgrade the drain paused comes back dispatching', async () => {
  const system = buildSystem(testConfig({ startPaused: true }), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: silentSpawner,
    errorMirror: () => {},
  });
  const desk = deskFor(system);
  await desk.check(true);

  // The fleet was running; the drain is what stopped it. `startPaused` is a
  // cold-boot policy and has no say in a restart that is really a handover.
  system.runtimeControl.apply({ paused: false });
  assert.ok(desk.request('drain').ok);
  assert.ok(desk.request('apply').ok);

  system.runtimeControl.apply({ paused: true });
  assert.equal(desk.restorePause(), false);
  assert.equal(system.runtimeControl.paused, false);
  system.store.close();
});

test('an apply straight from idle records the pause it actually found', () => {
  // There is no drain on this path to inherit the answer from, and the resting
  // `false` would tell the next boot the operator had parked a fleet they had not.
  const fresh = applyUpgradeAction(IDLE_INTENT, { action: 'apply', interrupt: true }, ctx({ live: 2 }));
  assert.ok(fresh.ok);
  assert.equal(fresh.intent.pausedByDrain, true);

  const onPaused = applyUpgradeAction(
    IDLE_INTENT,
    { action: 'apply', interrupt: true },
    ctx({ live: 2, alreadyPaused: true }),
  );
  assert.ok(onPaused.ok);
  assert.equal(onPaused.intent.pausedByDrain, false);
});

test('a restart that was not an upgrade leaves the configured pause alone', async () => {
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: silentSpawner,
    errorMirror: () => {},
  });
  const desk = deskFor(system);
  assert.equal(desk.restorePause(), null, 'an operator who killed the server is asking a different question');
  assert.equal(system.runtimeControl.paused, false);
  system.store.close();
});
