import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type AutoSendConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import type { ActionSink } from '../src/sink/actionSink.js';
import type { DispatchResult } from '../src/dispatcher/dispatcher.js';

function testConfig(autoSend?: Partial<AutoSendConfig>) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    dbPath: ':memory:',
    dispatcher: 'rule',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    ...(autoSend ? { autoSend: autoSend as AutoSendConfig } : {}),
  });
}

/** A plan carrying a single reply_on_pr action at the given confidence. */
function replyPlan(confidence?: number): DispatchResult {
  return {
    rationale: 'test',
    rejected: [],
    actions: [
      {
        type: 'reply_on_pr',
        prNumber: 42,
        commentId: null,
        draft: 'Thanks — addressed in the latest commit.',
        ...(confidence === undefined ? {} : { confidence }),
        reason: 'reviewer asked a question',
      },
    ],
  } as unknown as DispatchResult;
}

function replyDecision(system: ReturnType<typeof buildSystem>) {
  return system.store.listDecisions().find((d) => d.action.type === 'reply_on_pr');
}

test('auto-send is off by default: even a 1.0-confidence reply is drafted and escalated', async () => {
  const system = buildSystem(testConfig(), { backend: new FakePtyBackend() });
  await system.executor.execute('cyc', replyPlan(1.0));

  const open = system.store.listOpenEscalations();
  assert.equal(open.length, 1, 'should escalate, not send');
  assert.equal(open[0]!.type, 'review_reply');
  assert.match(replyDecision(system)!.detail, /auto-send disabled/);
  system.store.close();
});

test('enabled + confidence at/above threshold auto-sends through the sink', async () => {
  const config = testConfig({ enabled: true, confidenceThreshold: 0.85, allowedActions: ['reply_on_pr'] });
  const system = buildSystem(config, { backend: new FakePtyBackend() });
  await system.executor.execute('cyc', replyPlan(0.9));

  assert.equal(system.store.listOpenEscalations().length, 0, 'nothing to escalate — it was sent');
  assert.match(replyDecision(system)!.detail, /Auto-sent reply on PR #42/);
  assert.match(replyDecision(system)!.detail, /ref=/);
  system.store.close();
});

test('enabled but below threshold falls back to draft + escalate', async () => {
  const config = testConfig({ enabled: true, confidenceThreshold: 0.85, allowedActions: ['reply_on_pr'] });
  const system = buildSystem(config, { backend: new FakePtyBackend() });
  await system.executor.execute('cyc', replyPlan(0.5));

  assert.equal(system.store.listOpenEscalations().length, 1);
  assert.match(replyDecision(system)!.detail, /confidence 0\.50 < 0\.85 threshold/);
  system.store.close();
});

test('missing confidence is treated as 0 and never auto-sends', async () => {
  const config = testConfig({ enabled: true, confidenceThreshold: 0.85, allowedActions: ['reply_on_pr'] });
  const system = buildSystem(config, { backend: new FakePtyBackend() });
  await system.executor.execute('cyc', replyPlan(undefined));

  assert.equal(system.store.listOpenEscalations().length, 1);
  assert.match(replyDecision(system)!.detail, /confidence 0\.00 < 0\.85 threshold/);
  system.store.close();
});

test('action type not in the allow-list is escalated even when confident', async () => {
  const config = testConfig({ enabled: true, confidenceThreshold: 0.85, allowedActions: [] });
  const system = buildSystem(config, { backend: new FakePtyBackend() });
  await system.executor.execute('cyc', replyPlan(0.99));

  assert.equal(system.store.listOpenEscalations().length, 1);
  assert.match(replyDecision(system)!.detail, /not in allowed auto-send actions/);
  system.store.close();
});

test('a send failure never drops the reply — it falls back to escalation', async () => {
  const config = testConfig({ enabled: true, confidenceThreshold: 0.85, allowedActions: ['reply_on_pr'] });
  const failingSink: ActionSink = {
    async postPrReply() {
      throw new Error('network down');
    },
  };
  const system = buildSystem(config, { backend: new FakePtyBackend(), sink: failingSink });
  await system.executor.execute('cyc', replyPlan(0.95));

  const open = system.store.listOpenEscalations();
  assert.equal(open.length, 1, 'failed send must still surface for a human');
  assert.equal(open[0]!.context.autoSendFailed, true);
  assert.match(replyDecision(system)!.detail, /Auto-send to PR #42 failed \(network down\)/);
  system.store.close();
});

test('auto-sending a threaded reply marks the answered comment handled (world settles)', async () => {
  const config = testConfig({ enabled: true, confidenceThreshold: 0.85, allowedActions: ['reply_on_pr'] });
  const system = buildSystem(config, { backend: new FakePtyBackend() });

  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'feat' });
  system.connector.inject({ kind: 'pr_comment', prNumber: 42, author: 'bob', body: 'why this?' });
  const before = (await system.connector.getState()).pullRequests[0]!.unresolvedComments[0]!;
  assert.equal(before.handled, false);

  const plan = {
    rationale: 'test',
    rejected: [],
    actions: [
      { type: 'reply_on_pr', prNumber: 42, commentId: before.id, draft: 'Because X.', confidence: 0.9, reason: 'answer' },
    ],
  } as unknown as DispatchResult;
  await system.executor.execute('cyc', plan);

  const after = (await system.connector.getState()).pullRequests[0]!.unresolvedComments[0]!;
  assert.equal(after.handled, true, 'the sent reply should mark the comment handled');
  system.store.close();
});
