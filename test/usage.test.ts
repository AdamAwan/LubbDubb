import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import type { Spawner, StreamChild } from '../src/agents/streamJsonSession.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

// ---------------------------------------------------------------------------
// Store: cumulative usage folds onto the agent; deltas feed the rolling window
// ---------------------------------------------------------------------------

test('recordAgentUsage stores cumulative values and window-sums the deltas', () => {
  let at = '2026-07-22T10:00:00.000Z';
  const store = new Store(':memory:', () => at);
  const task = store.createTask({ kind: 'code', title: 't', prompt: 'p', branch: null, originRef: null });
  const agent = store.createAgent({ taskId: task.id, cwd: '/tmp', pid: null });
  assert.equal(store.getAgent(agent.id)!.costUsd, null);

  store.recordAgentUsage(agent.id, {
    costUsd: 0.5,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 600,
    cacheCreationTokens: 300,
    numTurns: 1,
  });
  at = '2026-07-22T12:00:00.000Z';
  store.recordAgentUsage(agent.id, {
    costUsd: 1.25,
    inputTokens: 5000,
    outputTokens: 900,
    cacheReadTokens: 4200,
    cacheCreationTokens: 400,
    numTurns: 2,
  });

  const after = store.getAgent(agent.id)!;
  assert.equal(after.costUsd, 1.25); // cumulative, not summed
  assert.equal(after.inputTokens, 5000);
  assert.equal(after.outputTokens, 900);
  // The cached split is cumulative on the same terms, and is a *part* of the
  // input rather than a sibling total — fresh input is the subtraction, 400.
  assert.equal(after.cacheReadTokens, 4200);
  assert.equal(after.cacheCreationTokens, 400);
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
  store.recordAgentUsage(agent.id, {
    costUsd: 1.0,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: null,
  });
  store.recordAgentUsage(agent.id, {
    costUsd: 0.2,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: null,
  });
  assert.equal(store.sumUsageCostSince('2026-07-22T00:00:00.000Z'), 1.0);
  store.close();
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
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
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
  const system = buildSystem(config, { worktrees: new FakeWorktreeManager(), streamSpawner: spawner });

  system.connector.inject({ kind: 'new_issue', number: 902, title: 'Add login' });
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
  // …and are also kept apart, because the gross figure alone cannot say whether
  // that input was cheap. A read bills at a fraction of a fresh token: 55k of
  // this run's 59.9k input was already warm, and only 900 tokens were fresh.
  assert.equal(agent.cacheReadTokens, 55_000);
  assert.equal(agent.cacheCreationTokens, 4000);
  assert.equal(agent.numTurns, 6);

  const snap = await buildStateSnapshot(system);
  assert.equal(snap.usage.windows.fiveHourCostUsd, 0.42);
  assert.equal(snap.usage.windows.sevenDayCostUsd, 0.42);
  assert.equal(snap.usage.rateLimits, null, 'no agent reported a window on this run');
  system.store.close();
});
