import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import type { ActionSink, SendResult, WorkItemStateInput } from '../src/sink/actionSink.js';
import type { DispatchResult } from '../src/dispatcher/dispatcher.js';

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    dbPath: ':memory:',
    dispatcher: 'rule',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
  });
}

/** A plan carrying a single set_work_item_state action. */
function statePlan(number: number, state: string): DispatchResult {
  return {
    rationale: 'test',
    rejected: [],
    actions: [{ type: 'set_work_item_state', number, state, reason: 'PR opened' }],
  } as unknown as DispatchResult;
}

/** A sink that records work-item transitions and no-ops everything else. */
function recordingSink(): { sink: ActionSink; states: WorkItemStateInput[] } {
  const states: WorkItemStateInput[] = [];
  const sink: ActionSink = {
    async postPrReply(): Promise<SendResult> {
      return { ok: true };
    },
    async mergePr(): Promise<SendResult> {
      return { ok: true };
    },
    async setPrLabel(): Promise<SendResult> {
      return { ok: true };
    },
    async setWorkItemState(input): Promise<SendResult> {
      states.push(input);
      return { ok: true, ref: 'ok' };
    },
  };
  return { sink, states };
}

test('set_work_item_state routes to the sink and is audited (no auto-send gate)', async () => {
  const { sink, states } = recordingSink();
  const system = buildSystem(testConfig(), { backend: new FakePtyBackend(), sink });
  await system.executor.execute('cyc', statePlan(101, 'In Review'));

  assert.deepEqual(states, [{ number: 101, state: 'In Review' }]);
  const decision = system.store.listDecisions().find((d) => d.action.type === 'set_work_item_state');
  assert.ok(decision, 'the transition is recorded');
  assert.equal(decision!.outcome, 'executed');
  assert.match(decision!.detail, /Set work item #101 to "In Review"/);
  // A mechanical transition never escalates.
  assert.equal(system.store.listOpenEscalations().length, 0);
  system.store.close();
});

test('a failing transition is recorded as rejected, not escalated', async () => {
  const failingSink: ActionSink = {
    async postPrReply(): Promise<SendResult> {
      return { ok: true };
    },
    async mergePr(): Promise<SendResult> {
      return { ok: true };
    },
    async setPrLabel(): Promise<SendResult> {
      return { ok: true };
    },
    async setWorkItemState(): Promise<SendResult> {
      throw new Error('boom');
    },
  };
  const system = buildSystem(testConfig(), { backend: new FakePtyBackend(), sink: failingSink });
  await system.executor.execute('cyc', statePlan(7, 'In Review'));

  const decision = system.store.listDecisions().find((d) => d.action.type === 'set_work_item_state');
  assert.equal(decision!.outcome, 'rejected');
  assert.match(decision!.detail, /Failed to set work item #7 state: boom/);
  assert.equal(system.store.listOpenEscalations().length, 0);
  system.store.close();
});
