import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import type { ActionSink } from '../src/sink/actionSink.js';
import type { DispatchResult } from '../src/dispatcher/dispatcher.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

function testConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    dbPath: ':memory:',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    ...overrides,
  });
}

function replyPlan(): DispatchResult {
  return {
    rationale: 'test',
    rejected: [],
    actions: [
      {
        type: 'reply_on_pr',
        prNumber: 42,
        commentId: null,
        draft: 'Thanks — addressed in the latest commit.',
        reason: 'reviewer asked a question',
      },
    ],
  } as unknown as DispatchResult;
}

function mergePlan(): DispatchResult {
  return {
    rationale: 'test',
    rejected: [],
    actions: [{ type: 'merge_pr', prNumber: 42, method: 'squash', reason: 'green, approved and mergeable' }],
  } as unknown as DispatchResult;
}

function replyDecision(system: ReturnType<typeof buildSystem>) {
  return system.store.decisions.listDecisions().find((d) => d.action.type === 'reply_on_pr');
}

function mergeDecision(system: ReturnType<typeof buildSystem>) {
  return system.store.decisions.listDecisions().find((d) => d.action.type === 'merge_pr');
}

function countingSink(fail = false): ActionSink & { merges: number[]; replies: number[] } {
  const merges: number[] = [];
  const replies: number[] = [];
  const ok = async () => ({ ok: true as const });
  return {
    merges,
    replies,
    canCloseIssue: () => false,
    canClosePr: () => false,
    closePr: (): never => {
      throw new Error('closePr is not scripted in this test');
    },
    canResolvePrThread: () => false,
    resolvePrThread: (): never => {
      throw new Error('resolvePrThread is not scripted in this test');
    },
    closeIssue: (): never => {
      throw new Error('closeIssue is not scripted in this test');
    },
    canSetWorkItemState: () => false,
    canPlaceWorkItem: () => false,
    setWorkItemParent: () => Promise.reject(new Error('not used')),
    setWorkItemAreaPath: () => Promise.reject(new Error('not used')),
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
    setPrLabel: ok,
    setIssueLabel: ok,
    setWorkItemState: ok,
    linkWorkItem: ok,
    upsertIssueComment: ok,
    createIssue: ok,
    createPullRequest: ok,
    setPullTitle: ok,
    setPullBase: ok,
    updatePrBranch: ok,
    requeueCiCheck: ok,
    deleteBranch: ok,
  };
}

function build(sink?: ActionSink, overrides: Record<string, unknown> = {}) {
  return buildSystem(testConfig(overrides), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    ...(sink ? { sink } : {}),
  });
}

test('with sendPrRepliesWithoutApproval off, a drafted reply is never sent — it is proposed, and waits', async () => {
  const sink = countingSink();
  const system = build(sink, { sendPrRepliesWithoutApproval: false });
  await system.executor.execute('cyc', replyPlan());

  assert.deepEqual(sink.replies, [], 'nothing may go out unauthorized');
  const open = system.store.escalations.listOpenEscalations();
  assert.equal(open.length, 1, 'it is asked, not sent');
  assert.equal(open[0]!.type, 'review_reply');
  assert.match(replyDecision(system)!.detail, /proposed it for approval/);

  const [proposal] = system.store.escalations.listProposals();
  assert.equal(proposal!.status, 'pending');
  assert.equal(proposal!.decidedBy, null);
  assert.ok(proposal!.escalationId, 'a pending proposal hangs off its inbox item');
  system.store.close();
});

test('on the default the same draft goes out, and the row names the config as the authority', async () => {
  const sink = countingSink();
  const system = build(sink);
  await system.executor.execute('cyc', replyPlan());

  assert.deepEqual(sink.replies, [42], 'the operator authorized this class of act in advance');
  assert.equal(system.store.escalations.listOpenEscalations().length, 0, 'nothing is being asked of anyone');

  const [proposal] = system.store.escalations.listProposals();
  assert.equal(proposal!.status, 'accepted');
  assert.equal(proposal!.decidedBy, 'auto_send');
  assert.equal(proposal!.escalationId, null);
  assert.match(proposal!.note ?? '', /sendPrRepliesWithoutApproval/);
  assert.match(replyDecision(system)!.detail, /authorized by auto-send/);
  system.store.close();
});

test('a merge-ready PR is never merged on the harness’s own say-so', async () => {
  const sink = countingSink();
  const system = build(sink);
  await system.executor.execute('cyc', mergePlan());

  assert.deepEqual(sink.merges, [], 'nothing merges autonomously');
  const open = system.store.escalations.listOpenEscalations();
  assert.equal(open.length, 1);
  assert.equal(open[0]!.type, 'approve_change');
  assert.match(mergeDecision(system)!.detail, /proposed the merge for approval/);
  assert.equal(system.store.escalations.listProposals()[0]!.status, 'pending');
  system.store.close();
});

test('a pending ask is not re-asked, and a world signal is no back door to answering it', async () => {
  const sink = countingSink();
  const system = build(sink);
  await system.executor.execute('cyc-1', mergePlan());

  system.store.world.recordWorldEvents([{ kind: 'pr_ci', ref: 'pr:42', summary: 'PR #42 CI passing' }]);
  await system.executor.execute('cyc-2', mergePlan());

  assert.equal(system.store.escalations.listProposals().length, 1, 'one act, one question');
  assert.deepEqual(sink.merges, []);
  assert.equal(system.store.escalations.listProposals().filter((p) => p.status === 'rejected').length, 0);
  const skipped = system.store.decisions.listDecisions().find((d) => d.outcome === 'skipped')!;
  assert.match(skipped.detail, /Skipped merge of PR #42: awaiting your accept\/reject/);
  system.store.close();
});

test('a standing stack landing is the one thing that authorizes a merge without a click on it', async () => {
  const sink = countingSink();
  const system = build(sink);
  system.store.landings.recordStackLanding('stack:feat', [42]);

  await system.executor.execute('cyc', mergePlan());

  assert.deepEqual(sink.merges, [42], 'the operator authorized this chain in advance');
  assert.equal(system.store.escalations.listOpenEscalations().length, 0, 'nothing is asked — it was already answered');
  const [proposal] = system.store.escalations.listProposals();
  assert.equal(proposal!.status, 'accepted');
  assert.equal(proposal!.decidedBy, 'stack_landing', 'and the authority is named, not implied');
  assert.match(proposal!.note ?? '', /you authorized landing stack:feat/);
  assert.equal(proposal!.escalationId, null, 'nothing was asked of anyone');
  system.store.close();
});

test('a landing authorizes only the rungs it was clicked over', async () => {
  const sink = countingSink();
  const system = build(sink);
  system.store.landings.recordStackLanding('stack:other', [7]);

  await system.executor.execute('cyc', mergePlan());

  assert.deepEqual(sink.merges, [], 'PR #42 is not in the chain the operator landed');
  assert.equal(system.store.escalations.listProposals()[0]!.status, 'pending');
  system.store.close();
});

test('an authorized act that fails is escalated, never dropped, and stays authorized', async () => {
  const system = build(countingSink(true));
  system.store.landings.recordStackLanding('stack:feat', [42]);

  await system.executor.execute('cyc', mergePlan());

  const open = system.store.escalations.listOpenEscalations();
  const failed = open.find((e) => e.context.autoMergeFailed === true);
  assert.ok(failed, 'a failed act must still surface for a human');
  assert.match(failed.prompt, /merging PR #42, but the merge failed \(merge conflict\)/);
  assert.ok(
    system.store.landings.listStandingLandings().every((l) => !l.rungs.includes(42)),
    'and the intent that authorized it no longer stands',
  );
  assert.match(mergeDecision(system)!.detail, /failed \(merge conflict\)/);
  const [proposal] = system.store.escalations.listProposals();
  assert.equal(proposal!.status, 'accepted');
  assert.equal(proposal!.decidedBy, 'stack_landing');
  system.store.close();
});

test('an authorized act is not re-proposed on every pulse while the world catches up', async () => {
  const sink = countingSink();
  const system = build(sink);
  system.store.landings.recordStackLanding('stack:feat', [42]);

  await system.executor.execute('cyc-1', mergePlan());
  await system.executor.execute('cyc-2', mergePlan());
  await system.executor.execute('cyc-3', mergePlan());

  assert.equal(system.store.escalations.listProposals().length, 1, 'one act, one proposal');
  assert.deepEqual(sink.merges, [42], 'and one merge');
  const skipped = system.store.decisions.listDecisions().filter((d) => d.outcome === 'skipped');
  assert.equal(skipped.length, 2);
  assert.match(skipped[0]!.detail, /already authorized/);
  system.store.close();
});

test('accepting a threaded reply sends it and settles the comment it answered', async () => {
  const system = build(undefined, { sendPrRepliesWithoutApproval: false });
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'feat' });
  system.connector.inject({ kind: 'pr_comment', prNumber: 42, author: 'bob', body: 'why this?' });
  const before = (await system.connector.getState()).pullRequests[0]!.unresolvedComments[0]!;
  assert.equal(before.handled, false);

  const plan = {
    rationale: 'test',
    rejected: [],
    actions: [{ type: 'reply_on_pr', prNumber: 42, commentId: before.id, draft: 'Because X.', reason: 'answer' }],
  } as unknown as DispatchResult;
  await system.executor.execute('cyc', plan);

  const mid = (await system.connector.getState()).pullRequests[0]!.unresolvedComments[0]!;
  assert.equal(mid.handled, false, 'proposing it changes nothing in the world');

  const [proposal] = system.store.escalations.listProposals();
  await system.proposals.accept(proposal!.id);

  const after = (await system.connector.getState()).pullRequests[0]!.unresolvedComments[0]!;
  assert.equal(after.handled, true, 'the sent reply marks the comment handled');
  assert.equal(system.store.escalations.listProposals()[0]!.decidedBy, 'human');
  system.store.close();
});
