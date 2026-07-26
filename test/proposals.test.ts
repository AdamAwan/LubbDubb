import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { Store } from '../src/store/store.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import type { ActionSink } from '../src/sink/actionSink.js';
import type { DispatchResult } from '../src/dispatcher/dispatcher.js';

function testConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    dbPath: ':memory:',
    dispatcher: 'rule',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    ...overrides,
  });
}

/** A plan carrying a single merge_pr action — what rule 3 emits for a settled PR. */
function mergePlan(prNumber = 42): DispatchResult {
  return {
    rationale: 'test',
    rejected: [],
    actions: [
      { type: 'merge_pr', prNumber, method: 'squash', confidence: 0.9, reason: 'green, approved and mergeable' },
    ],
  } as unknown as DispatchResult;
}

/** A sink that counts what actually went out, so "exactly once" is observable. */
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
    async setStoryLabel() {
      return { ok: true };
    },
    async setWorkItemState() {
      return { ok: true };
    },
    async upsertIssueComment() {
      return { ok: true };
    },
  };
}

test('a gated merge becomes a pending proposal, and accepting it merges — once', async () => {
  const sink = countingSink();
  const system = buildSystem(testConfig(), { backend: new FakePtyBackend(), sink });

  await system.executor.execute('cyc', mergePlan());

  const [proposal] = system.store.listProposals();
  assert.ok(proposal, 'the gated merge should be recorded as a proposal, not just an escalation');
  assert.equal(proposal.kind, 'merge');
  assert.equal(proposal.ref, 'pr:42:merge');
  assert.equal(proposal.status, 'pending');
  assert.equal(sink.merges.length, 0, 'nothing merges before a human says so');
  // It hangs off the inbox item rather than replacing it.
  assert.equal(system.store.getEscalation(proposal.escalationId!)!.type, 'approve_change');

  const accepted = await system.proposals.accept(proposal.id, 'looks good');
  assert.equal(accepted!.outcome, 'performed');
  assert.deepEqual(sink.merges, [42], 'accepting is what performs the act');
  assert.equal(system.store.getProposal(proposal.id)!.status, 'accepted');
  assert.equal(system.store.getProposal(proposal.id)!.decidedBy, 'human');
  // The inbox item is settled by the verdict, so "needs you" empties on the click.
  assert.equal(system.store.getEscalation(proposal.escalationId!)!.status, 'answered');
  // The human is named in the audit trail — the half of it that was missing.
  const audited = system.store.listDecisions().find((d) => d.cycleId === `human:${proposal.id}`);
  assert.match(audited!.detail, /Merged PR #42 via squash — authorized by you/);

  // Accepting twice posts once: the transition is one-way.
  assert.equal(await system.proposals.accept(proposal.id), null);
  assert.deepEqual(sink.merges, [42]);
  system.store.close();
});

test('a rejected proposal posts nothing and records the reason', async () => {
  const sink = countingSink();
  const system = buildSystem(testConfig(), { backend: new FakePtyBackend(), sink });
  await system.executor.execute('cyc', mergePlan());
  const [proposal] = system.store.listProposals();

  const rejected = system.proposals.reject(proposal!.id, 'wait for the release branch');
  assert.equal(rejected!.outcome, 'none');
  assert.equal(sink.merges.length, 0, 'a rejection sends nothing');

  const stored = system.store.getProposal(proposal!.id)!;
  assert.equal(stored.status, 'rejected');
  assert.equal(stored.note, 'wait for the release branch');
  const audited = system.store.listDecisions().find((d) => d.cycleId === `human:${proposal!.id}`);
  assert.match(audited!.detail, /Rejected by you: wait for the release branch/);
  assert.equal(system.store.getEscalation(proposal!.escalationId!)!.status, 'answered');
  // Rejecting twice is a no-op too — the transition is one-way in both directions.
  assert.equal(system.proposals.reject(proposal!.id), null);
  system.store.close();
});

test('an accepted act whose send fails re-escalates rather than dropping', async () => {
  const sink = countingSink(true);
  const system = buildSystem(testConfig(), { backend: new FakePtyBackend(), sink });
  await system.executor.execute('cyc', mergePlan());
  const [proposal] = system.store.listProposals();

  const accepted = await system.proposals.accept(proposal!.id);
  assert.equal(accepted!.outcome, 'failed');
  assert.deepEqual(sink.merges, [42], 'it was attempted');

  // The original inbox item is answered (you did decide), and the failure is a
  // fresh one carrying the same fallback context the auto-send path uses.
  const open = system.store.listOpenEscalations();
  assert.equal(open.length, 1);
  assert.equal(open[0]!.context.autoMergeFailed, true);
  assert.match(open[0]!.prompt, /You approved merging PR #42, but the merge failed \(merge conflict\)/);
  const audited = system.store.listDecisions().find((d) => d.cycleId === `human:${proposal!.id}`);
  assert.equal(audited!.outcome, 'rejected');
  assert.match(audited!.detail, /escalated so it isn't dropped/);
  system.store.close();
});

test('a pending proposal suppresses re-proposal on the next cycle', async () => {
  const sink = countingSink();
  const system = buildSystem(testConfig(), { backend: new FakePtyBackend(), sink });

  // A PR rule 3 wants to merge: green, approved, mergeable, nothing else pending.
  system.connector.inject({ kind: 'new_pr', number: 7, title: 'Add the widget', branch: 'feat/widget' });
  system.connector.inject({ kind: 'ci_passed', prNumber: 7 });
  system.connector.inject({ kind: 'pr_approved', prNumber: 7 });
  system.connector.inject({ kind: 'pr_mergeable', prNumber: 7, mergeable: true, mergeableState: 'clean' });

  await system.harness.runCycle('manual');
  const first = system.store.listProposals();
  assert.equal(first.length, 1, 'rule 3 should propose the merge once');
  assert.equal(first[0]!.ref, 'pr:7:merge');
  const escalationsAfterOne = system.store.listOpenEscalations().length;

  // The world has not changed and the human has not answered: asking again would
  // fill the inbox with copies of one question.
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');
  assert.equal(system.store.listProposals().length, 1, 'the pending verdict holds rule 3 off that PR');
  assert.equal(system.store.listOpenEscalations().length, escalationsAfterOne);

  // A rejection is durable for the same reason: "no" must not mean "not this second".
  system.proposals.reject(first[0]!.id, 'not yet');
  await system.harness.runCycle('manual');
  assert.equal(system.store.listProposals().length, 1);
  assert.equal(sink.merges.length, 0);
  system.store.close();
});

test('the executor refuses a duplicate proposal even when the dispatcher gate is bypassed', async () => {
  // The LLM dispatcher composes actions freely, so the rule-side gate cannot be
  // the only one. Two identical plans through the executor must ask once.
  const sink = countingSink();
  const system = buildSystem(testConfig(), { backend: new FakePtyBackend(), sink });

  await system.executor.execute('cyc-1', mergePlan());
  await system.executor.execute('cyc-2', mergePlan());

  assert.equal(system.store.listProposals().length, 1);
  assert.equal(system.store.listOpenEscalations().length, 1);
  const skipped = system.store.listDecisions().find((d) => d.outcome === 'skipped' && d.action.type === 'merge_pr');
  assert.match(skipped!.detail, /Skipped merge of PR #42: awaiting your accept\/reject/);
  system.store.close();
});

test('a drafted reply is proposed, and accepting it sends that draft', async () => {
  const sink = countingSink();
  const system = buildSystem(testConfig(), { backend: new FakePtyBackend(), sink });
  const plan = {
    rationale: 'test',
    rejected: [],
    actions: [
      {
        type: 'reply_on_pr',
        prNumber: 42,
        commentId: 'c-1',
        draft: 'Addressed in the latest commit.',
        confidence: 0.5,
        reason: 'reviewer asked a question',
      },
    ],
  } as unknown as DispatchResult;

  await system.executor.execute('cyc', plan);
  const [proposal] = system.store.listProposals();
  assert.equal(proposal!.kind, 'reply_draft');
  assert.equal(proposal!.ref, 'pr:42:comment:c-1', 'a threaded draft keys on the comment it answers');

  await system.proposals.accept(proposal!.id);
  assert.deepEqual(sink.replies, [42]);
  system.store.close();
});

test('a database created before proposals existed opens and works after them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-migrate-'));
  const dbPath = join(dir, 'old.db');
  // An older build's database: every table this one has except `proposals`.
  const old = new Database(dbPath);
  old.exec(`CREATE TABLE escalations (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, prompt TEXT NOT NULL,
      context TEXT NOT NULL, agent_id TEXT, task_id TEXT, response TEXT,
      created_at TEXT NOT NULL, answered_at TEXT);
    INSERT INTO escalations VALUES ('esc_old','approve_change','open','merge?','{}',NULL,NULL,NULL,'2026-01-01T00:00:00Z',NULL);`);
  old.close();

  const store = new Store(dbPath);
  // The pre-existing row still reads, and the new table is there to write to.
  assert.equal(store.listOpenEscalations().length, 1);
  const proposal = store.createProposal({
    kind: 'merge',
    ref: 'pr:1:merge',
    action: { type: 'merge_pr', reason: 'test', prNumber: 1, method: 'squash' },
    escalationId: 'esc_old',
  });
  assert.equal(store.listProposals().length, 1);
  assert.equal(store.decideProposal(proposal.id, 'accepted', null, 'human')!.status, 'accepted');
  store.close();
});
