import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig, type Config } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { fleetStatus } from '../src/mcp/desktopOps.js';
import { desktopDeps } from './support/desktop.js';
import type { WorldSnapshot } from '../src/types.js';

// A cycle that never returns takes the heartbeat with it, so nothing else is left to notice.
// → docs/spec/04-harness-cycle.md#when-a-cycle-does-not-come-back

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function testConfig(): Config {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
}

function build(): System {
  return buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
    stuckCycleAfterMs: 60,
  });
}

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

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) return;
    await tick(10);
  }
}

function status(system: System): Record<string, unknown> {
  const tool = fleetStatus(
    { ...desktopDeps(system), now: () => new Date().toISOString() },
    { label: 'test', held: null },
  );
  const result = tool.handler({}) as { content: { text: string }[] };
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

test('a cycle that does not come back is reported rather than read as an idle fleet', async () => {
  const system = build();
  const release = gateAfterRead(system);
  const inFlight = system.harness.runCycle('timer');

  await waitFor(() => system.store.errors.listErrors().some((e) => e.source === 'cycle'));
  const recorded = system.store.errors.listErrors().filter((e) => e.source === 'cycle');
  assert.equal(recorded.length, 1, 'the watchdog says it once');
  assert.match(recorded[0]!.message, /has not returned after 0s/);
  assert.match(recorded[0]!.message, /stuck at reading the world/);
  assert.match(recorded[0]!.message, /nothing is being dispatched/);

  const standing = system.harness.inFlightCycle;
  assert.ok(standing, 'the cycle in flight is readable');
  assert.equal(standing.overdue, true);
  assert.equal(standing.source, 'timer');
  assert.equal(standing.where, 'reading the world');

  const refused = await system.harness.runCycle('local');
  assert.equal(refused.cycleId, 'coalesced');
  assert.match(refused.rationale, /has been running for/, 'the refusal says why, not just "cycle already running"');

  const fleet = status(system);
  const cycle = fleet.cycle as { overdue: boolean; where: string; cycleId: string };
  assert.equal(cycle.overdue, true);
  assert.equal(cycle.where, 'reading the world');
  assert.equal(cycle.cycleId, standing.cycleId);
  const queue = fleet.queue as { note: string };
  assert.match(queue.note, /wedged harness, not an idle one/);

  release();
  await inFlight;
  assert.equal(system.harness.inFlightCycle, null, 'the standing clears with the cycle');
  assert.equal(status(system).cycle, null);
});

test('an ordinary cycle is neither flagged nor left standing', async () => {
  const system = build();
  const report = await system.harness.runCycle('manual');
  assert.ok(report.cycleId.startsWith('cyc_'));
  assert.equal(system.harness.inFlightCycle, null);
  assert.deepEqual(
    system.store.errors.listErrors().filter((e) => e.source === 'cycle'),
    [],
  );
});
