import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system/system.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FleetStallWatch } from '../src/fleetStall.js';
import type { Decision, ErrorLogInput } from '../src/types.js';
import { workedAsOnePart } from './support/plans.js';

// Work above the cut-line, room under the cap, and nothing started — whatever the cause.
// → docs/spec/04-harness-cycle.md#when-the-fleet-stops-dispatching

class RefusingWorktrees extends FakeWorktreeManager {
  refusing = true;

  override ensure(branch: string, base?: string): Promise<string> {
    if (!this.refusing) return super.ensure(branch, base);
    return Promise.reject(new Error(`No free worktree slot for branch ${branch}: the pool bound is stale.`));
  }
}

const ORIGIN = 'issue:951:part:whole';

function stallingSystem(worktrees: FakeWorktreeManager, fleetStallCycles = 3): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-stall-'));
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      fleetStallCycles,
    }),
    { worktrees, backend: new FakePtyBackend(), errorMirror: () => {} },
  );
  system.connector.inject({ kind: 'new_issue', number: 951, title: 'Add login' });
  workedAsOnePart(system.store, 951);
  return system;
}

function stallErrors(system: System): number {
  return system.store.errors.listErrors().filter((e) => /started nothing/.test(e.message)).length;
}

function stallRow(system: System) {
  return buildStateSnapshot(system).asks.find((r) => r.kind === 'fleet_stall');
}

async function pulses(system: System, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await system.harness.runCycle('manual');
}

async function untilRefused(system: System): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await system.harness.runCycle('manual');
    if (system.harness.upcoming?.items.some((it) => it.origin === ORIGIN && it.status === 'dispatching')) return;
  }
  assert.fail(`${ORIGIN} never reached the cut-line`);
}

test('a fleet with work and room that starts nothing is raised once, and clears when a dispatch gets through', async () => {
  const worktrees = new RefusingWorktrees();
  const system = stallingSystem(worktrees);

  await untilRefused(system);
  await pulses(system, 1);
  assert.equal(system.fleetStall.reading(), null, 'two stalled cycles are not yet a stall');
  assert.equal(stallRow(system), undefined);

  await pulses(system, 1);
  const stall = system.fleetStall.reading();
  assert.ok(stall, 'three cycles running with nothing started is a stall');
  assert.deepEqual(stall.candidates, [ORIGIN]);
  assert.match(stall.refusal ?? '', /pool bound is stale/, 'it carries the refusal that is the likeliest cause');
  assert.equal(stallErrors(system), 1);
  const row = stallRow(system);
  assert.ok(row, 'and it is on the Needs you rail');
  assert.equal(row.group, 'blocking');
  assert.equal(row.urgency, 'now');

  await pulses(system, 3);
  assert.equal(stallErrors(system), 1, 'one entry per episode, however long it lasts');
  assert.equal(system.fleetStall.reading()?.cycles, 6);

  worktrees.refusing = false;
  await pulses(system, 1);
  assert.ok(
    system.store.agents.listAgentsByStatus('starting', 'running').length > 0,
    'the dispatch went through once the pool relented',
  );
  assert.equal(system.fleetStall.reading(), null, 'a dispatch that gets through ends the episode');
  assert.equal(stallRow(system), undefined, 'and the row clears itself');

  system.store.close();
});

test('a paused fleet is not a stalled one', async () => {
  const system = stallingSystem(new RefusingWorktrees());
  await untilRefused(system);
  system.runtimeControl.apply({ paused: true });
  await pulses(system, 6);
  assert.equal(system.fleetStall.reading(), null);
  assert.equal(stallErrors(system), 0);
  system.store.close();
});

test('fleetStallCycles 0 turns the alarm off', async () => {
  const system = stallingSystem(new RefusingWorktrees(), 0);
  await untilRefused(system);
  await pulses(system, 6);
  assert.equal(system.fleetStall.reading(), null);
  assert.equal(stallErrors(system), 0);
  system.store.close();
});

function refused(cycle: number): Decision {
  return {
    id: `dec_${cycle}`,
    cycleId: `cyc_${cycle}`,
    action: {
      type: 'dispatch_code_agent',
      branch: 'b',
      title: 't',
      prompt: 'p',
      originRef: ORIGIN,
      reason: 'r',
    },
    outcome: 'rejected',
    detail: 'Failed to start agent: no slot',
    rule: null,
    admission: null,
    createdAt: new Date(cycle * 1000).toISOString(),
  } as Decision;
}

test('a second stall after a recovery is a second episode, and a usage-limit park is not one', () => {
  const recorded: ErrorLogInput[] = [];
  const watch = new FleetStallWatch({
    errors: { record: (e) => (recorded.push(e), { ...e, id: 'e', createdAt: '', detail: e.detail ?? null }) },
    afterCycles: 2,
  });
  const cycle = (i: number, over: { limitParked?: boolean; started?: boolean } = {}) =>
    watch.observe({
      at: new Date(i * 1000).toISOString(),
      dispatching: [ORIGIN],
      paused: false,
      limitParked: over.limitParked ?? false,
      decisions: over.started ? [{ ...refused(i), outcome: 'executed' }] : [refused(i)],
    });

  cycle(1, { limitParked: true });
  cycle(2, { limitParked: true });
  cycle(3, { limitParked: true });
  assert.equal(watch.reading(), null, 'agents parked on the account limit explain an idle fleet');

  cycle(4);
  cycle(5);
  assert.equal(recorded.length, 1);
  cycle(6, { started: true });
  assert.equal(watch.reading(), null);
  cycle(7);
  cycle(8);
  assert.equal(recorded.length, 2, 'a new episode is raised again');
  assert.equal(watch.reading()?.since, new Date(7000).toISOString());
});
