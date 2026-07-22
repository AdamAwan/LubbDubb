import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import {
  AzureDevOpsSourceControlIntegration,
  aggregateCiStatus,
  buildUnresolvedComments,
  computeApproved,
  mergeStrategyFor,
  mergeableFromStatus,
  normalizeMergeState,
  stripRef,
} from '../src/integrations/azure/sourceControl.js';
import {
  AzureDevOpsWorkItemsIntegration,
  linkedPrFromRelations,
  normalizeState,
} from '../src/integrations/azure/workItems.js';
import { buildOpenWorkItemQuery } from '../src/integrations/azure/restAzureDevOpsApi.js';
import type {
  AzCommentRef,
  AzMergeResult,
  AzPull,
  AzStatus,
  AzThread,
  AzWorkItem,
  AzureDevOpsApi,
} from '../src/integrations/azure/azureDevOpsApi.js';
import type { MergeMethod } from '../src/sink/actionSink.js';

/** Everything a test wants to script. Every field defaults to empty/benign. */
interface Script {
  viewer?: string;
  pulls?: AzPull[];
  threads?: Record<number, AzThread[]>;
  statuses?: Record<number, AzStatus[]>;
  labels?: Record<number, string[]>;
  workItems?: AzWorkItem[];
  throwOn?: 'listActivePullRequests' | 'listOpenWorkItems';
}

interface Recorded {
  threadReplies: Array<{ prId: number; threadId: number; parentCommentId: number; content: string }>;
  newThreads: Array<{ prId: number; content: string }>;
  completions: Array<{ prId: number; commit: string; method: MergeMethod }>;
  tagQueries: Array<string | undefined>;
  labelSets: Array<{ prId: number; label: string; present: boolean }>;
}

function fakeApi(script: Script = {}): { api: AzureDevOpsApi; recorded: Recorded } {
  const recorded: Recorded = { threadReplies: [], newThreads: [], completions: [], tagQueries: [], labelSets: [] };
  const api: AzureDevOpsApi = {
    async viewerUniqueName() {
      return script.viewer ?? 'bot@acme.com';
    },
    async listActivePullRequests() {
      if (script.throwOn === 'listActivePullRequests') throw new Error('boom');
      return script.pulls ?? [];
    },
    async listPullThreads(prId) {
      return script.threads?.[prId] ?? [];
    },
    async listPullStatuses(prId) {
      return script.statuses?.[prId] ?? [];
    },
    async listPullLabels(prId) {
      return script.labels?.[prId] ?? [];
    },
    async listOpenWorkItems(tag) {
      recorded.tagQueries.push(tag);
      if (script.throwOn === 'listOpenWorkItems') throw new Error('boom');
      return script.workItems ?? [];
    },
    async createThreadReply(prId, threadId, parentCommentId, content): Promise<AzCommentRef> {
      recorded.threadReplies.push({ prId, threadId, parentCommentId, content });
      return { url: `https://dev.azure.com/o/p/_git/r/pullrequest/${prId}` };
    },
    async createThread(prId, content): Promise<AzCommentRef> {
      recorded.newThreads.push({ prId, content });
      return { url: `https://dev.azure.com/o/p/_git/r/pullrequest/${prId}` };
    },
    async completePullRequest(prId, commit, method): Promise<AzMergeResult> {
      recorded.completions.push({ prId, commit, method });
      return { status: 'completed' };
    },
    async setPullLabel(prId, label, present) {
      recorded.labelSets.push({ prId, label, present });
    },
  };
  return { api, recorded };
}

function pull(over: Partial<AzPull> = {}): AzPull {
  return {
    pullRequestId: 7,
    title: 'X',
    branch: 'feat',
    baseBranch: 'main',
    lastMergeSourceCommit: 'abc123',
    authorUniqueName: 'alice@acme.com',
    url: 'u',
    isDraft: false,
    mergeStatus: 'succeeded',
    reviewerVotes: [],
    ...over,
  };
}

// --------------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------------

test('stripRef removes the refs/heads/ prefix', () => {
  assert.equal(stripRef('refs/heads/feat/widget'), 'feat/widget');
  assert.equal(stripRef('feat'), 'feat');
});

test('normalizeMergeState maps Azure mergeStatus to the harness vocabulary', () => {
  assert.equal(normalizeMergeState('conflicts', false), 'dirty');
  assert.equal(normalizeMergeState('succeeded', false), 'clean');
  assert.equal(normalizeMergeState('rejectedByPolicy', false), 'blocked');
  assert.equal(normalizeMergeState('queued', false), 'unknown');
  assert.equal(normalizeMergeState('notSet', false), 'unknown');
});

test('normalizeMergeState treats a draft PR as blocked regardless of conflicts', () => {
  assert.equal(normalizeMergeState('succeeded', true), 'blocked');
  assert.equal(normalizeMergeState('conflicts', true), 'blocked');
});

test('mergeableFromStatus is tri-state: concrete for succeeded/conflicts, undefined while computing', () => {
  assert.equal(mergeableFromStatus('succeeded'), true);
  assert.equal(mergeableFromStatus('conflicts'), false);
  assert.equal(mergeableFromStatus('queued'), undefined);
  assert.equal(mergeableFromStatus('notSet'), undefined);
});

test('aggregateCiStatus: any failing status wins', () => {
  const statuses: AzStatus[] = [{ state: 'succeeded' }, { state: 'failed' }];
  assert.equal(aggregateCiStatus(statuses), 'failing');
});

test('aggregateCiStatus: pending when a status is pending and none failed', () => {
  assert.equal(aggregateCiStatus([{ state: 'succeeded' }, { state: 'pending' }]), 'pending');
});

test('aggregateCiStatus: passing when all signals succeed', () => {
  assert.equal(aggregateCiStatus([{ state: 'succeeded' }]), 'passing');
});

test('aggregateCiStatus: unknown when there are no signals (or only notApplicable)', () => {
  assert.equal(aggregateCiStatus([]), 'unknown');
  assert.equal(aggregateCiStatus([{ state: 'notApplicable' }, { state: null }]), 'unknown');
});

test('computeApproved: approved on a positive vote with none negative', () => {
  assert.equal(computeApproved([10]), true);
  assert.equal(computeApproved([5]), true); // approved-with-suggestions counts
});

test('computeApproved: a rejecting or waiting vote cancels an approval', () => {
  assert.equal(computeApproved([10, -10]), false);
  assert.equal(computeApproved([10, -5]), false);
});

test('computeApproved: no vote at all is not approved', () => {
  assert.equal(computeApproved([0, 0]), false);
  assert.equal(computeApproved([]), false);
});

test('buildUnresolvedComments: one entry per thread, keyed on the thread id, system comments dropped', () => {
  const threads: AzThread[] = [
    {
      id: 300,
      status: 'active',
      comments: [
        { id: 1, authorUniqueName: 'system', content: 'PR created', parentCommentId: null, commentType: 'system' },
        { id: 2, authorUniqueName: 'bob@acme.com', content: 'why this?', parentCommentId: null, commentType: 'text' },
      ],
    },
  ];
  const out = buildUnresolvedComments(threads, 'bot@acme.com');
  assert.equal(out.length, 1);
  assert.equal(out[0]!.id, '300');
  assert.equal(out[0]!.author, 'bob@acme.com');
  assert.equal(out[0]!.body, 'why this?');
  assert.equal(out[0]!.handled, false);
});

test('buildUnresolvedComments: handled when the bot authored the latest comment', () => {
  const threads: AzThread[] = [
    {
      id: 300,
      status: 'active',
      comments: [
        { id: 1, authorUniqueName: 'bob@acme.com', content: 'why?', parentCommentId: null, commentType: 'text' },
        { id: 2, authorUniqueName: 'bot@acme.com', content: 'because X', parentCommentId: 1, commentType: 'text' },
      ],
    },
  ];
  assert.equal(buildUnresolvedComments(threads, 'bot@acme.com')[0]!.handled, true);
});

test('buildUnresolvedComments: handled when Azure marks the thread resolved', () => {
  const threads: AzThread[] = [
    {
      id: 300,
      status: 'fixed',
      comments: [
        { id: 1, authorUniqueName: 'bob@acme.com', content: 'nit', parentCommentId: null, commentType: 'text' },
      ],
    },
  ];
  assert.equal(buildUnresolvedComments(threads, 'bot@acme.com')[0]!.handled, true);
});

test('buildUnresolvedComments: a purely-system thread contributes nothing', () => {
  const threads: AzThread[] = [
    {
      id: 300,
      status: 'closed',
      comments: [
        { id: 1, authorUniqueName: 'system', content: 'ref updated', parentCommentId: null, commentType: 'system' },
      ],
    },
  ];
  assert.deepEqual(buildUnresolvedComments(threads, 'bot@acme.com'), []);
});

test('mergeStrategyFor maps the domain method onto Azure completion strategies', () => {
  assert.equal(mergeStrategyFor('squash'), 'squash');
  assert.equal(mergeStrategyFor('rebase'), 'rebase');
  assert.equal(mergeStrategyFor('merge'), 'noFastForward');
});

test('normalizeState: done-ish states are closed, everything else open', () => {
  assert.equal(normalizeState('Closed'), 'closed');
  assert.equal(normalizeState('Done'), 'closed');
  assert.equal(normalizeState('Removed'), 'closed');
  assert.equal(normalizeState('Resolved'), 'closed');
  assert.equal(normalizeState('Active'), 'open');
  assert.equal(normalizeState('New'), 'open');
});

test('linkedPrFromRelations: extracts the trailing PR id from a vstfs artifact link', () => {
  const urls = ['vstfs:///Git/PullRequestId/proj%2Frepoguid%2F55'];
  assert.equal(linkedPrFromRelations(urls), 55);
});

test('linkedPrFromRelations: takes the most recent link and ignores non-PR relations', () => {
  const urls = [
    'vstfs:///Git/PullRequestId/proj%2Frepoguid%2F40',
    'vstfs:///Git/Commit/whatever',
    'vstfs:///Git/PullRequestId/proj%2Frepoguid%2F43',
  ];
  assert.equal(linkedPrFromRelations(urls), 43);
});

test('linkedPrFromRelations: null when nothing links a PR', () => {
  assert.equal(linkedPrFromRelations(['vstfs:///Git/Commit/x']), null);
});

test('buildOpenWorkItemQuery: filters to open states and, when set, a tag (single-quote escaped)', () => {
  const base = buildOpenWorkItemQuery();
  assert.match(base, /System\.State] NOT IN \('Closed', 'Done', 'Removed', 'Resolved'\)/);
  assert.doesNotMatch(base, /System\.Tags/);
  const tagged = buildOpenWorkItemQuery("agent's");
  assert.match(tagged, /System\.Tags] CONTAINS 'agent''s'/);
});

// --------------------------------------------------------------------------
// AzureDevOpsSourceControlIntegration.snapshot
// --------------------------------------------------------------------------

test('snapshot maps a PR with its CI / approval / mergeability / comments', async () => {
  const { api } = fakeApi({
    viewer: 'bot@acme.com',
    pulls: [
      pull({
        pullRequestId: 7,
        title: 'Add widget',
        branch: 'feat/widget',
        mergeStatus: 'succeeded',
        reviewerVotes: [10],
      }),
    ],
    statuses: { 7: [{ state: 'succeeded' }] },
    threads: {
      7: [
        {
          id: 300,
          status: 'active',
          comments: [
            { id: 1, authorUniqueName: 'bob@acme.com', content: 'why?', parentCommentId: null, commentType: 'text' },
          ],
        },
      ],
    },
  });
  const store = new Store(':memory:');
  const sc = new AzureDevOpsSourceControlIntegration({ api, store });
  const pr = (await sc.snapshot()).pullRequests![0]!;
  assert.equal(pr.number, 7);
  assert.equal(pr.title, 'Add widget');
  assert.equal(pr.branch, 'feat/widget');
  assert.equal(pr.baseBranch, 'main');
  assert.equal(pr.ciStatus, 'passing');
  assert.equal(pr.approved, true);
  assert.equal(pr.mergeable, true);
  assert.equal(pr.mergeableState, 'clean');
  assert.equal(pr.merged, false);
  assert.equal(pr.unresolvedComments.length, 1);
  assert.equal(pr.unresolvedComments[0]!.handled, false);
  store.close();
});

test('snapshot leaves mergeable undefined while Azure is still computing', async () => {
  const { api } = fakeApi({ pulls: [pull({ pullRequestId: 7, mergeStatus: 'queued' })] });
  const store = new Store(':memory:');
  const sc = new AzureDevOpsSourceControlIntegration({ api, store });
  const pr = (await sc.snapshot()).pullRequests![0]!;
  assert.equal(pr.mergeable, undefined);
  assert.equal(pr.mergeableState, 'unknown');
  store.close();
});

test('snapshot applies the prAuthor filter client-side', async () => {
  const { api } = fakeApi({
    pulls: [
      pull({ pullRequestId: 7, authorUniqueName: 'alice@acme.com' }),
      pull({ pullRequestId: 8, authorUniqueName: 'bob@acme.com' }),
    ],
  });
  const store = new Store(':memory:');
  const sc = new AzureDevOpsSourceControlIntegration({ api, store, prAuthor: 'alice@acme.com' });
  const prs = (await sc.snapshot()).pullRequests!;
  assert.deepEqual(
    prs.map((p) => p.number),
    [7],
  );
  store.close();
});

test('snapshot returns the last-good slice and records an error event on failure', async () => {
  const store = new Store(':memory:');
  const good = fakeApi({ pulls: [pull({ pullRequestId: 7 })] });
  const sc = new AzureDevOpsSourceControlIntegration({ api: good.api, store });
  await sc.snapshot(); // warm the last-good cache

  const bad = fakeApi({ throwOn: 'listActivePullRequests' });
  const sc2 = new AzureDevOpsSourceControlIntegration({ api: bad.api, store });
  const slice = await sc2.snapshot(); // cold + failing → empty, and it must not throw
  assert.deepEqual(slice.pullRequests, []);
  store.close();
});

// --------------------------------------------------------------------------
// Outbound
// --------------------------------------------------------------------------

test('postPrReply threads under an existing thread when commentId is set', async () => {
  const { api, recorded } = fakeApi();
  const store = new Store(':memory:');
  const sc = new AzureDevOpsSourceControlIntegration({ api, store });
  const res = await sc.postPrReply({ prNumber: 7, commentId: '300', body: 'because X' });
  assert.equal(res.ok, true);
  assert.deepEqual(recorded.threadReplies, [{ prId: 7, threadId: 300, parentCommentId: 1, content: 'because X' }]);
  assert.equal(recorded.newThreads.length, 0);
  store.close();
});

test('postPrReply opens a new thread when commentId is null', async () => {
  const { api, recorded } = fakeApi();
  const store = new Store(':memory:');
  const sc = new AzureDevOpsSourceControlIntegration({ api, store });
  const res = await sc.postPrReply({ prNumber: 7, commentId: null, body: 'ping' });
  assert.equal(res.ok, true);
  assert.deepEqual(recorded.newThreads, [{ prId: 7, content: 'ping' }]);
  assert.equal(recorded.threadReplies.length, 0);
  store.close();
});

test('mergePr completes the PR with the snapshotted head commit and requested strategy', async () => {
  const { api, recorded } = fakeApi({ pulls: [pull({ pullRequestId: 7, lastMergeSourceCommit: 'headsha' })] });
  const store = new Store(':memory:');
  const sc = new AzureDevOpsSourceControlIntegration({ api, store });
  await sc.snapshot(); // learn the head commit
  const res = await sc.mergePr({ prNumber: 7, method: 'squash' });
  assert.equal(res.ok, true);
  assert.deepEqual(recorded.completions, [{ prId: 7, commit: 'headsha', method: 'squash' }]);
  store.close();
});

test('mergePr throws when the PR was never snapshotted (no known head commit)', async () => {
  const { api } = fakeApi();
  const store = new Store(':memory:');
  const sc = new AzureDevOpsSourceControlIntegration({ api, store });
  await assert.rejects(() => sc.mergePr({ prNumber: 99, method: 'merge' }), /no known merge commit/);
  store.close();
});

test('snapshot maps a PR label through (the exclusion-tag signal)', async () => {
  const { api } = fakeApi({ pulls: [pull({ pullRequestId: 7 })], labels: { 7: ['lubbdubb-ignore'] } });
  const store = new Store(':memory:');
  const sc = new AzureDevOpsSourceControlIntegration({ api, store });
  const prSlice = (await sc.snapshot()).pullRequests![0]!;
  assert.deepEqual(prSlice.labels, ['lubbdubb-ignore']);
  store.close();
});

test('setPrLabel adds or removes a label through the API', async () => {
  const { api, recorded } = fakeApi();
  const store = new Store(':memory:');
  const sc = new AzureDevOpsSourceControlIntegration({ api, store });
  await sc.setPrLabel({ prNumber: 7, label: 'lubbdubb-ignore', present: true });
  await sc.setPrLabel({ prNumber: 7, label: 'lubbdubb-ignore', present: false });
  assert.deepEqual(recorded.labelSets, [
    { prId: 7, label: 'lubbdubb-ignore', present: true },
    { prId: 7, label: 'lubbdubb-ignore', present: false },
  ]);
  store.close();
});

// --------------------------------------------------------------------------
// AzureDevOpsWorkItemsIntegration.snapshot
// --------------------------------------------------------------------------

function workItem(over: Partial<AzWorkItem> = {}): AzWorkItem {
  return {
    id: 101,
    title: 'Bug',
    body: 'b',
    state: 'Active',
    tags: ['bug'],
    relationUrls: [],
    url: 'https://dev.azure.com/o/p/_workitems/edit/101',
    ...over,
  };
}

test('work items snapshot maps state / tags→labels / linked PR', async () => {
  const { api } = fakeApi({
    workItems: [
      workItem({ id: 101, state: 'Active', tags: ['bug'], relationUrls: ['vstfs:///Git/PullRequestId/p%2Fr%2F55'] }),
    ],
  });
  const store = new Store(':memory:');
  const issues = new AzureDevOpsWorkItemsIntegration({ api, store });
  const slice = await issues.snapshot();
  assert.equal(slice.issues!.length, 1);
  const issue = slice.issues![0]!;
  assert.equal(issue.number, 101);
  assert.equal(issue.state, 'open');
  assert.deepEqual(issue.labels, ['bug']);
  assert.equal(issue.linkedPrNumber, 55);
  assert.equal(issue.url, 'https://dev.azure.com/o/p/_workitems/edit/101');
  store.close();
});

test('work items snapshot passes the tag filter through to the API', async () => {
  const { api, recorded } = fakeApi({ workItems: [] });
  const store = new Store(':memory:');
  const issues = new AzureDevOpsWorkItemsIntegration({ api, store, workItemTag: 'agent-ready' });
  await issues.snapshot();
  assert.deepEqual(recorded.tagQueries, ['agent-ready']);
  store.close();
});

test('work items snapshot returns the last-good slice and records an error event on failure', async () => {
  const store = new Store(':memory:');
  const bad = fakeApi({ throwOn: 'listOpenWorkItems' });
  const issues = new AzureDevOpsWorkItemsIntegration({ api: bad.api, store });
  const slice = await issues.snapshot();
  assert.deepEqual(slice.issues, []);
  store.close();
});
