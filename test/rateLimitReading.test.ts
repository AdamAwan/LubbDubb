import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { Store } from '../src/store/store.js';
import type { Spawner, StreamChild } from '../src/agents/streamJsonSession.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { failPlanningOpen } from './support/plans.js';

/**
 * Reading the account's usage windows headless (issue #60, phase 2).
 *
 * The subscriber 5h/weekly limits used to be reachable only through Claude Code's
 * `statusLine` hook, which never fires without a TUI — so the cockpit chip was a
 * PTY-only surface and stream deployments, the default, degraded to the
 * self-computed rolling cost window. A later CLI carries the same figures on the
 * `rate_limit_event` it already emits on the stream transport, as
 * `unifiedWindows`, and this is that reading.
 *
 * **The payloads below are `claude`'s own**, taken from a real successful turn:
 * `utilization` a fraction rather than the status line's percentage, `resetsAt`
 * whole unix seconds, and the whole thing riding on a `status: "allowed"` event —
 * which is the point, and the hazard the last test guards.
 */

/** Minimal fake headless `claude`. */
class FakeChild extends EventEmitter implements StreamChild {
  pid = 555;
  writes: string[] = [];
  private out = new EventEmitter();
  stdout = { on: (ev: string, cb: (d: string) => void) => this.out.on(ev, cb) } as unknown as NodeJS.ReadableStream;
  stderr = null;
  stdin = { write: (d: string) => this.writes.push(d), end: () => {} } as unknown as NodeJS.WritableStream;
  emitLine(obj: unknown): void {
    this.out.emit('data', JSON.stringify(obj) + '\n');
  }
  rateLimit(info: Record<string, unknown>): void {
    this.emitLine({ type: 'rate_limit_event', rate_limit_info: info });
  }
  override on(event: 'exit', cb: (code: number | null) => void): this {
    return super.on(event, cb);
  }
  kill(): void {
    this.emit('exit', 143);
  }
}

/** What a real `claude` ships beside an ordinary, perfectly allowed turn. */
const ALLOWED_WITH_WINDOWS = {
  status: 'allowed',
  resetsAt: 1_787_875_800,
  rateLimitType: 'five_hour',
  overageStatus: 'rejected',
  overageDisabledReason: 'org_level_disabled',
  isUsingOverage: false,
  unifiedWindows: {
    five_hour: { utilization: 0.23, resetsAt: 1_787_875_800 },
    seven_day: { utilization: 0.19, resetsAt: 1_788_332_400 },
  },
};

async function fleet(issue: number) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-limits-'));
  const children: FakeChild[] = [];
  const spawner: Spawner = () => {
    const c = new FakeChild();
    children.push(c);
    return c;
  };
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'stream',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      auth: { enabled: false } as never,
    }),
    { worktrees: new FakeWorktreeManager(), streamSpawner: spawner, errorMirror: () => {} },
  );
  system.connector.inject({ kind: 'new_issue', number: issue, title: 'Add login' });
  failPlanningOpen(system.store, issue);
  await system.harness.runCycle('manual');
  const agent = system.store.listAgentsByStatus('starting', 'running')[0]!;
  return { system, agent, child: children[0]! };
}

test('stream mode reads the account usage windows off an ordinary turn', async () => {
  const { system, child } = await fleet(801);
  child.rateLimit(ALLOWED_WITH_WINDOWS);

  const snap = await buildStateSnapshot(system);
  const limits = snap.usage.rateLimits;
  assert.ok(limits, 'the chip has real subscriber limits without a PTY anywhere');
  // A fraction on the wire, a percentage on the glass — the shape the chip has
  // always drawn, so nothing downstream of this had to change.
  assert.equal(limits.fiveHour?.usedPercentage, 23);
  assert.equal(limits.sevenDay?.usedPercentage, 19);
  assert.equal(limits.fiveHour?.resetsAt, new Date(1_787_875_800 * 1000).toISOString());
  assert.equal(limits.sevenDay?.resetsAt, new Date(1_788_332_400 * 1000).toISOString());
  // Turn-bound: an idle fleet's reading ages, and this is the field that says so.
  assert.ok(Date.parse(limits.capturedAt) > 0, 'and it is dated');
  system.store.close();
});

test('an allowed reading is observation only — it never parks the agent', async () => {
  const { system, agent, child } = await fleet(802);
  child.rateLimit(ALLOWED_WITH_WINDOWS);
  child.emitLine({ type: 'result', subtype: 'success', total_cost_usd: 0.01, num_turns: 1 });

  // The whole hazard of reading these: `rate_limit_event` now fires on every
  // ordinary turn, so the observation arm runs constantly and must have no
  // opinion about parking. `overageStatus: 'rejected'` on an account that is not
  // *using* overage is the shape that would trip a careless park.
  assert.equal(system.agents.limitedAgentIds().length, 0, 'nothing parked on a reading inside the limits');
  assert.notEqual(system.store.getAgent(agent.id)!.status, 'waiting');
  assert.ok(system.store.readRateLimits(), 'and the reading still landed');
  system.store.close();
});

test('an older CLI carries no windows, and the chip degrades to cost rather than to zero', async () => {
  const { system, child } = await fleet(803);
  // The same event as the binary before `unifiedWindows` existed.
  child.rateLimit({ status: 'allowed', rateLimitType: 'five_hour', isUsingOverage: false });

  const snap = await buildStateSnapshot(system);
  assert.equal(snap.usage.rateLimits, null, 'absent, not a row of zeroes');
  system.store.close();
});

test('the freshest reading wins, whatever order the reports arrive in', () => {
  const store = new Store(':memory:');
  const at = (iso: string) => ({ fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: null, capturedAt: iso });
  store.recordRateLimits(at('2026-08-27T12:00:00.000Z'));
  store.recordRateLimits({ ...at('2026-08-27T12:05:00.000Z'), fiveHour: { usedPercentage: 40, resetsAt: null } });
  // Several agents report interleaved, so a reading queued behind a slow turn can
  // land after a newer one. Last-write-wins would show the chip going *backwards*
  // — a plausible number, which is why nothing else would catch it.
  store.recordRateLimits({ ...at('2026-08-27T12:02:00.000Z'), fiveHour: { usedPercentage: 20, resetsAt: null } });
  assert.equal(store.readRateLimits()?.fiveHour?.usedPercentage, 40);
  assert.equal(store.readRateLimits()?.capturedAt, '2026-08-27T12:05:00.000Z');
  store.close();
});
