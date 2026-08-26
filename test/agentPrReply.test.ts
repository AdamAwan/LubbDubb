import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { replyOrigin, replyToolNote } from '../src/dispatcher/reviewThreads.js';
import type { ActionSink } from '../src/sink/actionSink.js';
import type { Agent } from '../src/types.js';

/**
 * An agent's reply to a review thread goes through the harness, never out of the
 * agent.
 *
 * The behaviour this file holds is one sentence: `reply_to_review` raises the
 * same `reply_on_pr` act a rule raises and sends nothing itself. Everything the
 * harness has built around that act — the hold, the operator's rejection, the
 * authority, the sign-off, the escalation on a failed send — then applies to an
 * agent's reply because it is the *same* act, and none of it applies to a `gh`
 * call from inside a worktree.
 *
 * The sign-off itself is `test/signOff.test.ts`': these inject a counting sink,
 * which is deliberately the unsigned seam — what is asserted here is that the
 * body reaches `ActionSink.postPrReply` at all, which is the one path
 * `CompositeConnector.signed` wraps.
 */

function testConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-reply-'));
  return loadConfig({
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    ...overrides,
  });
}

/** What actually went out, so "nothing was sent" is observable. */
function countingSink(
  script: { canResolve?: boolean; resolveThrows?: string; noSuchThread?: boolean } = {},
): ActionSink & {
  replies: { prNumber: number; commentId: string | null; body: string }[];
  resolved: { prNumber: number; commentId: string }[];
} {
  const replies: { prNumber: number; commentId: string | null; body: string }[] = [];
  const resolved: { prNumber: number; commentId: string }[] = [];
  const ok = async () => ({ ok: true as const });
  return {
    replies,
    resolved,
    canCloseIssue: () => false,
    canResolvePrThread: () => script.canResolve !== false,
    async resolvePrThread({ prNumber, commentId }) {
      if (script.resolveThrows) throw new Error(script.resolveThrows);
      resolved.push({ prNumber, commentId });
      return { ok: script.noSuchThread !== true, ref: commentId };
    },
    closeIssue: (): never => {
      throw new Error('closeIssue is not scripted in this test');
    },
    canSetWorkItemState: () => false,
    canPlaceWorkItem: () => false,
    setWorkItemParent: () => Promise.reject(new Error('not used')),
    setWorkItemAreaPath: () => Promise.reject(new Error('not used')),
    async mergePr({ prNumber }) {
      return { ok: true, ref: `pr:${prNumber}` };
    },
    async postPrReply({ prNumber, commentId, body }) {
      replies.push({ prNumber, commentId, body });
      return { ok: true, ref: `pr:${prNumber}` };
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
    setPullBase: ok,
    updatePrBranch: ok,
    requeueCiCheck: ok,
    deleteBranch: ok,
  };
}

/**
 * `worktrees` is injected because this builds a whole system: without it
 * `config.repoRoot` defaults to `process.cwd()` and a dispatch cuts a real branch
 * in whoever's checkout is running the suite.
 */
function build(sink: ActionSink, overrides: Record<string, unknown> = {}): System {
  return buildSystem(testConfig(overrides), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    sink,
    errorMirror: () => {},
  });
}

/** A review agent on PR #42, as rule `pr-review-comment` dispatches one. */
function reviewAgent(system: System, originRef = 'pr:42:comments'): Agent {
  const task = system.store.createTask({
    kind: 'code',
    title: 'Address review comments on PR #42',
    prompt: 'answer them',
    branch: 'feature/x',
    originRef,
    originTitle: 'A pull request',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function callReply(system: System, agent: Agent, args: Record<string, unknown>) {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call('reply_to_review', args)) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

test('with sendPrRepliesWithoutApproval off, the reply is proposed — and accepting it sends that body', async () => {
  const sink = countingSink();
  // The stricter posture. On the default the reply goes out, which the test below
  // covers: an agent already posted its own replies with nobody asked, so what the
  // harness changes there is who signs and records it, not whether it goes.
  const system = build(sink, { sendPrRepliesWithoutApproval: false });
  const agent = reviewAgent(system);

  const res = await callReply(system, agent, {
    body: 'Keeping the current approach: the cache is keyed on the branch, so the race cannot arise.',
    thread: 'c-1',
  });
  assert.equal(res.isError, false);
  assert.equal(sink.replies.length, 0, 'the tool sends nothing itself');

  const [proposal] = system.store.listProposals();
  assert.equal(proposal!.kind, 'reply_draft');
  assert.equal(proposal!.ref, 'pr:42:comment:c-1', 'the draft keys on the thread it answers');
  assert.equal(proposal!.status, 'pending');
  assert.equal(system.store.listOpenEscalations().length, 1, 'and it is put to the operator');

  await system.proposals.accept(proposal!.id);
  assert.equal(sink.replies.length, 1);
  assert.equal(sink.replies[0]!.prNumber, 42);
  assert.equal(sink.replies[0]!.commentId, 'c-1');
  assert.match(sink.replies[0]!.body, /keyed on the branch/);
  system.store.close();
});

test('the pull request comes from the origin, so an agent cannot answer another one', async () => {
  const sink = countingSink();
  const system = build(sink);
  const agent = reviewAgent(system, 'issue:12');

  const res = await callReply(system, agent, { body: 'Looks fine to me.', thread: 'c-1' });
  assert.equal(res.isError, true);
  assert.match(res.text, /only for an agent dispatched to answer/);
  // And the refusal says what to do instead, rather than leaving the habit it
  // is displacing as the only option the agent can see.
  assert.match(res.text, /do not post to the thread yourself/i);
  assert.equal(system.store.listProposals().length, 0);
  system.store.close();
});

test('an empty reply is refused, and nothing is proposed for it', async () => {
  const sink = countingSink();
  const system = build(sink);
  const agent = reviewAgent(system);

  const res = await callReply(system, agent, { body: '   ', thread: 'c-1' });
  assert.equal(res.isError, true);
  assert.match(res.text, /body is required/);
  assert.equal(system.store.listProposals().length, 0);
  system.store.close();
});

test('on the default the reply goes out, and the row says which authority sent it', async () => {
  const sink = countingSink();
  // No override: the key is on unless an operator turns it off.
  const system = build(sink);
  const agent = reviewAgent(system);

  const res = await callReply(system, agent, { body: 'Fixed in the latest commit.', thread: 'c-1' });
  assert.equal(res.isError, false);
  assert.equal(sink.replies.length, 1, 'the operator authorized this class of act in advance');
  assert.equal(system.store.listOpenEscalations().length, 0, 'nothing is being asked of anyone');

  const [proposal] = system.store.listProposals();
  assert.equal(proposal!.status, 'accepted', 'the row is still written — it is the audit trail');
  assert.equal(proposal!.decidedBy, 'auto_send');
  assert.equal(proposal!.escalationId, null);
  // Six weeks later, a reply the operator clicked has to be tellable from one
  // their config sent, and the key's own name is what says the second.
  assert.match(proposal!.note ?? '', /sendPrRepliesWithoutApproval/);
  const decision = system.store.listDecisions().find((d) => d.action.type === 'reply_on_pr');
  assert.match(decision!.detail, /authorized by auto-send/);
  system.store.close();
});

test('auto-send never overrides a rejection the operator already gave', async () => {
  const sink = countingSink();
  const system = build(sink);
  const agent = reviewAgent(system);

  // The operator refused a reply on this very thread. "I do not need to be asked"
  // is not "ignore what I said no to", so the hold still governs.
  const refused = system.store.createProposal({
    kind: 'reply_draft',
    ref: 'pr:42:comment:c-1',
    action: { type: 'reply_on_pr', reason: 'earlier draft', prNumber: 42, commentId: 'c-1', draft: 'Nope.' },
    escalationId: null,
  });
  system.store.decideProposal(refused.id, 'rejected', 'too defensive', 'human');

  const res = await callReply(system, agent, { body: 'Still keeping it.', thread: 'c-1' });
  assert.equal(res.isError, false, 'a held reply is not the agent’s fault');
  assert.equal(sink.replies.length, 0, 'and nothing went out');
  assert.match(res.text, /you refused|Skipped/i);
  system.store.close();
});

test('and it authorizes replies only — a merge still waits for the operator', async () => {
  const sink = countingSink();
  const system = build(sink);
  await system.executor.execute('cyc', {
    rationale: 'test',
    rejected: [],
    actions: [{ type: 'merge_pr', prNumber: 42, method: 'squash', reason: 'green' }],
  } as never);

  const [proposal] = system.store.listProposals();
  assert.equal(proposal!.kind, 'merge');
  assert.equal(proposal!.status, 'pending', 'a merge is authorized per pull request, by landing a stack');
  system.store.close();
});

test('the review prompt names the tool and forbids posting to the thread by hand', () => {
  const note = replyToolNote();
  assert.match(note, /reply_to_review/);
  assert.match(note, /Do not post to a review thread yourself/);
  // The three ways an agent with a shell actually does it.
  for (const habit of ['gh', 'az', 'REST API']) assert.ok(note.includes(habit), `${habit} is named`);
});

test('the fence reads the pull request out of the origin', () => {
  assert.deepEqual(replyOrigin('pr:42:comments'), { ok: true, prNumber: 42, originRef: 'pr:42:comments' });
  // A CI agent is answering a red check; a reply from it lands on a thread
  // another agent is working.
  assert.equal(replyOrigin('pr:42:ci').ok, false);
  assert.equal(replyOrigin(null).ok, false);
});

test('resolved: true closes the thread as the reply goes out', async () => {
  const sink = countingSink();
  const system = build(sink);
  const agent = reviewAgent(system);

  const res = await callReply(system, agent, {
    body: 'Fixed in the latest commit.',
    thread: 'c-1',
    resolved: true,
  });
  assert.equal(res.isError, false);
  assert.equal(sink.replies.length, 1);
  assert.deepEqual(
    sink.resolved,
    [{ prNumber: 42, commentId: 'c-1' }],
    'the harness resolves what the agent says it dealt with',
  );
  // The agent is told what it asked for; whether it has *happened* is the
  // executor's account, which rides in `note`.
  assert.match(res.text, /"resolveRequested": true/);
  const decision = system.store.listDecisions().find((d) => d.action.type === 'reply_on_pr');
  assert.match(decision!.detail, /Resolved thread c-1/);
  system.store.close();
});

test('without the flag the thread is left open for the reviewer', async () => {
  const sink = countingSink();
  const system = build(sink);
  const agent = reviewAgent(system);

  await callReply(system, agent, {
    body: 'Keeping the current approach — the cache is keyed on the branch.',
    thread: 'c-1',
  });
  assert.equal(sink.replies.length, 1);
  assert.equal(sink.resolved.length, 0, 'a defence is the reviewer’s to accept, so the thread stays theirs to close');
  system.store.close();
});

test('the resolution rides on the act, so it waits for the operator with the reply', async () => {
  const sink = countingSink();
  const system = build(sink, { sendPrRepliesWithoutApproval: false });
  const agent = reviewAgent(system);

  await callReply(system, agent, { body: 'Done — extracted the helper.', thread: 'c-1', resolved: true });
  assert.equal(sink.resolved.length, 0, 'nothing is resolved before the reply it justifies is authorized');

  const [proposal] = system.store.listProposals();
  await system.proposals.accept(proposal!.id);
  assert.equal(sink.replies.length, 1);
  assert.deepEqual(
    sink.resolved,
    [{ prNumber: 42, commentId: 'c-1' }],
    'one authority covers the reply and the thread it is about',
  );
  system.store.close();
});

test('resolved: true with no thread resolves nothing — there is no thread to close', async () => {
  const sink = countingSink();
  const system = build(sink);
  const agent = reviewAgent(system);

  const res = await callReply(system, agent, { body: 'Answered on the pull request itself.', resolved: true });
  assert.equal(res.isError, false);
  assert.equal(sink.resolved.length, 0);
  assert.match(res.text, /"resolveRequested": false/, 'and the agent is not told a thread was closed');
  system.store.close();
});

test('a failed resolve never costs the reply: it is not escalated and not re-proposed', async () => {
  // The sharp edge. A throw read as "the send failed" would escalate a reply that
  // is already in the thread, and re-propose it once the settle window lapsed —
  // the reviewer reads the same answer twice because a thread would not close.
  const sink = countingSink({ resolveThrows: 'graphql unavailable' });
  const system = build(sink);
  const agent = reviewAgent(system);

  const res = await callReply(system, agent, { body: 'Fixed.', thread: 'c-1', resolved: true });
  assert.equal(res.isError, false);
  assert.equal(sink.replies.length, 1, 'the reply went out');
  assert.equal(system.store.listOpenEscalations().length, 0, 'and nothing asks the operator to send it again');

  const decision = system.store.listDecisions().find((d) => d.action.type === 'reply_on_pr');
  assert.equal(decision!.outcome, 'executed');
  assert.match(decision!.detail, /still open/, 'the line says the thread was left open');
  const [proposal] = system.store.listProposals();
  assert.equal(proposal!.status, 'accepted');
  system.store.close();
});

test('a provider that cannot resolve says so rather than reporting a closed thread', async () => {
  const sink = countingSink({ canResolve: false });
  const system = build(sink);
  const agent = reviewAgent(system);

  await callReply(system, agent, { body: 'Fixed.', thread: 'c-1', resolved: true });
  assert.equal(sink.replies.length, 1);
  const decision = system.store.listDecisions().find((d) => d.action.type === 'reply_on_pr');
  assert.match(decision!.detail, /cannot resolve one/);
  system.store.close();
});

test('a thread the provider no longer carries is reported, not guessed at', async () => {
  const sink = countingSink({ noSuchThread: true });
  const system = build(sink);
  const agent = reviewAgent(system);

  await callReply(system, agent, { body: 'Fixed.', thread: 'c-9', resolved: true });
  const decision = system.store.listDecisions().find((d) => d.action.type === 'reply_on_pr');
  assert.match(decision!.detail, /carries no thread c-9/);
  system.store.close();
});

test('the review prompt teaches the resolved flag, and when not to set it', () => {
  const note = replyToolNote();
  assert.match(note, /resolved: true/);
  // Both halves: an agent told only to set it resolves the threads it is arguing with.
  assert.match(note, /defending an approach/);
});
