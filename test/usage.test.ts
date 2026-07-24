import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { parseStatusLinePayload, StatusFileRateLimits } from '../src/agents/statusLine.js';
import { buildClaudeArgs, buildClaudeStreamArgs } from '../src/agents/agentProtocol.js';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { buildStateSnapshot } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import type { Spawner, StreamChild } from '../src/agents/streamJsonSession.js';

// ---------------------------------------------------------------------------
// Store: cumulative usage folds onto the agent; deltas feed the rolling window
// ---------------------------------------------------------------------------

test('recordAgentUsage stores cumulative values and window-sums the deltas', () => {
  let at = '2026-07-22T10:00:00.000Z';
  const store = new Store(':memory:', () => at);
  const task = store.createTask({ kind: 'code', title: 't', prompt: 'p', branch: null, originRef: null });
  const agent = store.createAgent({ taskId: task.id, cwd: '/tmp', pid: null });
  assert.equal(store.getAgent(agent.id)!.costUsd, null);

  store.recordAgentUsage(agent.id, { costUsd: 0.5, inputTokens: 1000, outputTokens: 200, numTurns: 1 });
  at = '2026-07-22T12:00:00.000Z';
  store.recordAgentUsage(agent.id, { costUsd: 1.25, inputTokens: 5000, outputTokens: 900, numTurns: 2 });

  const after = store.getAgent(agent.id)!;
  assert.equal(after.costUsd, 1.25); // cumulative, not summed
  assert.equal(after.inputTokens, 5000);
  assert.equal(after.outputTokens, 900);
  assert.equal(after.numTurns, 2);

  // Both deltas (0.5 + 0.75) fall in a window opened before the first report…
  assert.equal(store.sumUsageCostSince('2026-07-22T09:00:00.000Z'), 1.25);
  // …but only the second (0.75) in one opened after it.
  assert.equal(store.sumUsageCostSince('2026-07-22T11:00:00.000Z'), 0.75);
  store.close();
});

test('a regressed cumulative total never produces a negative window delta', () => {
  const store = new Store(':memory:', () => '2026-07-22T10:00:00.000Z');
  const task = store.createTask({ kind: 'code', title: 't', prompt: 'p', branch: null, originRef: null });
  const agent = store.createAgent({ taskId: task.id, cwd: '/tmp', pid: null });
  store.recordAgentUsage(agent.id, { costUsd: 1.0, inputTokens: null, outputTokens: null, numTurns: null });
  store.recordAgentUsage(agent.id, { costUsd: 0.2, inputTokens: null, outputTokens: null, numTurns: null });
  assert.equal(store.sumUsageCostSince('2026-07-22T00:00:00.000Z'), 1.0);
  store.close();
});

// ---------------------------------------------------------------------------
// Status-line payload parsing (pure) and freshest-file reads
// ---------------------------------------------------------------------------

test('parseStatusLinePayload maps both windows and normalises epoch resets', () => {
  const raw = JSON.stringify({
    rate_limits: {
      five_hour: { used_percentage: 62, resets_at: 1786520400 }, // epoch seconds
      seven_day: { used_percentage: 30, resets_at: '2026-07-25T00:00:00Z' },
    },
  });
  const parsed = parseStatusLinePayload(raw, '2026-07-22T10:00:00.000Z');
  assert.ok(parsed);
  assert.equal(parsed.fiveHour!.usedPercentage, 62);
  assert.equal(parsed.fiveHour!.resetsAt, new Date(1786520400 * 1000).toISOString());
  assert.equal(parsed.sevenDay!.usedPercentage, 30);
  assert.equal(parsed.sevenDay!.resetsAt, '2026-07-25T00:00:00.000Z');
  assert.equal(parsed.capturedAt, '2026-07-22T10:00:00.000Z');
});

test('parseStatusLinePayload handles absent windows, absent limits and garbage', () => {
  const onlyWeekly = parseStatusLinePayload(
    JSON.stringify({ rate_limits: { seven_day: { used_percentage: 12 } } }),
    'now',
  );
  assert.ok(onlyWeekly);
  assert.equal(onlyWeekly.fiveHour, null);
  assert.equal(onlyWeekly.sevenDay!.usedPercentage, 12);
  assert.equal(onlyWeekly.sevenDay!.resetsAt, null);

  // API-key auth: no rate_limits at all.
  assert.equal(parseStatusLinePayload(JSON.stringify({ cost: { total_cost_usd: 1 } }), 'now'), null);
  assert.equal(parseStatusLinePayload('not json', 'now'), null);
  assert.equal(parseStatusLinePayload(JSON.stringify({ rate_limits: {} }), 'now'), null);
});

test('StatusFileRateLimits reads the freshest parseable capture, or null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-status-'));
  const reader = new StatusFileRateLimits(dir);
  assert.equal(reader.readLatest(), null); // empty dir

  const older = reader.fileFor('session-old');
  const newer = reader.fileFor('session-new');
  writeFileSync(older, JSON.stringify({ rate_limits: { five_hour: { used_percentage: 40 } } }));
  utimesSync(older, new Date('2026-07-22T09:00:00Z'), new Date('2026-07-22T09:00:00Z'));
  writeFileSync(newer, JSON.stringify({ rate_limits: { five_hour: { used_percentage: 70 } } }));
  utimesSync(newer, new Date('2026-07-22T10:00:00Z'), new Date('2026-07-22T10:00:00Z'));
  assert.equal(reader.readLatest()!.fiveHour!.usedPercentage, 70);

  // The freshest file carrying no limits falls back to the next parseable one.
  writeFileSync(newer, JSON.stringify({ cost: {} }));
  utimesSync(newer, new Date('2026-07-22T11:00:00Z'), new Date('2026-07-22T11:00:00Z'));
  assert.equal(reader.readLatest()!.fiveHour!.usedPercentage, 40);
});

// ---------------------------------------------------------------------------
// Launch wiring: status-line capture is PTY-only
// ---------------------------------------------------------------------------

test('buildClaudeArgs wires the status-line capture only when asked; stream args never do', () => {
  const pty = buildClaudeArgs({ statusLine: true });
  const at = pty.indexOf('--settings');
  assert.ok(at >= 0, 'expected --settings');
  assert.match(pty[at + 1]!, /statusLine/);
  assert.match(pty[at + 1]!, /LUBBDUBB_STATUS_FILE/);
  assert.ok(!buildClaudeArgs({}).includes('--settings'), 'off by default');
  assert.ok(!buildClaudeStreamArgs({}).includes('--settings'), 'never headless');
});

test('pty mode exports LUBBDUBB_STATUS_FILE keyed by the chosen session id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-usage-pty-'));
  const config = loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    dispatcher: 'rule',
    agentMode: 'pty',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
  });
  const backend = new FakePtyBackend();
  const system = buildSystem(config, { backend });
  assert.ok(system.rateLimits, 'pty mode wires the rate-limit capture');

  system.connector.inject({ kind: 'new_story', title: 'Add login', wafPillars: ['Reliability'] });
  await system.harness.runCycle('manual');

  const spawn = backend.spawned[0]!;
  const sessionId = system.store.listAgents()[0]!.sessionId!;
  assert.equal(spawn.opts.env?.LUBBDUBB_STATUS_FILE, system.rateLimits.fileFor(sessionId));
  assert.ok(spawn.args.includes('--settings'), 'launch carries the statusLine settings');
  system.store.close();
});

// ---------------------------------------------------------------------------
// Stream mode end-to-end: result metadata → agent row → snapshot windows
// ---------------------------------------------------------------------------

/** Minimal fake claude stream-JSON process (same shape as streamIntegration.test.ts). */
class FakeChild extends EventEmitter implements StreamChild {
  pid = 777;
  writes: string[] = [];
  private out = new EventEmitter();
  stdout = { on: (ev: string, cb: (d: string) => void) => this.out.on(ev, cb) } as unknown as NodeJS.ReadableStream;
  stderr = null;
  stdin = { write: (d: string) => this.writes.push(d), end: () => {} } as unknown as NodeJS.WritableStream;
  emitLine(obj: unknown): void {
    this.out.emit('data', JSON.stringify(obj) + '\n');
  }
  override on(event: 'exit', cb: (code: number | null) => void): this {
    return super.on(event, cb);
  }
  kill(): void {
    this.emit('exit', 143);
  }
}

test('stream mode: result usage lands on the agent row and in the snapshot windows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-usage-stream-'));
  const config = loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    dispatcher: 'rule',
    agentMode: 'stream',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
  });
  const children: FakeChild[] = [];
  const spawner: Spawner = () => {
    const c = new FakeChild();
    children.push(c);
    return c;
  };
  const system = buildSystem(config, { streamSpawner: spawner });
  assert.equal(system.rateLimits, null, 'no status-line capture headless');

  system.connector.inject({ kind: 'new_story', title: 'Add login', wafPillars: ['Reliability'] });
  await system.harness.runCycle('manual');
  const child = children[0]!;
  const agentId = system.store.listAgentsByStatus('starting', 'running')[0]!.id;

  child.emitLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'done @@LUBBDUBB_DONE@@' }] } });
  child.emitLine({
    type: 'result',
    subtype: 'success',
    total_cost_usd: 0.42,
    num_turns: 6,
    usage: {
      input_tokens: 900,
      output_tokens: 350,
      cache_creation_input_tokens: 4000,
      cache_read_input_tokens: 55_000,
    },
  });

  const agent = system.store.getAgent(agentId)!;
  assert.equal(agent.status, 'done');
  assert.equal(agent.costUsd, 0.42);
  assert.equal(agent.inputTokens, 900 + 4000 + 55_000, 'cache tokens count as input');
  assert.equal(agent.outputTokens, 350);
  assert.equal(agent.numTurns, 6);

  const snap = await buildStateSnapshot(system);
  assert.equal(snap.usage.windows.fiveHourCostUsd, 0.42);
  assert.equal(snap.usage.windows.sevenDayCostUsd, 0.42);
  assert.equal(snap.usage.rateLimits, null);
  system.store.close();
});
