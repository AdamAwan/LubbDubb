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
import { applyUpgradeAction, buildReading, upgradability, IDLE_INTENT } from '../src/selfUpdate/upgradePlan.js';
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
    commits: [{ sha: 'bbbbbbb', subject: 'Tidy the questions a dead agent leaves' }],
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
function deskFor(system: System, over: Partial<BuildStanding> = {}): UpdateDesk {
  return new UpdateDesk({
    store: system.store,
    runtimeControl: system.runtimeControl,
    errors: system.errors,
    remote: 'origin',
    branch: 'main',
    checkIntervalMs: 60_000,
    supervised: true,
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

test('a modified tracked file still refuses the upgrade, because the pull would fail', async () => {
  const { install } = behindCheckout();
  writeFileSync(join(install, 'version'), 'edited by hand\n');

  const standing = await readBuildStanding({ remote: 'origin', branch: 'main', now: at, root: install });
  assert.equal(standing.dirty, true);
  assert.match(upgradability(standing).blocked!, /uncommitted changes/);
});
