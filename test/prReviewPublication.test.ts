import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store/store.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { replyOrigin } from '../src/dispatcher/reviewThreads.js';
import { DEFAULT_PR_REVIEW, type PrReviewPolicy } from '../src/review/policy.js';
import { prReviewState } from '../src/review/prReviewState.js';
import type { ActionSink } from '../src/sink/actionSink.js';
import type { Agent, PrReview, PrReviewThread } from '../src/types.js';

function testConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-review-pub-'));
  return loadConfig({
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    sendPrRepliesWithoutApproval: true,
    ...overrides,
  });
}

function replySink(script: { threadRef?: string } = { threadRef: 'thread-9' }): ActionSink & {
  replies: { prNumber: number; commentId: string | null; body: string }[];
} {
  const replies: { prNumber: number; commentId: string | null; body: string }[] = [];
  const ok = async () => ({ ok: true as const });
  return {
    replies,
    canCloseIssue: () => false,
    canClosePr: () => false,
    closePr: (): never => {
      throw new Error('closePr is not scripted in this test');
    },
    canResolvePrThread: () => false,
    resolvePrThread: ok,
    closeIssue: ok,
    canSetWorkItemState: () => false,
    canPlaceWorkItem: () => false,
    setWorkItemParent: ok,
    setWorkItemAreaPath: ok,
    mergePr: ok,
    async postPrReply({ prNumber, commentId, body }) {
      replies.push({ prNumber, commentId, body });
      return {
        ok: true,
        ref: `https://example.test/pr/${prNumber}`,
        commentRef: 'comment-4',
        ...(script.threadRef === undefined ? {} : { threadRef: script.threadRef }),
      };
    },
    setPrLabel: ok,
    setIssueLabel: ok,
    setWorkItemState: ok,
    linkWorkItem: ok,
    createIssue: async () => ({ ok: true as const, ref: 'issue:1' }),
    upsertIssueComment: ok,
    createPullRequest: ok,
    setPullTitle: ok,
    setPullBase: ok,
    updatePrBranch: ok,
    requeueCiCheck: ok,
    deleteBranch: ok,
  };
}

function build(sink: ActionSink): System {
  return buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    sink,
    errorMirror: () => {},
  });
}

function agentAt(system: System, originRef: string): Agent {
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: 'Review PR #42',
    prompt: 'read it',
    branch: 'review/pr-42',
    originRef,
    originTitle: 'A pull request',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function publish(system: System, agent: Agent): Promise<{ isError: boolean }> {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call('reply_to_review', { body: 'Two findings: the budget, and the tests.' })) as {
    isError?: boolean;
  };
  return { isError: result.isError === true };
}

function recordReview(system: System, prNumber = 42): PrReview {
  return system.store.prReviews.recordPrReview({
    prNumber,
    headSha: 'sha42',
    verdict: 'findings',
    summary: 'Trims the list to a budget.',
    findings: ['The budget is read inside the loop.', 'Nothing covers a budget below one section.'],
    agentId: 'agent_review',
  });
}

test('the reviewer may publish through the harness, and the thread it opens is recorded against its review', async () => {
  const sink = replySink();
  const system = build(sink);
  recordReview(system);

  const result = await publish(system, agentAt(system, 'pr:42:review'));

  assert.equal(result.isError, false, 'the origin the prompt dispatches a reviewer at may use the tool');
  assert.equal(sink.replies.length, 1, 'and the body went out through the sink rather than the agent shell');
  assert.equal(sink.replies[0]?.commentId, null, 'as a comment on the pull request, not a reply into a thread');
  assert.equal(system.store.prReviews.listPrReviews()[0]?.publishedThread, 'thread-9');
  system.store.close();
});

test('a reply from the comment origin publishes nothing against the review', async () => {
  const system = build(replySink());
  recordReview(system);

  await publish(system, agentAt(system, 'pr:42:comments'));

  assert.equal(
    system.store.prReviews.listPrReviews()[0]?.publishedThread,
    null,
    'attribution is the origin that asked, never whatever reply happened to go out',
  );
  system.store.close();
});

test('a provider that will not name the thread records nothing rather than guessing', async () => {
  const system = build(replySink({}));
  recordReview(system);

  await publish(system, agentAt(system, 'pr:42:review'));

  assert.equal(system.store.prReviews.listPrReviews()[0]?.publishedThread, null);
  system.store.close();
});

test('a re-review clears the thread the last one was published into', () => {
  const system = build(replySink());
  recordReview(system);
  system.store.prReviews.recordPrReviewPublished(42, 'thread-9');

  recordReview(system);

  assert.equal(
    system.store.prReviews.listPrReviews()[0]?.publishedThread,
    null,
    'the old thread answers findings this row no longer carries',
  );
  system.store.close();
});

test('a database from before the column reads its reviews as unpublished', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'lubbdubb-review-db-')), 'db.sqlite');
  const store = new Store(file, () => '2026-01-01T00:00:00.000Z');
  store.prReviews.recordPrReview({
    prNumber: 42,
    headSha: 'sha42',
    verdict: 'findings',
    summary: 'Trims the list to a budget.',
    findings: ['The budget is read inside the loop.'],
    agentId: 'agent_review',
  });
  store.close();

  const raw = new Database(file);
  raw.exec(`CREATE TABLE pr_reviews_pre AS SELECT pr_number, head_sha, verdict, summary, findings,
              agent_id, reviewed_at FROM pr_reviews;
            DROP TABLE pr_reviews;
            ALTER TABLE pr_reviews_pre RENAME TO pr_reviews;`);
  raw.close();

  const migrated = new Store(file, () => '2026-01-02T00:00:00.000Z');
  assert.equal(migrated.prReviews.listPrReviews()[0]?.publishedThread, null, 'and null is what those rows meant');
  migrated.prReviews.recordPrReviewPublished(42, 'thread-9');
  assert.equal(
    migrated.prReviews.listPrReviews()[0]?.publishedThread,
    'thread-9',
    'the column is writable, not just present',
  );
  migrated.close();
});

test('replyOrigin admits the review and the comments, and nothing else', () => {
  assert.deepEqual(replyOrigin('pr:42:review'), { ok: true, prNumber: 42, originRef: 'pr:42:review' });
  assert.deepEqual(replyOrigin('pr:42:comments'), { ok: true, prNumber: 42, originRef: 'pr:42:comments' });
  assert.equal(replyOrigin('pr:42:ci').ok, false);
  assert.equal(replyOrigin('pr:42:review-triage').ok, false);
});

function reviewRow(over: Partial<PrReview> = {}): PrReview {
  return {
    prNumber: 42,
    headSha: 'sha42',
    verdict: 'findings',
    summary: 'Trims the list to a budget.',
    findings: ['The budget is read inside the loop.'],
    agentId: 'agent_review',
    reviewedAt: '2026-01-01T01:00:00.000Z',
    publishedThread: 'thread-9',
    ...over,
  };
}

function policy(over: Partial<PrReviewPolicy> = {}): PrReviewPolicy {
  return { ...DEFAULT_PR_REVIEW, enabled: true, modes: { deep: {} }, ...over };
}

function threads(state: PrReviewThread['state']): PrReviewThread[] {
  return [{ id: 'thread-9', author: 'the-operator', body: 'Two findings: …', state, replies: [] }];
}

function mark(review: PrReview, carried: PrReviewThread[] | undefined, over: Partial<PrReviewPolicy> = {}) {
  return prReviewState(42, { review, route: null, elsewhere: new Set() }, policy(over), carried);
}

test('findings read as addressed once the thread they were published into is resolved', () => {
  assert.equal(mark(reviewRow(), threads('resolved'))?.addressed, true);
  assert.equal(mark(reviewRow(), threads('open'))?.addressed, false);
  assert.equal(mark(reviewRow(), threads('answered'))?.addressed, false, 'a reply is not somebody dealing with it');
});

test('nothing else can address them', () => {
  assert.equal(
    mark(reviewRow({ publishedThread: null }), threads('resolved'))?.addressed,
    false,
    'a resolved thread nothing recorded publishing is somebody else’s tidy-up',
  );
  assert.equal(
    mark(reviewRow(), undefined)?.addressed,
    false,
    'and a caller with no threads in hand cannot say — which is not "dealt with"',
  );
  assert.equal(mark(reviewRow(), [])?.addressed, false, 'nor can a reading that no longer carries the thread');
});

const STAMP = { publishedThreadProperty: 'pr-agent-review', publishedThreadRole: 'finding' };

function stamped(
  id: string,
  state: PrReviewThread['state'],
  props: Record<string, string> = { 'pr-agent-review': '1', 'pr-agent-review.role': 'finding' },
): PrReviewThread {
  return { id, author: 'the-operator', body: 'A finding.', state, replies: [], properties: props };
}

const UNSTAMPED: PrReviewThread = {
  id: 'human-1',
  author: 'a-reviewer',
  body: 'Why this way?',
  state: 'open',
  replies: [],
};

test('a review that published nothing still reads as addressed once every stamped thread is resolved', () => {
  const unpublished = reviewRow({ publishedThread: null });
  assert.equal(mark(unpublished, [stamped('t1', 'resolved'), stamped('t2', 'resolved')], STAMP)?.addressed, true);
  assert.equal(
    mark(unpublished, [stamped('t1', 'resolved'), stamped('t2', 'open')], STAMP)?.addressed,
    false,
    'one open stamped thread is a finding nobody has looked at — every one of them, not any',
  );
});

test('an unstamped thread neither addresses the findings nor holds them open', () => {
  const unpublished = reviewRow({ publishedThread: null });
  assert.equal(
    mark(unpublished, [UNSTAMPED], STAMP)?.addressed,
    false,
    'a pull request with no stamped thread at all has nothing saying the findings were dealt with',
  );
  assert.equal(
    mark(unpublished, [stamped('t1', 'resolved'), UNSTAMPED], STAMP)?.addressed,
    true,
    'and a reviewer’s own open question is not the fleet’s finding to answer',
  );
});

test('the role narrows which stamped threads count', () => {
  const unpublished = reviewRow({ publishedThread: null });
  const summary = stamped('t0', 'open', { 'pr-agent-review': '1', 'pr-agent-review.role': 'summary' });
  assert.equal(
    mark(unpublished, [summary, stamped('t1', 'resolved')], STAMP)?.addressed,
    true,
    'a summary thread nobody resolves would otherwise hold the mark red forever',
  );
  assert.equal(
    mark(unpublished, [summary, stamped('t1', 'resolved')], { ...STAMP, publishedThreadRole: null })?.addressed,
    false,
    'with no role declared every stamped thread counts, the summary included',
  );
});

test('with no property declared the stamp arm is not consulted at all', () => {
  assert.equal(
    mark(reviewRow({ publishedThread: null }), [stamped('t1', 'resolved')])?.addressed,
    false,
    'which is every deployment from before this existed',
  );
});
