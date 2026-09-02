import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { Store } from '../src/store/store.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { GitHubSourceControlIntegration } from '../src/integrations/github/sourceControl.js';
import { AzureDevOpsSourceControlIntegration } from '../src/integrations/azure/sourceControl.js';
import type {
  GhPullSummary,
  GhReviewComment,
  GhReviewThread,
  GitHubApi,
} from '../src/integrations/github/githubApi.js';
import type { AzPull, AzThread, AzureDevOpsApi } from '../src/integrations/azure/azureDevOpsApi.js';
import type { SentPrReplies } from '../src/prThreads.js';
import type { ActionSink } from '../src/sink/actionSink.js';
import type { Agent, PullRequest } from '../src/types.js';

/**
 * Who wrote a review reply is a **record of what the harness sent**, never an
 * inference from the author.
 *
 * The bug this file holds down: the credential the harness posts under is, on a
 * single-operator deployment, the operator's own account. Reading `ours` and
 * `answered` off "the author equals `config.userId`" therefore badged the
 * operator's own follow-up on their own review thread as the fleet's answer, and
 * `answered` folds to `PrComment.handled` — the only bit rule `pr-review-comment`
 * reads. Their comment was marked as work already done and never dispatched for,
 * and nothing anywhere went red.
 *
 * So attribution is `PrReplyStore`: one row per reply that actually left through
 * `sink.postPrReply`, keyed on the provider's own id for the comment it created.
 * Both providers read the same rows through the same derivation
 * (`src/prThreads.ts`), which is what stops them disagreeing about one thread.
 * → `docs/spec/07-pull-requests.md#review-threads`
 */

const OPERATOR = 'the-operator';

function testConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-attrib-'));
  return loadConfig({
    dbPath: ':memory:',
    agentMode: 'raw',
    userId: OPERATOR,
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    ...overrides,
  });
}

/**
 * `worktrees` is injected because this builds a whole system: without it
 * `config.repoRoot` defaults to `process.cwd()` and a dispatch cuts a real branch
 * in whoever's checkout is running the suite.
 */
function build(sink?: ActionSink): System {
  return buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
    ...(sink ? { sink } : {}),
  });
}

/**
 * A sink that sends nothing and answers with the comment id `script` gives — or
 * with none at all, which is the provider that will not name what it created.
 */
function replySink(script: { commentRef?: string } = {}): ActionSink & {
  replies: { prNumber: number; commentId: string | null; body: string }[];
} {
  const replies: { prNumber: number; commentId: string | null; body: string }[] = [];
  const ok = async () => ({ ok: true as const });
  return {
    replies,
    canCloseIssue: () => false,
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
        ref: `https://example.test/pr/${prNumber}#c`,
        ...(script.commentRef === undefined ? {} : { commentRef: script.commentRef }),
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

/** A review agent on PR #42, as rule `pr-review-comment` dispatches one. */
function reviewAgent(system: System): Agent {
  const task = system.store.createTask({
    kind: 'code',
    title: 'Address review comments on PR #42',
    prompt: 'answer them',
    branch: 'feature/x',
    originRef: 'pr:42:comments',
    originTitle: 'A pull request',
  });
  return system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
}

async function reply(system: System, agent: Agent, body: string, thread: string): Promise<void> {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call('reply_to_review', { body, thread })) as { isError?: boolean };
  assert.notEqual(result.isError, true, 'the reply tool accepted the body');
}

// --------------------------------------------------------------------------
// Scripted provider fakes — no network, and no reply path either: what goes out
// is the sink's business, and what comes back is these.
// --------------------------------------------------------------------------

interface GhScript {
  comments: GhReviewComment[];
  threads?: GhReviewThread[];
}

function githubApi(script: GhScript): GitHubApi {
  const unused = (): never => {
    throw new Error('not part of this test');
  };
  return {
    // The operator's own login, because that is the deployment where the bug bit:
    // the credential and the reviewer are one account.
    viewerLogin: async () => OPERATOR,
    listOpenPulls: async (): Promise<GhPullSummary[]> => [
      {
        number: 42,
        title: 'A change',
        branch: 'feature/x',
        baseBranch: 'main',
        headSha: 'sha42',
        authorLogin: OPERATOR,
        url: 'u',
        labels: [],
        assigneeLogins: [],
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ],
    getPull: async () => ({ mergeable: true, mergeableState: 'clean', merged: false }),
    listPullReviews: async () => [],
    listPullReviewComments: async () => script.comments,
    listPullReviewThreads: async () => script.threads ?? [],
    getCombinedStatus: async () => ({ state: 'success', totalCount: 1 }),
    listCheckRuns: async () => [],
    listOpenIssues: async () => [],
    listIssueTimeline: async () => [],
    listRecentlyClosedPulls: unused,
    resolveReviewThread: unused,
    listCheckRunAnnotations: unused,
    getJobLog: unused,
    listIssuesChangedSince: unused,
    createPullReviewReply: unused,
    createIssueComment: unused,
    updateIssueComment: unused,
    mergePull: unused,
    setPullLabel: unused,
    setIssueLabel: unused,
    closeIssue: unused,
    createIssue: unused,
    createPull: unused,
    setPullTitle: unused,
    setPullBase: unused,
    updatePullBranch: unused,
    deleteBranch: unused,
  };
}

function azureApi(threads: AzThread[]): AzureDevOpsApi {
  const unused = (): never => {
    throw new Error('not part of this test');
  };
  const pull: AzPull = {
    pullRequestId: 42,
    title: 'A change',
    branch: 'feature/x',
    baseBranch: 'main',
    lastMergeSourceCommit: 'sha42',
    authorUniqueName: OPERATOR,
    authorDisplayName: 'The Operator',
    url: 'u',
    isDraft: false,
    mergeStatus: 'succeeded',
    reviewers: [],
  };
  return {
    viewerUniqueName: async () => OPERATOR,
    listActivePullRequests: async () => [pull],
    listPullThreads: async () => threads,
    listPullLabels: async () => [],
    listPolicyEvaluations: async () => [],
    listWorkItems: async () => [],
    listRecentlyCompletedPullRequests: unused,
    createThreadReply: unused,
    setThreadStatus: unused,
    createThread: unused,
    completePullRequest: unused,
    setPullLabel: unused,
    updatePullRequest: unused,
    createPullRequest: unused,
    getWorkItem: unused,
    createWorkItem: unused,
    updateWorkItem: unused,
    linkWorkItemToPullRequest: unused,
    listWorkItemUpdates: unused,
  } as unknown as AzureDevOpsApi;
}

/** The one open pull request the provider read, threads and all. */
async function readPr(integration: {
  snapshot: () => Promise<{ pullRequests?: PullRequest[] }>;
}): Promise<PullRequest> {
  const slice = await integration.snapshot();
  const pr = slice.pullRequests?.[0];
  assert.ok(pr, 'the provider read the open pull request');
  return pr!;
}

function githubPr(script: GhScript, sentReplies: SentPrReplies): Promise<PullRequest> {
  return readPr(new GitHubSourceControlIntegration({ api: githubApi(script), owner: 'o', repo: 'r', sentReplies }));
}

function azurePr(threads: AzThread[], sentReplies: SentPrReplies): Promise<PullRequest> {
  return readPr(
    new AzureDevOpsSourceControlIntegration({
      api: azureApi(threads),
      organization: 'org',
      project: 'proj',
      repository: 'repo',
      sentReplies,
    }),
  );
}

// --------------------------------------------------------------------------

test('the operator replying to their own thread leaves it unhandled and unbadged', async () => {
  const system = build();
  // Two messages, both under the operator's login — the root they left as a
  // reviewer and the follow-up they wrote themselves. Nothing went out through
  // the harness, so the store has no row for either.
  const comments: GhReviewComment[] = [
    { id: 100, authorLogin: OPERATOR, body: 'rename this', inReplyToId: null },
    { id: 101, authorLogin: OPERATOR, body: 'actually, also the caller', inReplyToId: 100 },
  ];
  const pr = await githubPr({ comments }, system.store);
  const thread = pr.reviewThreads![0]!;

  assert.equal(thread.state, 'open', 'a person wrote it, so the fleet still owes an answer');
  assert.equal(thread.replies[0]!.ours, false, 'and no "fleet" badge lands on their message');
  assert.equal(pr.unresolvedComments[0]!.handled, false, 'which is the bit rule pr-review-comment reads');
  system.store.close();
});

test('a reply the harness sent is attributed to the fleet and marks the thread answered', async () => {
  // The whole path: the tool raises the act, the executor sends it through the
  // sink, and the sink's `commentRef` is what gets written down.
  const sink = replySink({ commentRef: '101' });
  const system = build(sink);
  const agent = reviewAgent(system);
  await reply(system, agent, 'Renamed in the latest commit.', '100');

  assert.equal(sink.replies.length, 1, 'the reply went out');
  assert.deepEqual([...system.store.prReplyRefs(42)], ['101'], 'and the harness wrote down what it sent');
  assert.deepEqual([...system.store.prReplyRefs(43)], [], 'scoped to the pull request it was sent on');

  // Same two comments, same single login on both — only the row tells them apart.
  const comments: GhReviewComment[] = [
    { id: 100, authorLogin: OPERATOR, body: 'rename this', inReplyToId: null },
    { id: 101, authorLogin: OPERATOR, body: 'Renamed in the latest commit.', inReplyToId: 100 },
  ];
  const pr = await githubPr({ comments }, system.store);
  const thread = pr.reviewThreads![0]!;
  assert.equal(thread.state, 'answered');
  assert.deepEqual(
    thread.replies.map((r) => r.ours),
    [true],
  );
  assert.equal(pr.unresolvedComments[0]!.handled, true, 'so the rule stops dispatching for it');
  system.store.close();
});

test('a reviewer coming back after the fleet answered reopens the work', async () => {
  // The ordering half: the record says comment 101 is ours, and 102 is not, so the
  // newest reply is the reviewer's and the thread is the fleet's again. Under the
  // identity rule both replies carried the same login and this stayed answered.
  const system = build();
  system.store.recordPrReplySent(42, '100', '101');
  const comments: GhReviewComment[] = [
    { id: 100, authorLogin: OPERATOR, body: 'rename this', inReplyToId: null },
    { id: 101, authorLogin: OPERATOR, body: 'renamed', inReplyToId: 100 },
    { id: 102, authorLogin: OPERATOR, body: 'not quite what I meant', inReplyToId: 100 },
  ];
  const pr = await githubPr({ comments }, system.store);
  assert.equal(pr.reviewThreads![0]!.state, 'open');
  assert.deepEqual(
    pr.reviewThreads![0]!.replies.map((r) => r.ours),
    [true, false],
  );
  system.store.close();
});

test('both providers read the same record and reach the same verdict on a thread', async () => {
  const system = build();
  system.store.recordPrReplySent(42, '300', '2');

  const azThreads: AzThread[] = [
    {
      id: 300,
      status: 'active',
      comments: [
        { id: 1, authorUniqueName: OPERATOR, content: 'rename this', parentCommentId: null, commentType: 'text' },
        { id: 2, authorUniqueName: OPERATOR, content: 'renamed', parentCommentId: 1, commentType: 'text' },
      ],
    },
  ];
  const ghComments: GhReviewComment[] = [
    { id: 300, authorLogin: OPERATOR, body: 'rename this', inReplyToId: null },
    { id: 2, authorLogin: OPERATOR, body: 'renamed', inReplyToId: 300 },
  ];

  const az = await azurePr(azThreads, system.store);
  const gh = await githubPr({ comments: ghComments }, system.store);
  assert.equal(az.reviewThreads![0]!.state, 'answered');
  assert.equal(gh.reviewThreads![0]!.state, 'answered');
  assert.equal(az.unresolvedComments[0]!.handled, gh.unresolvedComments[0]!.handled);

  // And with no record, both hold the thread open — the two agree in the failure
  // direction as well, which is the point of there being one derivation.
  const none: SentPrReplies = { prReplyRefs: () => new Set() };
  assert.equal((await azurePr(azThreads, none)).reviewThreads![0]!.state, 'open');
  assert.equal((await githubPr({ comments: ghComments }, none)).reviewThreads![0]!.state, 'open');
  system.store.close();
});

test('a send the provider will not name records no attribution, and says so out loud', async () => {
  // The deliberate failure direction. Nothing to match on the next read means the
  // thread keeps reading as work — a re-dispatch, which is visible and cheap —
  // rather than a thread claimed as handled, which loses the reviewer's comment.
  const sink = replySink(); // no commentRef
  const system = build(sink);
  const agent = reviewAgent(system);
  await reply(system, agent, 'Renamed in the latest commit.', '100');

  assert.equal(sink.replies.length, 1, 'the reply still went out');
  assert.deepEqual([...system.store.prReplyRefs(42)], [], 'but nothing is claimed as the fleet’s');
  // And the miss is loud: a silent slide back to the author is the whole bug.
  const errors = system.store.listErrors();
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /no comment id/i);
  system.store.close();
});

test('the record survives a restart', async () => {
  // A file-backed store rather than the suite's usual `:memory:` — the property
  // under test is that the row outlives the process, which an in-memory database
  // cannot show. A thread answered before a restart must not come back as work.
  const dbPath = join(mkdtempSync(join(tmpdir(), 'lubbdubb-attrib-db-')), 'lubbdubb.db');
  const before = new Store(dbPath);
  before.recordPrReplySent(42, '100', '101');
  before.close();

  const after = new Store(dbPath);
  assert.deepEqual([...after.prReplyRefs(42)], ['101'], 'the schema pass reopened the table, rows and all');

  const comments: GhReviewComment[] = [
    { id: 100, authorLogin: OPERATOR, body: 'rename this', inReplyToId: null },
    { id: 101, authorLogin: OPERATOR, body: 'renamed', inReplyToId: 100 },
  ];
  assert.equal((await githubPr({ comments }, after)).reviewThreads![0]!.state, 'answered');
  after.close();
});
