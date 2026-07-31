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
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

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

/** A sink that counts what actually went out, so "exactly one call" is observable. */
function countingSink(fail = false): ActionSink & { merges: number[]; replies: number[] } {
  const merges: number[] = [];
  const replies: number[] = [];
  return {
    merges,
    replies,
    async mergePr({ prNumber }) {
      merges.push(prNumber);
      if (fail) throw new Error('merge conflict');
      return { ok: true, ref: `pr:${prNumber}` };
    },
    async postPrReply({ prNumber }) {
      replies.push(prNumber);
      if (fail) throw new Error('network down');
      return { ok: true, ref: `pr:${prNumber}` };
    },
    async setPrLabel() {
      return { ok: true };
    },
    async setIssueLabel() {
      return { ok: true };
    },
    async setWorkItemState() {
      return { ok: true };
    },
    async upsertIssueComment() {
      return { ok: true };
    },
    async createPullRequest() {
      return { ok: true };
    },
    async setPullTitle() {
      return { ok: true };
    },
    async setPullBase() {
      return { ok: true };
    },
  };
}

test('auto-send is off by default: even a 1.0-confidence reply is drafted and escalated', async () => {
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  await system.executor.execute('cyc', replyPlan(1.0));

  const open = system.store.listOpenEscalations();
  assert.equal(open.length, 1, 'should escalate, not send');
  assert.equal(open[0]!.type, 'review_reply');
  assert.match(replyDecision(system)!.detail, /auto-send disabled/);
  // The safety default, in the phase-2 vocabulary: nobody has authorized it, so
  // the proposal is pending and carries no decider at all.
  const [proposal] = system.store.listProposals();
  assert.equal(proposal!.status, 'pending');
  assert.equal(proposal!.decidedBy, null);
  system.store.close();
});

test('enabled + confidence at/above threshold auto-sends through the sink', async () => {
  const config = testConfig({ enabled: true, confidenceThreshold: 0.85, allowedActions: ['reply_on_pr'] });
  const sink = countingSink();
  const system = buildSystem(config, { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), sink });
  await system.executor.execute('cyc', replyPlan(0.9));

  assert.equal(system.store.listOpenEscalations().length, 0, 'nothing to escalate — it was sent');
  assert.deepEqual(sink.replies, [42], 'exactly one send');
  assert.match(replyDecision(system)!.detail, /Sent the reply on PR #42 — authorized by auto-send/);
  assert.match(replyDecision(system)!.detail, /ref=/);
  system.store.close();
});

test('an auto-sent act is recorded as an accepted proposal decided by auto_send', async () => {
  const config = testConfig({ enabled: true, confidenceThreshold: 0.85, allowedActions: ['merge_pr'] });
  const sink = countingSink();
  const system = buildSystem(config, { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), sink });
  await system.executor.execute('cyc', mergePlan(0.9));

  // The machine verdict is the same object the human verdict is, which is the
  // whole of phase 2: one authorization representation, queryable either way.
  const [proposal] = system.store.listProposals();
  assert.equal(proposal!.kind, 'merge');
  assert.equal(proposal!.ref, 'pr:42:merge');
  assert.equal(proposal!.status, 'accepted');
  assert.equal(proposal!.decidedBy, 'auto_send');
  assert.ok(proposal!.decidedAt, 'an accepted proposal is dated, whoever accepted it');
  assert.equal(proposal!.note, 'confidence 0.90 ≥ 0.85 threshold', 'the decider records its own reason');
  assert.equal(proposal!.escalationId, null, 'nothing was asked of anyone');
  assert.deepEqual(sink.merges, [42], 'exactly one merge');
  system.store.close();
});

test('an auto-sent act stays under its cycle and is never attributed to the operator', async () => {
  const config = testConfig({ enabled: true, confidenceThreshold: 0.85, allowedActions: ['merge_pr'] });
  const system = buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    sink: countingSink(),
  });
  await system.executor.execute('cyc-7', mergePlan(0.9));

  const audited = system.store.listDecisions().find((d) => d.action.type === 'merge_pr')!;
  // Auto-send decides *inside* the pulse, so the row groups with the cycle that
  // produced the action. The cockpit badges "you · accepted" off the `human:`
  // prefix, so carrying it here would read as something the operator clicked.
  assert.equal(audited.cycleId, 'cyc-7');
  assert.equal(audited.outcome, 'executed');
  assert.match(audited.detail, /authorized by auto-send \(confidence 0\.90 ≥ 0\.85 threshold\)/);
  assert.equal(
    system.store.listDecisions().filter((d) => d.cycleId.startsWith('human:')).length,
    0,
    'no human decided anything here',
  );
  system.store.close();
});

test('a settled act is not re-proposed every pulse', async () => {
  const config = testConfig({ enabled: true, confidenceThreshold: 0.85, allowedActions: ['merge_pr'] });
  const sink = countingSink();
  const system = buildSystem(config, { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), sink });

  // The same merge-ready world three pulses running: the world has not caught up
  // with the merge yet, which is the normal case for a pulse or two. An accepted
  // proposal holds its own ref for a settle window precisely so this does not
  // write a row per pulse into a list the gate itself re-reads.
  await system.executor.execute('cyc-1', mergePlan(0.9));
  await system.executor.execute('cyc-2', mergePlan(0.9));
  await system.executor.execute('cyc-3', mergePlan(0.9));

  assert.equal(system.store.listProposals().length, 1, 'one act, one proposal');
  assert.deepEqual(sink.merges, [42], 'and one merge');
  const skipped = system.store.listDecisions().filter((d) => d.outcome === 'skipped');
  assert.equal(skipped.length, 2);
  assert.match(skipped[0]!.detail, /Skipped merge of PR #42: already authorized by auto-send/);
  system.store.close();
});

/**
 * A gate that refuses is not a rejection: nothing went out, and the act is put to
 * a human as a pending proposal with no decider yet. Asserted for every way the
 * gate can refuse, because that is the safety default the README promises.
 */
function assertNothingSentAndAsked(system: ReturnType<typeof buildSystem>, sink: { replies: number[] }) {
  assert.deepEqual(sink.replies, [], 'nothing may go out unauthorized');
  assert.equal(system.store.listOpenEscalations().length, 1);
  const [proposal] = system.store.listProposals();
  assert.equal(proposal!.status, 'pending');
  assert.equal(proposal!.decidedBy, null);
  assert.ok(proposal!.escalationId, 'a pending proposal hangs off its inbox item');
}

test('enabled but below threshold falls back to draft + escalate', async () => {
  const config = testConfig({ enabled: true, confidenceThreshold: 0.85, allowedActions: ['reply_on_pr'] });
  const sink = countingSink();
  const system = buildSystem(config, { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), sink });
  await system.executor.execute('cyc', replyPlan(0.5));

  assertNothingSentAndAsked(system, sink);
  assert.match(replyDecision(system)!.detail, /confidence 0\.50 < 0\.85 threshold/);
  system.store.close();
});

test('missing confidence is treated as 0 and never auto-sends', async () => {
  const config = testConfig({ enabled: true, confidenceThreshold: 0.85, allowedActions: ['reply_on_pr'] });
  const sink = countingSink();
  const system = buildSystem(config, { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), sink });
  await system.executor.execute('cyc', replyPlan(undefined));

  assertNothingSentAndAsked(system, sink);
  assert.match(replyDecision(system)!.detail, /confidence 0\.00 < 0\.85 threshold/);
  system.store.close();
});

test('action type not in the allow-list is escalated even when confident', async () => {
  const config = testConfig({ enabled: true, confidenceThreshold: 0.85, allowedActions: [] });
  const sink = countingSink();
  const system = buildSystem(config, { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), sink });
  await system.executor.execute('cyc', replyPlan(0.99));

  assertNothingSentAndAsked(system, sink);
  assert.match(replyDecision(system)!.detail, /not in allowed auto-send actions/);
  system.store.close();
});

test('a blocked gate is still not a rejection — and phase 4 is no back door to one', async () => {
  const config = testConfig({ enabled: true, confidenceThreshold: 0.85, allowedActions: ['merge_pr'] });
  const sink = countingSink();
  const system = buildSystem(config, { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), sink });
  await system.executor.execute('cyc-1', mergePlan(0.5));

  // "Blocked" means "not mine to authorize", which is what a *pending* proposal
  // already says. A machine "no" would be durable and would suppress the human
  // ask for good, so `autoSendVerdict` has no rejecting arm to reach.
  const [proposal] = system.store.listProposals();
  assert.equal(proposal!.status, 'pending');
  assert.equal(proposal!.decidedBy, null);
  assert.deepEqual(sink.merges, []);
  assert.equal(system.store.listProposals().filter((p) => p.status === 'rejected').length, 0);

  // And the expiry does not reach it: only a rejection has a standing to end, so
  // the world moving neither settles the question nor asks it twice. Whether the
  // gate would clear on a second look is beside the point — the operator has been
  // asked, and their answer is the only thing that decides it.
  system.store.recordWorldEvents([{ kind: 'pr_ci', ref: 'pr:42', summary: 'PR #42 CI passing' }]);
  await system.executor.execute('cyc-2', mergePlan(0.99));

  assert.equal(system.store.listProposals().length, 1, 'a pending ask is not re-asked by a world signal');
  assert.deepEqual(sink.merges, [], 'and a confident second look does not overrule the human it is waiting on');
  const skipped = system.store.listDecisions().find((d) => d.outcome === 'skipped')!;
  assert.match(skipped.detail, /Skipped merge of PR #42: awaiting your accept\/reject/);
  system.store.close();
});

test('a send failure never drops the reply — it falls back to escalation', async () => {
  const config = testConfig({ enabled: true, confidenceThreshold: 0.85, allowedActions: ['reply_on_pr'] });
  const failingSink: ActionSink = {
    async postPrReply() {
      throw new Error('network down');
    },
    async mergePr() {
      throw new Error('network down');
    },
    async setPrLabel() {
      throw new Error('network down');
    },
    async setIssueLabel() {
      throw new Error('network down');
    },
    async setWorkItemState() {
      throw new Error('network down');
    },
    async upsertIssueComment() {
      return { ok: true };
    },
    async createPullRequest() {
      return { ok: true };
    },
    async setPullTitle() {
      return { ok: true };
    },
    async setPullBase() {
      return { ok: true };
    },
  };
  const system = buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    sink: failingSink,
  });
  await system.executor.execute('cyc', replyPlan(0.95));

  const open = system.store.listOpenEscalations();
  assert.equal(open.length, 1, 'failed send must still surface for a human');
  assert.equal(open[0]!.context.autoSendFailed, true);
  assert.match(open[0]!.prompt, /Auto-send authorized this reply, but sending it failed \(network down\)/);
  assert.match(replyDecision(system)!.detail, /Authorized reply on PR #42 failed \(network down\)/);
  // The proposal reflects the attempt: it *was* authorized, and the send failing
  // does not un-authorize it. Once the settle window lapses the gate lets the act
  // be proposed again if the world still warrants it — no new state for that.
  const [proposal] = system.store.listProposals();
  assert.equal(proposal!.status, 'accepted');
  assert.equal(proposal!.decidedBy, 'auto_send');
  system.store.close();
});

/** A plan carrying a single merge_pr action at the given confidence. */
function mergePlan(confidence?: number): DispatchResult {
  return {
    rationale: 'test',
    rejected: [],
    actions: [
      {
        type: 'merge_pr',
        prNumber: 42,
        method: 'squash',
        ...(confidence === undefined ? {} : { confidence }),
        reason: 'green, approved and mergeable',
      },
    ],
  } as unknown as DispatchResult;
}

function mergeDecision(system: ReturnType<typeof buildSystem>) {
  return system.store.listDecisions().find((d) => d.action.type === 'merge_pr');
}

test('merge_pr is escalated for approval by default (nothing merges autonomously)', async () => {
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  await system.executor.execute('cyc', mergePlan(1.0));

  const open = system.store.listOpenEscalations();
  assert.equal(open.length, 1, 'should escalate, not merge');
  assert.equal(open[0]!.type, 'approve_change');
  // Still escalated, now as a proposal the human can accept (which merges it).
  assert.match(mergeDecision(system)!.detail, /proposed the merge for approval/);
  system.store.close();
});

test('merge_pr auto-merges when enabled, allow-listed and confident', async () => {
  const config = testConfig({ enabled: true, confidenceThreshold: 0.85, allowedActions: ['merge_pr'] });
  const system = buildSystem(config, { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });

  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'feat' });
  await system.executor.execute('cyc', mergePlan(0.9));

  assert.equal(system.store.listOpenEscalations().length, 0, 'nothing to escalate — it was merged');
  assert.match(mergeDecision(system)!.detail, /Merged PR #42 via squash — authorized by auto-send/);
  assert.equal((await system.connector.getState()).pullRequests[0]!.merged, true);
  system.store.close();
});

test('a merge failure never merges silently — it escalates for approval', async () => {
  const config = testConfig({ enabled: true, confidenceThreshold: 0.85, allowedActions: ['merge_pr'] });
  const failingSink: ActionSink = {
    async postPrReply() {
      throw new Error('unused');
    },
    async mergePr() {
      throw new Error('merge conflict');
    },
    async setPrLabel() {
      throw new Error('unused');
    },
    async setIssueLabel() {
      throw new Error('unused');
    },
    async setWorkItemState() {
      throw new Error('unused');
    },
    async upsertIssueComment() {
      return { ok: true };
    },
    async createPullRequest() {
      return { ok: true };
    },
    async setPullTitle() {
      return { ok: true };
    },
    async setPullBase() {
      return { ok: true };
    },
  };
  const system = buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    sink: failingSink,
  });
  await system.executor.execute('cyc', mergePlan(0.95));

  const open = system.store.listOpenEscalations();
  assert.equal(open.length, 1, 'failed merge must still surface for a human');
  assert.equal(open[0]!.context.autoMergeFailed, true);
  assert.match(open[0]!.prompt, /Auto-send authorized merging PR #42, but the merge failed \(merge conflict\)/);
  assert.match(mergeDecision(system)!.detail, /Authorized merge of PR #42 failed \(merge conflict\)/);
  system.store.close();
});

test('auto-sending a threaded reply marks the answered comment handled (world settles)', async () => {
  const config = testConfig({ enabled: true, confidenceThreshold: 0.85, allowedActions: ['reply_on_pr'] });
  const system = buildSystem(config, { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });

  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'feat' });
  system.connector.inject({ kind: 'pr_comment', prNumber: 42, author: 'bob', body: 'why this?' });
  const before = (await system.connector.getState()).pullRequests[0]!.unresolvedComments[0]!;
  assert.equal(before.handled, false);

  const plan = {
    rationale: 'test',
    rejected: [],
    actions: [
      {
        type: 'reply_on_pr',
        prNumber: 42,
        commentId: before.id,
        draft: 'Because X.',
        confidence: 0.9,
        reason: 'answer',
      },
    ],
  } as unknown as DispatchResult;
  await system.executor.execute('cyc', plan);

  const after = (await system.connector.getState()).pullRequests[0]!.unresolvedComments[0]!;
  assert.equal(after.handled, true, 'the sent reply should mark the comment handled');
  system.store.close();
});
