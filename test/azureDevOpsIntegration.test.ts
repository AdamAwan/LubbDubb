import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import {
  AzureDevOpsSourceControlIntegration,
  aggregatePolicyCiStatus,
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
  parseTags,
  viewerAddedTags,
} from '../src/integrations/azure/workItems.js';
import {
  buildOpenWorkItemQuery,
  isSignInHtml,
  RestAzureDevOpsApi,
  type AzureAuth,
} from '../src/integrations/azure/restAzureDevOpsApi.js';
import type {
  AzCommentRef,
  AzMergeResult,
  AzPolicyEvaluation,
  AzPull,
  AzThread,
  AzWorkItem,
  AzWorkItemUpdate,
  AzureDevOpsApi,
} from '../src/integrations/azure/azureDevOpsApi.js';
import type { MergeMethod } from '../src/sink/actionSink.js';

/** Everything a test wants to script. Every field defaults to empty/benign. */
interface Script {
  viewer?: string;
  pulls?: AzPull[];
  threads?: Record<number, AzThread[]>;
  policyEvals?: Record<number, AzPolicyEvaluation[]>;
  labels?: Record<number, string[]>;
  workItems?: AzWorkItem[];
  updates?: Record<number, AzWorkItemUpdate[]>;
  throwOn?: 'listActivePullRequests' | 'listOpenWorkItems';
}

interface Recorded {
  threadReplies: Array<{ prId: number; threadId: number; parentCommentId: number; content: string }>;
  newThreads: Array<{ prId: number; content: string }>;
  completions: Array<{ prId: number; commit: string; method: MergeMethod }>;
  tagQueries: Array<string | undefined>;
  updateQueries: number[];
  labelSets: Array<{ prId: number; label: string; present: boolean }>;
  stateSets: Array<{ id: number; state: string }>;
}

function fakeApi(script: Script = {}): { api: AzureDevOpsApi; recorded: Recorded } {
  const recorded: Recorded = {
    threadReplies: [],
    newThreads: [],
    completions: [],
    tagQueries: [],
    updateQueries: [],
    labelSets: [],
    stateSets: [],
  };
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
    async listPolicyEvaluations(prId) {
      return script.policyEvals?.[prId] ?? [];
    },
    async listPullLabels(prId) {
      return script.labels?.[prId] ?? [];
    },
    async listOpenWorkItems(tag) {
      recorded.tagQueries.push(tag);
      if (script.throwOn === 'listOpenWorkItems') throw new Error('boom');
      return script.workItems ?? [];
    },
    async listWorkItemUpdates(id) {
      recorded.updateQueries.push(id);
      return script.updates?.[id] ?? [];
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
    async setWorkItemState(id, state) {
      recorded.stateSets.push({ id, state });
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

/** The well-known build-validation and status branch-policy type GUIDs. */
const BUILD_TYPE = '0609b952-1397-4640-95ec-e00a01b2c241';
const STATUS_TYPE = 'cbdc66da-9728-4af8-aada-9a5a32e4a226';
const REVIEWERS_TYPE = 'fa4e907d-c16b-4a4c-9dfa-4906e5d171dd';

function evalRec(over: Partial<AzPolicyEvaluation> = {}): AzPolicyEvaluation {
  return { typeId: BUILD_TYPE, status: 'approved', isBlocking: true, isEnabled: true, ...over };
}

test('aggregatePolicyCiStatus: a rejected required build policy is failing', () => {
  assert.equal(aggregatePolicyCiStatus([evalRec({ status: 'approved' }), evalRec({ status: 'rejected' })]), 'failing');
});

test('aggregatePolicyCiStatus: a broken policy still blocks — treated as failing', () => {
  assert.equal(aggregatePolicyCiStatus([evalRec({ status: 'broken' })]), 'failing');
});

test('aggregatePolicyCiStatus: queued/running with none rejected is pending', () => {
  assert.equal(aggregatePolicyCiStatus([evalRec({ status: 'approved' }), evalRec({ status: 'running' })]), 'pending');
  assert.equal(aggregatePolicyCiStatus([evalRec({ status: 'queued' })]), 'pending');
});

test('aggregatePolicyCiStatus: passing when the required build/status checks are approved', () => {
  assert.equal(
    aggregatePolicyCiStatus([evalRec({ status: 'approved' }), evalRec({ typeId: STATUS_TYPE, status: 'approved' })]),
    'passing',
  );
});

test('aggregatePolicyCiStatus: unknown when no CI policy applies (empty / only notApplicable)', () => {
  assert.equal(aggregatePolicyCiStatus([]), 'unknown');
  assert.equal(aggregatePolicyCiStatus([evalRec({ status: 'notApplicable' }), evalRec({ status: null })]), 'unknown');
});

test('aggregatePolicyCiStatus: non-blocking, disabled, and non-CI policies are ignored', () => {
  // An optional (non-blocking) build failure isn't a required-check failure.
  assert.equal(aggregatePolicyCiStatus([evalRec({ status: 'rejected', isBlocking: false })]), 'unknown');
  // A disabled policy's evaluation is stale noise.
  assert.equal(aggregatePolicyCiStatus([evalRec({ status: 'rejected', isEnabled: false })]), 'unknown');
  // A rejected *reviewers* policy is a human gate, not CI — must not read as failing.
  assert.equal(aggregatePolicyCiStatus([evalRec({ typeId: REVIEWERS_TYPE, status: 'rejected' })]), 'unknown');
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
// RestAzureDevOpsApi.request — transient-failure retry & legible errors
// --------------------------------------------------------------------------

test('isSignInHtml: detects the sign-in page by content-type or a leading doctype/html tag', () => {
  assert.equal(isSignInHtml('text/html; charset=utf-8', 'whatever'), true);
  assert.equal(isSignInHtml(null, '\n\n<!DOCTYPE html><html>...'), true);
  assert.equal(isSignInHtml(null, '  <html lang="en">'), true);
  assert.equal(isSignInHtml('application/json', '{"value":[]}'), false);
  assert.equal(isSignInHtml(null, '{"value":[]}'), false);
});

/** A fake AzureAuth that counts forceRefresh calls. */
function fakeAuth(): { auth: AzureAuth; state: { refreshes: number } } {
  const state = { refreshes: 0 };
  const auth: AzureAuth = {
    async header() {
      return 'Bearer fake';
    },
    forceRefresh() {
      state.refreshes++;
    },
  };
  return { auth, state };
}

/** A fetch that returns each scripted response in turn (sticking on the last). */
function scriptedFetch(responses: Array<() => Response>): { fetch: typeof fetch; state: { calls: number } } {
  const state = { calls: 0 };
  const fetchFn = (async () => {
    const make = responses[Math.min(state.calls, responses.length - 1)]!;
    state.calls++;
    return make();
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, state };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const signInHtml = (status = 203) =>
  new Response('\n\n<!DOCTYPE html><html><body>sign in</body></html>', {
    status,
    headers: { 'content-type': 'text/html' },
  });

/** Build a client whose request() path is exercised via a real public method. */
function restApi(responses: Array<() => Response>) {
  const { auth, state: authState } = fakeAuth();
  const { fetch: fetchFn, state: fetchState } = scriptedFetch(responses);
  const logs: string[] = [];
  const api = new RestAzureDevOpsApi(
    'org',
    'proj',
    'repo',
    auth,
    fetchFn,
    (m) => logs.push(m),
    () => Promise.resolve(), // no real backoff
  );
  return { api, authState, fetchState, logs };
}

test('request: a transient sign-in-HTML 2xx is retried with a fresh token, then succeeds', async () => {
  const { api, authState, fetchState, logs } = restApi([() => signInHtml(), () => json({ value: [] })]);
  const pulls = await api.listActivePullRequests();
  assert.deepEqual(pulls, []);
  assert.equal(fetchState.calls, 2, 'retried once');
  assert.equal(authState.refreshes, 1, 'forced a token refresh before the retry');
  assert.match(logs[0]!, /retry 1\/2/);
});

test('request: a persistent sign-in page fails with an auth-naming error, not a JSON crash', async () => {
  const { api, authState, fetchState } = restApi([() => signInHtml()]);
  const err = await api.listActivePullRequests().then(
    () => assert.fail('expected the call to reject'),
    (e: Error) => e,
  );
  assert.match(err.message, /HTML sign-in page instead of JSON/);
  assert.match(err.message, /az login/); // the message names the actual cause
  // 1 initial + MAX_RETRIES(2) attempts, and a refresh before each retry.
  assert.equal(fetchState.calls, 3);
  assert.equal(authState.refreshes, 2);
});

test('request: malformed (non-HTML) JSON on a 2xx fails fast without retrying', async () => {
  const { api, fetchState, authState } = restApi([
    () => new Response('not json{', { status: 200, headers: { 'content-type': 'application/json' } }),
  ]);
  await assert.rejects(() => api.listActivePullRequests(), /invalid JSON/);
  assert.equal(fetchState.calls, 1, 'a genuine parse error is not retried');
  assert.equal(authState.refreshes, 0);
});

test('request: a 5xx is retried, a 4xx is not', async () => {
  const server = restApi([() => new Response('boom', { status: 503 }), () => json({ value: [] })]);
  await server.api.listActivePullRequests();
  assert.equal(server.fetchState.calls, 2, '5xx retried');

  const client = restApi([() => new Response('nope', { status: 403 })]);
  await assert.rejects(() => client.api.listActivePullRequests(), /-> 403/);
  assert.equal(client.fetchState.calls, 1, '4xx not retried');
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
    policyEvals: { 7: [evalRec({ status: 'approved' })] },
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
  // The raw System.State is preserved alongside the open/closed collapse.
  assert.equal(issue.workItemState, 'Active');
  assert.deepEqual(issue.labels, ['bug']);
  assert.equal(issue.linkedPrNumber, 55);
  assert.equal(issue.url, 'https://dev.azure.com/o/p/_workitems/edit/101');
  store.close();
});

test('setWorkItemState transitions the work item and records a connector event', async () => {
  const { api, recorded } = fakeApi();
  const store = new Store(':memory:');
  const issues = new AzureDevOpsWorkItemsIntegration({ api, store });
  const res = await issues.setWorkItemState({ number: 101, state: 'In Review' });
  assert.equal(res.ok, true);
  assert.deepEqual(recorded.stateSets, [{ id: 101, state: 'In Review' }]);
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

// --------------------------------------------------------------------------
// Tag-ownership resolution (viewerAddedTags / parseTags / snapshot wiring)
// --------------------------------------------------------------------------

test('parseTags: splits, trims and drops empties', () => {
  assert.deepEqual(parseTags('bug; agent-ready ;;'), ['bug', 'agent-ready']);
  assert.deepEqual(parseTags(undefined), []);
});

test('viewerAddedTags: attributes each add to the revision author', () => {
  const updates: AzWorkItemUpdate[] = [
    { revisedByUniqueName: 'me@acme.com', tagsOld: '', tagsNew: 'agent-ready' },
    { revisedByUniqueName: 'other@acme.com', tagsOld: 'agent-ready', tagsNew: 'agent-ready; extra' },
  ];
  assert.deepEqual([...viewerAddedTags(updates, 'me@acme.com')], ['agent-ready']);
});

test('viewerAddedTags: a re-add by someone else transfers ownership away', () => {
  const updates: AzWorkItemUpdate[] = [
    { revisedByUniqueName: 'me@acme.com', tagsOld: '', tagsNew: 'agent-ready' },
    { revisedByUniqueName: 'other@acme.com', tagsOld: 'agent-ready', tagsNew: '' },
    { revisedByUniqueName: 'other@acme.com', tagsOld: '', tagsNew: 'agent-ready' },
  ];
  assert.deepEqual([...viewerAddedTags(updates, 'me@acme.com')], []);
});

test('viewerAddedTags: a revision that leaves tags untouched preserves ownership', () => {
  const updates: AzWorkItemUpdate[] = [
    { revisedByUniqueName: 'me@acme.com', tagsOld: '', tagsNew: 'agent-ready' },
    { revisedByUniqueName: 'other@acme.com' }, // e.g. a title edit — no System.Tags diff
  ];
  assert.deepEqual([...viewerAddedTags(updates, 'me@acme.com')], ['agent-ready']);
});

test('work items snapshot resolves tag ownership only for items carrying the gate tag', async () => {
  const { api, recorded } = fakeApi({
    viewer: 'me@acme.com',
    workItems: [
      workItem({ id: 1, tags: ['agent-ready'] }),
      workItem({ id: 2, tags: ['agent-ready'] }),
      workItem({ id: 3, tags: ['bug'] }),
    ],
    updates: {
      1: [{ revisedByUniqueName: 'me@acme.com', tagsOld: '', tagsNew: 'agent-ready' }],
      2: [{ revisedByUniqueName: 'attacker@acme.com', tagsOld: '', tagsNew: 'agent-ready' }],
    },
  });
  const store = new Store(':memory:');
  const issues = new AzureDevOpsWorkItemsIntegration({ api, store, ownershipTag: 'agent-ready' });
  const slice = await issues.snapshot();
  const byNumber = new Map(slice.issues!.map((i) => [i.number, i]));
  assert.deepEqual(byNumber.get(1)!.labelsAddedByViewer, ['agent-ready']);
  assert.deepEqual(byNumber.get(2)!.labelsAddedByViewer, []);
  assert.equal(byNumber.get(3)!.labelsAddedByViewer, undefined);
  // Only the two tagged items triggered the extra revision fetch — #3 was skipped.
  assert.deepEqual(recorded.updateQueries.sort(), [1, 2]);
  store.close();
});

test('work items snapshot leaves ownership untracked when the gate is off', async () => {
  const { api, recorded } = fakeApi({ workItems: [workItem({ id: 1, tags: ['agent-ready'] })] });
  const store = new Store(':memory:');
  const issues = new AzureDevOpsWorkItemsIntegration({ api, store });
  const slice = await issues.snapshot();
  assert.equal(slice.issues![0]!.labelsAddedByViewer, undefined);
  assert.deepEqual(recorded.updateQueries, []);
  store.close();
});
