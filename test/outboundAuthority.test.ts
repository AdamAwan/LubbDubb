import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import type { ActionSink } from '../src/sink/actionSink.js';
import type { DispatchResult } from '../src/dispatcher/dispatcher.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

/**
 * **The harness authorizes no outbound act on its own.**
 *
 * There was a confidence gate here once: a dispatcher-reported number compared
 * against a configured threshold decided whether a reply or a merge went out
 * without anyone being asked. It is gone, and this file is what holds the line it
 * left — every act the harness can publish is written as a `Proposal` and waits.
 *
 * One authority survives, and it is still the operator's: a **standing stack
 * landing**, clicked once over a named set of pull requests. It is not a
 * widening — it answers "you authorized this chain in advance", over rungs the
 * operator picked, rather than "the harness cleared its own bar".
 */

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    dbPath: ':memory:',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
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
  return system.store.listDecisions().find((d) => d.action.type === 'reply_on_pr');
}

function mergeDecision(system: ReturnType<typeof buildSystem>) {
  return system.store.listDecisions().find((d) => d.action.type === 'merge_pr');
}

/** A sink that counts what actually went out, so "nothing was sent" is observable. */
function countingSink(fail = false): ActionSink & { merges: number[]; replies: number[] } {
  const merges: number[] = [];
  const replies: number[] = [];
  const ok = async () => ({ ok: true as const });
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
    setPrLabel: ok,
    setIssueLabel: ok,
    setWorkItemState: ok,
    linkWorkItem: ok,
    upsertIssueComment: ok,
    createPullRequest: ok,
    setPullTitle: ok,
    setPullBase: ok,
    updatePrBranch: ok,
    deleteBranch: ok,
  };
}

function build(sink?: ActionSink) {
  return buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    ...(sink ? { sink } : {}),
  });
}

test('a drafted reply is never sent — it is proposed, and waits', async () => {
  const sink = countingSink();
  const system = build(sink);
  await system.executor.execute('cyc', replyPlan());

  assert.deepEqual(sink.replies, [], 'nothing may go out unauthorized');
  const open = system.store.listOpenEscalations();
  assert.equal(open.length, 1, 'it is asked, not sent');
  assert.equal(open[0]!.type, 'review_reply');
  assert.match(replyDecision(system)!.detail, /proposed it for approval/);

  // Nobody has authorized it, so the proposal is pending and carries no decider.
  const [proposal] = system.store.listProposals();
  assert.equal(proposal!.status, 'pending');
  assert.equal(proposal!.decidedBy, null);
  assert.ok(proposal!.escalationId, 'a pending proposal hangs off its inbox item');
  system.store.close();
});

test('a merge-ready PR is never merged on the harness’s own say-so', async () => {
  const sink = countingSink();
  const system = build(sink);
  await system.executor.execute('cyc', mergePlan());

  assert.deepEqual(sink.merges, [], 'nothing merges autonomously');
  const open = system.store.listOpenEscalations();
  assert.equal(open.length, 1);
  assert.equal(open[0]!.type, 'approve_change');
  assert.match(mergeDecision(system)!.detail, /proposed the merge for approval/);
  assert.equal(system.store.listProposals()[0]!.status, 'pending');
  system.store.close();
});

test('a pending ask is not re-asked, and a world signal is no back door to answering it', async () => {
  const sink = countingSink();
  const system = build(sink);
  await system.executor.execute('cyc-1', mergePlan());

  // Waiting on a human is not a rejection — a machine "no" would be durable and
  // would suppress the ask for good — but it is also not an invitation to ask
  // again every pulse.
  system.store.recordWorldEvents([{ kind: 'pr_ci', ref: 'pr:42', summary: 'PR #42 CI passing' }]);
  await system.executor.execute('cyc-2', mergePlan());

  assert.equal(system.store.listProposals().length, 1, 'one act, one question');
  assert.deepEqual(sink.merges, []);
  assert.equal(system.store.listProposals().filter((p) => p.status === 'rejected').length, 0);
  const skipped = system.store.listDecisions().find((d) => d.outcome === 'skipped')!;
  assert.match(skipped.detail, /Skipped merge of PR #42: awaiting your accept\/reject/);
  system.store.close();
});

test('a standing stack landing is the one thing that authorizes a merge without a click on it', async () => {
  const sink = countingSink();
  const system = build(sink);
  system.store.recordStackLanding('stack:feat', [42]);

  await system.executor.execute('cyc', mergePlan());

  assert.deepEqual(sink.merges, [42], 'the operator authorized this chain in advance');
  assert.equal(system.store.listOpenEscalations().length, 0, 'nothing is asked — it was already answered');
  const [proposal] = system.store.listProposals();
  assert.equal(proposal!.status, 'accepted');
  assert.equal(proposal!.decidedBy, 'stack_landing', 'and the authority is named, not implied');
  assert.match(proposal!.note ?? '', /you authorized landing stack:feat/);
  assert.equal(proposal!.escalationId, null, 'nothing was asked of anyone');
  system.store.close();
});

test('a landing authorizes only the rungs it was clicked over', async () => {
  const sink = countingSink();
  const system = build(sink);
  system.store.recordStackLanding('stack:other', [7]);

  await system.executor.execute('cyc', mergePlan());

  assert.deepEqual(sink.merges, [], 'PR #42 is not in the chain the operator landed');
  assert.equal(system.store.listProposals()[0]!.status, 'pending');
  system.store.close();
});

test('an authorized act that fails is escalated, never dropped, and stays authorized', async () => {
  const system = build(countingSink(true));
  system.store.recordStackLanding('stack:feat', [42]);

  await system.executor.execute('cyc', mergePlan());

  // Two things are raised, and both are wanted: the act itself failed, and the
  // standing landing that authorized it is stopped so it does not re-authorize a
  // merge that will not go through on every pulse.
  const open = system.store.listOpenEscalations();
  const failed = open.find((e) => e.context.autoMergeFailed === true);
  assert.ok(failed, 'a failed act must still surface for a human');
  assert.match(failed.prompt, /merging PR #42, but the merge failed \(merge conflict\)/);
  assert.ok(
    system.store.listStandingLandings().every((l) => !l.rungs.includes(42)),
    'and the intent that authorized it no longer stands',
  );
  assert.match(mergeDecision(system)!.detail, /failed \(merge conflict\)/);
  // It *was* authorized, and the merge failing does not un-authorize it. Once the
  // settle window lapses the act is proposed again if the world still warrants it.
  const [proposal] = system.store.listProposals();
  assert.equal(proposal!.status, 'accepted');
  assert.equal(proposal!.decidedBy, 'stack_landing');
  system.store.close();
});

test('an authorized act is not re-proposed on every pulse while the world catches up', async () => {
  const sink = countingSink();
  const system = build(sink);
  system.store.recordStackLanding('stack:feat', [42]);

  await system.executor.execute('cyc-1', mergePlan());
  await system.executor.execute('cyc-2', mergePlan());
  await system.executor.execute('cyc-3', mergePlan());

  assert.equal(system.store.listProposals().length, 1, 'one act, one proposal');
  assert.deepEqual(sink.merges, [42], 'and one merge');
  const skipped = system.store.listDecisions().filter((d) => d.outcome === 'skipped');
  assert.equal(skipped.length, 2);
  assert.match(skipped[0]!.detail, /already authorized/);
  system.store.close();
});

test('accepting a threaded reply sends it and settles the comment it answered', async () => {
  const system = build();
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

  const [proposal] = system.store.listProposals();
  await system.proposals.accept(proposal!.id);

  const after = (await system.connector.getState()).pullRequests[0]!.unresolvedComments[0]!;
  assert.equal(after.handled, true, 'the sent reply marks the comment handled');
  assert.equal(system.store.listProposals()[0]!.decidedBy, 'human');
  system.store.close();
});
