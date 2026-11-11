import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { reviewRecheckNote } from '../src/dispatcher/reviewThreads.js';
import type { ActionSink, PrReplyInput } from '../src/sink/actionSink.js';
import type { Agent, PrReviewThread, PrThreadMessage } from '../src/types.js';

function sink(): ActionSink & { sent: PrReplyInput[] } {
  const sent: PrReplyInput[] = [];
  const ok = async () => ({ ok: true as const });
  const never = (): never => {
    throw new Error('not scripted in this test');
  };
  return {
    sent,
    canCloseIssue: () => false,
    canReopenIssue: () => false,
    reopenIssue: never,
    canClosePr: () => false,
    closePr: never,
    canResolvePrThread: () => true,
    resolvePrThread: ok,
    closeIssue: never,
    canSetWorkItemState: () => false,
    canPlaceWorkItem: () => false,
    setWorkItemParent: () => Promise.reject(new Error('not used')),
    setWorkItemAreaPath: () => Promise.reject(new Error('not used')),
    mergePr: ok,
    async postPrReply(input) {
      sent.push(input);
      return { ok: true, ref: `pr:${input.prNumber}`, commentRef: input.edits ?? `r-${sent.length}` };
    },
    setPrLabel: ok,
    setIssueLabel: ok,
    setWorkItemState: ok,
    linkWorkItem: ok,
    async createIssue() {
      return { ok: true as const, ref: 'issue:1' };
    },
    upsertIssueComment: ok,
    createPullRequest: ok,
    setPullTitle: ok,
    setPullBody: ok,
    setPullBase: ok,
    updatePrBranch: ok,
    requeueCiCheck: ok,
    deleteBranch: ok,
  };
}

function build(s: ActionSink, autoSend = true): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-restraint-'));
  const config = loadConfig({
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    sendPrRepliesWithoutApproval: autoSend,
  });
  return buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    sink: s,
    errorMirror: () => {},
  });
}

function thread(id: string, state: PrReviewThread['state'], replies: PrThreadMessage[] = []): PrReviewThread {
  return { id, author: 'reviewer', body: 'Why is this cached?', state, replies };
}

function seed(system: System, threads: PrReviewThread[]): void {
  system.store.world.setWorldBaseline({
    takenAt: new Date().toISOString(),
    issues: [],
    pullRequests: [
      {
        id: 'pr-42',
        number: 42,
        title: 'A pull request',
        branch: 'feature/x',
        ciStatus: 'passing',
        unresolvedComments: [],
        reviewThreads: threads,
      },
    ],
  });
}

function agentFor(system: System): Agent {
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: 'Address review comments on PR #42',
    prompt: 'answer them',
    branch: 'feature/x',
    originRef: 'pr:42:comments',
    originTitle: 'A pull request',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function reply(system: System, agent: Agent, args: Record<string, unknown>) {
  const result = (await system.mcp.session(agent.id)!.call('reply_to_review', {
    about_comment: false,
    changed_code: false,
    ...args,
  })) as { content: { text: string }[]; isError?: boolean };
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

const ours: PrThreadMessage = { id: 'r-9', author: 'operator', body: 'Kept: keyed on branch.', ours: true };

test('a thread whose last word is the fleet’s is not answered again', async () => {
  const s = sink();
  const system = build(s);
  seed(system, [thread('c-1', 'answered', [ours])]);
  const res = await reply(system, agentFor(system), { body: 'No change since my last reply.', thread: 'c-1' });
  assert.equal(res.isError, true);
  assert.match(res.text, /already answered/);
  assert.equal(s.sent.length, 0);
  system.store.close();
});

test('a reviewer writing after the fleet opens the thread to a new reply', async () => {
  const s = sink();
  const system = build(s);
  const theirs: PrThreadMessage = { id: 'r-10', author: 'reviewer', body: 'Still unsure.', ours: false };
  seed(system, [thread('c-1', 'open', [ours, theirs]), thread('c-2', 'reopened', [ours])]);
  const agent = agentFor(system);
  assert.equal((await reply(system, agent, { body: 'Fixed in abc123.', thread: 'c-1' })).isError, false);
  assert.equal((await reply(system, agent, { body: 'Fixed in abc123.', thread: 'c-2' })).isError, false);
  assert.equal(s.sent.length, 2);
  assert.equal(s.sent[0]!.edits, undefined);
  system.store.close();
});

test('an over-long reply is refused', async () => {
  const s = sink();
  const system = build(s);
  const res = await reply(system, agentFor(system), { body: 'x'.repeat(601), thread: 'c-1' });
  assert.equal(res.isError, true);
  assert.match(res.text, /limit is 600/);
  assert.equal(s.sent.length, 0);
  system.store.close();
});

test('a correction edits the fleet’s earlier reply rather than appending one', async () => {
  const s = sink();
  const system = build(s);
  seed(system, [thread('c-1', 'answered', [ours])]);
  const res = await reply(system, agentFor(system), {
    body: 'Fixed in abc123: dropped the cache.',
    thread: 'c-1',
    correction: true,
  });
  assert.equal(res.isError, false, res.text);
  assert.deepEqual(s.sent, [
    { prNumber: 42, commentId: 'c-1', body: 'Fixed in abc123: dropped the cache.', edits: 'r-9' },
  ]);
  system.store.close();
});

test('a correction is refused where the fleet does not hold the last word', async () => {
  const s = sink();
  const system = build(s);
  seed(system, [thread('c-1', 'open')]);
  const res = await reply(system, agentFor(system), { body: 'Fixed.', thread: 'c-1', correction: true });
  assert.equal(res.isError, true);
  assert.match(res.text, /correction needs/);
  assert.equal(s.sent.length, 0);
  system.store.close();
});

test('the recheck note counts only unhandled threads as new arrivals', () => {
  assert.match(reviewRecheckNote(42), /handled: false/);
});

test('a held correction is not sent once the reviewer has written since', async () => {
  const s = sink();
  const system = build(s, false);
  seed(system, [thread('c-1', 'answered', [ours])]);
  const res = await reply(system, agentFor(system), {
    body: 'Fixed in abc123.',
    thread: 'c-1',
    correction: true,
    resolved: true,
  });
  assert.equal(res.isError, false, res.text);
  const theirs: PrThreadMessage = { id: 'r-10', author: 'reviewer', body: 'Wait, why?', ours: false };
  seed(system, [thread('c-1', 'open', [ours, theirs])]);
  const [proposal] = system.store.escalations.listProposals();
  const outcome = await system.proposals.accept(proposal!.id);
  assert.equal(s.sent.length, 0, 'neither an edit nor a new reply goes out');
  assert.match(JSON.stringify(outcome), /no longer the last word/);
  system.store.close();
});
