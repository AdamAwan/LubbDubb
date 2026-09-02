import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig, type Config } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { WorldSnapshot } from '../src/types.js';
import { isActiveTask } from '../src/tasks.js';

/**
 * The **manual** cycle: the one a route runs because an operator just said
 * something — "more work", a watch, an unblock — and the only out-of-band source
 * with no trigger of its own to retry it.
 *
 * → `docs/spec/04-harness-cycle.md#coalescing`
 */

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function testConfig(overrides: Partial<Config> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    // Long enough that nothing here is ever the timer's doing.
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    ...overrides,
  });
}

function build(overrides: Partial<Config> = {}): System {
  return buildSystem(testConfig(overrides), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) return;
    await tick(10);
  }
}

/**
 * Hold a cycle open *after* its world read, so the in-flight cycle decides against
 * the world as it stood when it started — which is what makes the work injected
 * behind it work only the trailing cycle can reach.
 */
function gateAfterRead(system: System): () => void {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const connector = system.connector as { getState: () => Promise<WorldSnapshot> };
  const original = connector.getState.bind(system.connector);
  connector.getState = async (): Promise<WorldSnapshot> => {
    const snapshot = await original();
    await gate;
    return snapshot;
  };
  return release;
}

test("an operator's cycle refused mid-flight is run again once the flight ends", async () => {
  const system = build();
  // A first real cycle, so there is a baseline and the world read below is not the
  // first one.
  await system.harness.runCycle('manual');

  const release = gateAfterRead(system);
  const inFlight = system.harness.runCycle('timer');
  await tick(20);

  // The operator's write lands *behind* the in-flight cycle's reading of the world,
  // which is exactly the race: nothing that cycle decides can see it.
  system.connector.inject({ kind: 'new_issue', number: 903, title: 'Work this one' });
  const refused = await system.harness.runCycle('manual');
  assert.equal(refused.cycleId, 'coalesced', 'it is still refused — one cycle at a time');

  release();
  await inFlight;
  assert.equal(system.store.listTasks().length, 0, 'the cycle that was already running could not see it');

  await waitFor(() => system.store.listTasks().length > 0);
  assert.equal(system.store.listTasks().length, 1, "the operator's cycle is run again rather than dropped");
  system.store.close();
});

test('a burst of refused operator cycles is one trailing cycle, not one each', async () => {
  const system = build();
  await system.harness.runCycle('manual');

  let reads = 0;
  const connector = system.connector as { getState: () => Promise<WorldSnapshot> };
  const original = connector.getState.bind(system.connector);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  connector.getState = async (): Promise<WorldSnapshot> => {
    reads += 1;
    const snapshot = await original();
    if (reads === 1) await gate;
    return snapshot;
  };

  const inFlight = system.harness.runCycle('timer');
  await tick(20);
  for (let i = 0; i < 5; i += 1) assert.equal((await system.harness.runCycle('manual')).cycleId, 'coalesced');

  release();
  await inFlight;
  await waitFor(() => reads > 1);
  await tick(50);
  assert.equal(reads, 2, 'the five refusals coalesce into one cycle, as the in-flight guard already promises');
  system.store.close();
});

test('a harness on its way down does not fire a trailing cycle into a closing store', async () => {
  const system = build();
  await system.harness.runCycle('manual');

  const release = gateAfterRead(system);
  const inFlight = system.harness.runCycle('timer');
  await tick(20);
  system.connector.inject({ kind: 'new_issue', number: 904, title: 'Too late' });
  await system.harness.runCycle('manual');

  // What `main.ts` does first on a signal, and the reason the trailing cycle is
  // gated on it: everything below `harness.stop()` in that sequence ends with the
  // store handle closed.
  system.harness.stop();
  release();
  await inFlight;
  await tick(100);
  assert.equal(system.store.listTasks().length, 0, 'nothing is dispatched after the harness is stopped');
  system.store.close();
});

test('the trailing cycle puts no second agent on work already in flight', async () => {
  const system = build();
  system.connector.inject({ kind: 'new_issue', number: 905, title: 'Already in hand' });
  await system.harness.runCycle('manual');
  const before = system.store.listTasks();
  assert.ok(before.length > 0, 'the goal is staffed');

  // The operator says "more work" while that agent is still running, and says it
  // inside a cycle — so the trailing cycle is the one that answers them. What it
  // must not do is put a second agent on work already in hand. The executor's two
  // gates are store reads (`findActiveTaskByOrigin`, `findActiveTaskByBranch`) and
  // `recordDispatchTask` writes the row synchronously, before its agent is ever
  // spawned — so a cycle that starts the instant another ends reads every row the
  // one before it wrote. Back-to-back is not a new shape either: the local trigger
  // has always fired one a quarter-second after an agent ends.
  const release = gateAfterRead(system);
  const inFlight = system.harness.runCycle('timer');
  await tick(20);
  assert.equal((await system.harness.runCycle('manual')).cycleId, 'coalesced');

  release();
  await inFlight;
  await tick(150);

  // Stated as the invariant rather than as a count, because more work being
  // *started* is the point of the trailing cycle — a goal's appraisal and its plan
  // are two dispatches on two branches, and both are correct. What would be wrong
  // is two agents on one of them.
  const active = system.store.listTasks().filter(isActiveTask);
  const origins = active.map((t) => t.originRef).filter((o): o is string => o !== null);
  assert.equal(new Set(origins).size, origins.length, 'no origin is staffed twice');
  const branches = active.map((t) => t.branch);
  assert.equal(new Set(branches).size, branches.length, 'and no two agents share a worktree branch');
  for (const t of before)
    assert.ok(
      active.some((a) => a.id === t.id),
      'the agent that was already running is untouched',
    );
  system.store.close();
});
