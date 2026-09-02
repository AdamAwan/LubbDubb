import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';

/**
 * The window between a plan naming a dispatch and an agent existing for it.
 *
 * `ActionExecutor.execute` walks a plan strictly serially and each dispatch waits
 * on the worktree pool, whose handover to a different branch is a `git clean
 * -ffdx` and a cold checkout — minutes on a large target repository. Three
 * dispatches planned with full headroom therefore start minutes apart, and until
 * the readying board existed the cockpit said one agent was out while the queue
 * said three had been dispatched. These tests hold the two halves of the fix: the
 * row is on the wire *while the executor is waiting*, and it is gone on every exit
 * path — including the throwing one, where a leaked row would be drawn as work in
 * flight until the harness was bounced.
 */

/** A manager whose `ensure` parks until the test lets it through. */
class ParkedWorktrees extends FakeWorktreeManager {
  /** Settles once `ensure` has been called and is waiting. */
  readonly reached: Promise<string>;
  private announce!: (branch: string) => void;
  private release!: () => void;
  private readonly gate: Promise<void>;

  constructor() {
    super();
    this.reached = new Promise<string>((resolve) => {
      this.announce = resolve;
    });
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  override async ensure(branch: string, base?: string): Promise<string> {
    this.announce(branch);
    await this.gate;
    return super.ensure(branch, base);
  }

  /** Let the handover finish. */
  letThrough(): void {
    this.release();
  }
}

/** A manager whose `ensure` fails the way the live one does when it cannot wipe a slot. */
class FailingWorktrees extends FakeWorktreeManager {
  override ensure(branch: string): Promise<string> {
    return Promise.reject(new Error(`EBUSY: resource busy or locked, rmdir '${branch}'`));
  }
}

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-readying-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 2,
  });
}

test('a dispatch waiting on the worktree pool is on the wire, as a row that is not an agent', async () => {
  const worktrees = new ParkedWorktrees();
  const system = buildSystem(testConfig(), { worktrees, backend: new FakePtyBackend() });

  const job = system.store.createJob({
    title: 'Remove the scan-check pollers',
    prompt: 'Remove them.',
    kind: 'code',
    branch: 'issue/35174/remove-scan-check-pollers',
  });

  // Deliberately not awaited: the reading this is about exists only *inside* the
  // cycle, which is the whole problem it solves.
  const cycle = system.harness.runCycle('manual');
  await worktrees.reached;

  const waiting = buildStateSnapshot(system);
  assert.equal(waiting.readying.length, 1, 'the action being readied is on the wire');
  const row = waiting.readying[0]!;
  assert.equal(row.title, 'Remove the scan-check pollers');
  assert.equal(row.originRef, `job:${job.id}`);
  assert.equal(row.branch, 'issue/35174/remove-scan-check-pollers');
  assert.equal(row.step, 'slot-handover', 'and it says what it is waiting on');
  assert.ok(Date.parse(row.startedAt) > 0, 'with something to measure the wait from');

  // And it is not an agent: nothing is out, nothing counts against the cap, and no
  // agent row exists to open, kill or inject into.
  assert.equal(waiting.agents.filter((a) => a.status !== 'done').length, 0, 'no agent row yet');
  assert.equal(system.store.countLiveAgents(), 0, 'and nothing counted against the cap');

  worktrees.letThrough();
  await cycle;

  const after = buildStateSnapshot(system);
  assert.deepEqual(after.readying, [], 'the row leaves the moment the agent starts');
  assert.equal(after.agents.filter((a) => a.status !== 'done').length, 1, 'and the agent is what replaced it');

  system.store.close();
});

test('a dispatch that throws takes its readying row with it', async () => {
  const system = buildSystem(testConfig(), { worktrees: new FailingWorktrees(), backend: new FakePtyBackend() });

  system.store.createJob({
    title: 'Remove the scan-check pollers',
    prompt: 'Remove them.',
    kind: 'code',
    branch: 'issue/35174/remove-scan-check-pollers',
  });
  await system.harness.runCycle('manual');

  // The failure is audited as it always was — and the row is gone, which is the
  // point: released from a `finally`, not from the success path. A leaked entry
  // would be drawn as work in flight for the life of the process, with nothing
  // able to clear it and nothing red anywhere.
  assert.match(
    system.store.listDecisions().find((d) => d.outcome === 'rejected')!.detail,
    /Failed to start agent: EBUSY/,
  );
  assert.deepEqual(buildStateSnapshot(system).readying, []);

  system.store.close();
});

test('the board announces itself, so a cockpit sees the row without waiting for the pulse to end', async () => {
  const worktrees = new ParkedWorktrees();
  const system = buildSystem(testConfig(), { worktrees, backend: new FakePtyBackend() });

  // The signal is what makes the row reach a browser at all: the pulse's own
  // frames bracket the executor — `cycle:start` before the first action is picked
  // up, `cycle:end` after the last is let go — so with nothing in between the
  // whole readying window falls between two broadcasts.
  const steps: string[] = [];
  system.readying.on('changed', () => steps.push(system.readying.list()[0]?.step ?? 'none'));

  system.store.createJob({ title: 'Look into it', prompt: 'Look into it.', kind: 'code', branch: 'issue/1/look' });
  const cycle = system.harness.runCycle('manual');
  await worktrees.reached;
  worktrees.letThrough();
  await cycle;

  assert.deepEqual(steps, ['picked-up', 'ci-evidence', 'slot-handover', 'none']);

  system.store.close();
});
