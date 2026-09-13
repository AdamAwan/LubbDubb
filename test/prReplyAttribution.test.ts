import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
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
import type { SentPrReplies } from '../src/pr/prThreads.js';
import type { ActionSink } from '../src/sink/actionSink.js';
import type { Agent, PullRequest } from '../src/types.js';

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

function build(sink?: ActionSink): System {
  return buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
    ...(sink ? { sink } : {}),
  });
}

function replySink(script: { commentRef?: string } = {}): ActionSink & {
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

function reviewAgent(system: System): Agent {
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

async function reply(system: System, agent: Agent, body: string, thread: string): Promise<void> {
  const session = system.mcp.session(agent.id);
  assert.ok(session, 'a spawned agent has a live MCP credential');
  const result = (await session!.call('reply_to_review', { body, thread })) as { isError?: boolean };
  assert.notEqual(result.isError, true, 'the reply tool accepted the body');
}

interface GhScript {
  comments: GhReviewComment[];
  threads?: GhReviewThread[];
}

function githubApi(script: GhScript): GitHubApi {
  const unused = (): never => {
    throw new Error('not part of this test');
  };
  return {
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
    closePull: unused,
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

test('the operator replying to their own thread leaves it unhandled and unbadged', async () => {
  const system = build();
  const comments: GhReviewComment[] = [
    { id: 100, authorLogin: OPERATOR, body: 'rename this', inReplyToId: null },
    { id: 101, authorLogin: OPERATOR, body: 'actually, also the caller', inReplyToId: 100 },
  ];
  const pr = await githubPr({ comments }, system.store.prReplies);
  const thread = pr.reviewThreads![0]!;

  assert.equal(thread.state, 'open', 'a person wrote it, so the fleet still owes an answer');
  assert.equal(thread.replies[0]!.ours, false, 'and no "fleet" badge lands on their message');
  assert.equal(pr.unresolvedComments[0]!.handled, false, 'which is the bit rule pr-review-comment reads');
  system.store.close();
});

test('a reply the harness sent is attributed to the fleet and marks the thread answered', async () => {
  const sink = replySink({ commentRef: '101' });
  const system = build(sink);
  const agent = reviewAgent(system);
  await reply(system, agent, 'Renamed in the latest commit.', '100');

  assert.equal(sink.replies.length, 1, 'the reply went out');
  assert.deepEqual([...system.store.prReplies.prReplyRefs(42)], ['101'], 'and the harness wrote down what it sent');
  assert.deepEqual([...system.store.prReplies.prReplyRefs(43)], [], 'scoped to the pull request it was sent on');

  const comments: GhReviewComment[] = [
    { id: 100, authorLogin: OPERATOR, body: 'rename this', inReplyToId: null },
    { id: 101, authorLogin: OPERATOR, body: 'Renamed in the latest commit.', inReplyToId: 100 },
  ];
  const pr = await githubPr({ comments }, system.store.prReplies);
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
  const system = build();
  system.store.prReplies.recordPrReplySent(42, '100', '101');
  const comments: GhReviewComment[] = [
    { id: 100, authorLogin: OPERATOR, body: 'rename this', inReplyToId: null },
    { id: 101, authorLogin: OPERATOR, body: 'renamed', inReplyToId: 100 },
    { id: 102, authorLogin: OPERATOR, body: 'not quite what I meant', inReplyToId: 100 },
  ];
  const pr = await githubPr({ comments }, system.store.prReplies);
  assert.equal(pr.reviewThreads![0]!.state, 'open');
  assert.deepEqual(
    pr.reviewThreads![0]!.replies.map((r) => r.ours),
    [true, false],
  );
  system.store.close();
});

test('both providers read the same record and reach the same verdict on a thread', async () => {
  const system = build();
  system.store.prReplies.recordPrReplySent(42, '300', '2');

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

  const az = await azurePr(azThreads, system.store.prReplies);
  const gh = await githubPr({ comments: ghComments }, system.store.prReplies);
  assert.equal(az.reviewThreads![0]!.state, 'answered');
  assert.equal(gh.reviewThreads![0]!.state, 'answered');
  assert.equal(az.unresolvedComments[0]!.handled, gh.unresolvedComments[0]!.handled);

  const none: SentPrReplies = { prReplyRefs: () => new Set() };
  assert.equal((await azurePr(azThreads, none)).reviewThreads![0]!.state, 'open');
  assert.equal((await githubPr({ comments: ghComments }, none)).reviewThreads![0]!.state, 'open');
  system.store.close();
});

test('a send the provider will not name records no attribution, and says so out loud', async () => {
  const sink = replySink();
  const system = build(sink);
  const agent = reviewAgent(system);
  await reply(system, agent, 'Renamed in the latest commit.', '100');

  assert.equal(sink.replies.length, 1, 'the reply still went out');
  assert.deepEqual([...system.store.prReplies.prReplyRefs(42)], [], 'but nothing is claimed as the fleet’s');
  const errors = system.store.errors.listErrors();
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /no comment id/i);
  system.store.close();
});

test('the record survives a restart', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'lubbdubb-attrib-db-')), 'lubbdubb.db');
  const before = new Store(dbPath);
  before.prReplies.recordPrReplySent(42, '100', '101');
  before.close();

  const after = new Store(dbPath);
  assert.deepEqual([...after.prReplies.prReplyRefs(42)], ['101'], 'the schema pass reopened the table, rows and all');

  const comments: GhReviewComment[] = [
    { id: 100, authorLogin: OPERATOR, body: 'rename this', inReplyToId: null },
    { id: 101, authorLogin: OPERATOR, body: 'renamed', inReplyToId: 100 },
  ];
  assert.equal((await githubPr({ comments }, after.prReplies)).reviewThreads![0]!.state, 'answered');
  after.close();
});
