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

/**
 * What the fleet's review **published**, and what happened to it after.
 *
 * Two things hang off one record, `pr_reviews.published_thread`:
 *
 * 1. The reviewer can publish at all. `publishNote` has told it to post its
 *    findings with `reply_to_review` since the tool existed, against an origin
 *    check that admitted only `pr:<n>:comments` — so the call the prompt ordered
 *    was refused on every deployment with `review.publish` on, and the only route
 *    left was the operator's own credential in the agent's shell, which the same
 *    prompt forbids.
 * 2. Somebody resolving that thread is the one statement that the findings were
 *    dealt with — which is what turns the mark from red to green.
 *
 * → `docs/spec/07-pull-requests.md#the-fleet-review`,
 *   `docs/spec/17-cockpit.md#the-fleet-reviews-mark`
 */

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

/**
 * A sink that sends nothing and answers the way Azure does: a comment id for what
 * it wrote, and — where the send opened a thread — a **different** id for the
 * thread. `threadRef` absent is the other provider and the older API version:
 * nothing is named, so nothing is recorded.
 */
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

/**
 * `worktrees` is injected because this builds a whole system: without it
 * `config.repoRoot` defaults to `process.cwd()` and a dispatch cuts a real branch
 * in whoever's checkout is running the suite.
 */
function build(sink: ActionSink): System {
  return buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    sink,
    errorMirror: () => {},
  });
}

function agentAt(system: System, originRef: string): Agent {
  const task = system.store.createTask({
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
  return system.store.recordPrReview({
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
  assert.equal(system.store.listPrReviews()[0]?.publishedThread, 'thread-9');
  system.store.close();
});

test('a reply from the comment origin publishes nothing against the review', async () => {
  const system = build(replySink());
  recordReview(system);

  await publish(system, agentAt(system, 'pr:42:comments'));

  assert.equal(
    system.store.listPrReviews()[0]?.publishedThread,
    null,
    'attribution is the origin that asked, never whatever reply happened to go out',
  );
  system.store.close();
});

test('a provider that will not name the thread records nothing rather than guessing', async () => {
  const system = build(replySink({}));
  recordReview(system);

  await publish(system, agentAt(system, 'pr:42:review'));

  assert.equal(system.store.listPrReviews()[0]?.publishedThread, null);
  system.store.close();
});

test('a re-review clears the thread the last one was published into', () => {
  const system = build(replySink());
  recordReview(system);
  system.store.recordPrReviewPublished(42, 'thread-9');

  recordReview(system);

  assert.equal(
    system.store.listPrReviews()[0]?.publishedThread,
    null,
    'the old thread answers findings this row no longer carries',
  );
  system.store.close();
});

test('a database from before the column reads its reviews as unpublished', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'lubbdubb-review-db-')), 'db.sqlite');
  const store = new Store(file, () => '2026-01-01T00:00:00.000Z');
  store.recordPrReview({
    prNumber: 42,
    headSha: 'sha42',
    verdict: 'findings',
    summary: 'Trims the list to a budget.',
    findings: ['The budget is read inside the loop.'],
    agentId: 'agent_review',
  });
  store.close();

  // The table as the build before this one wrote it. `CREATE TABLE IF NOT EXISTS`
  // never alters an existing table, so without the `ColumnMigrations` entry the
  // column is invisible on every database from before it existed and the read below
  // throws rather than answering null.
  const raw = new Database(file);
  raw.exec(`CREATE TABLE pr_reviews_pre AS SELECT pr_number, head_sha, verdict, summary, findings,
              agent_id, reviewed_at FROM pr_reviews;
            DROP TABLE pr_reviews;
            ALTER TABLE pr_reviews_pre RENAME TO pr_reviews;`);
  raw.close();

  const migrated = new Store(file, () => '2026-01-02T00:00:00.000Z');
  assert.equal(migrated.listPrReviews()[0]?.publishedThread, null, 'and null is what those rows meant');
  migrated.recordPrReviewPublished(42, 'thread-9');
  assert.equal(migrated.listPrReviews()[0]?.publishedThread, 'thread-9', 'the column is writable, not just present');
  migrated.close();
});

test('replyOrigin admits the review and the comments, and nothing else', () => {
  assert.deepEqual(replyOrigin('pr:42:review'), { ok: true, prNumber: 42, originRef: 'pr:42:review' });
  assert.deepEqual(replyOrigin('pr:42:comments'), { ok: true, prNumber: 42, originRef: 'pr:42:comments' });
  assert.equal(replyOrigin('pr:42:ci').ok, false);
  assert.equal(replyOrigin('pr:42:review-triage').ok, false);
});

// -- and what the mark makes of it --------------------------------------------

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

function policy(): PrReviewPolicy {
  return { ...DEFAULT_PR_REVIEW, enabled: true, modes: { deep: {} } };
}

function threads(state: PrReviewThread['state']): PrReviewThread[] {
  return [{ id: 'thread-9', author: 'the-operator', body: 'Two findings: …', state, replies: [] }];
}

function mark(review: PrReview, carried: PrReviewThread[] | undefined) {
  return prReviewState(42, { review, route: null, elsewhere: new Set() }, policy(), carried);
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
