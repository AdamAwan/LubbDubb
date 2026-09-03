import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AzureDevOpsSourceControlIntegration, policyEvalsSettled } from '../src/integrations/azure/sourceControl.js';
import { AzureDevOpsWorkItemsIntegration } from '../src/integrations/azure/workItems.js';
import { HydrationCache } from '../src/integrations/hydrationCache.js';
import { AzureEtagCache } from '../src/integrations/azure/conditionalRequests.js';
import { RestAzureDevOpsApi } from '../src/integrations/azure/restAzureDevOpsApi.js';
import type {
  AzPolicyEvaluation,
  AzPull,
  AzThread,
  AzWorkItem,
  AzWorkItemUpdate,
  AzureDevOpsApi,
} from '../src/integrations/azure/azureDevOpsApi.js';

/**
 * Change-gated hydration on the Azure provider: a second snapshot over a world
 * that has not moved must issue **no** per-entity detail request, an entity that
 * has moved must be re-read, and neither must ever be mistaken for the
 * degradation path — a hit is a current reading, not a stale one.
 *
 * Everything here drives the `AzureDevOpsApi` seam with its own scripted fake, so
 * nothing touches the network. The counter on each read is the assertion: the
 * point of the change is a request that is not made.
 */

const BUILD_POLICY = '0609b952-1397-4640-95ec-e00a01b2c241';
const COMMENT_POLICY = 'c6a1889d-b943-4856-b76f-9e46bb6b0df2';

interface Script {
  pulls?: AzPull[];
  threads?: Record<number, AzThread[]>;
  policyEvals?: Record<number, AzPolicyEvaluation[]>;
  labels?: Record<number, string[]>;
  workItems?: AzWorkItem[];
  updates?: Record<number, AzWorkItemUpdate[]>;
}

interface Counts {
  threads: number[];
  policyEvals: number[];
  labels: number[];
  updates: number[];
}

function pull(over: Partial<AzPull> = {}): AzPull {
  return {
    pullRequestId: 7,
    title: 'Fix the thing',
    branch: 'feature/x',
    baseBranch: 'main',
    lastMergeSourceCommit: 'aaa111',
    authorUniqueName: 'bot@acme.com',
    authorDisplayName: 'Bot',
    url: 'https://dev.azure.com/o/p/_git/r/pullrequest/7',
    isDraft: false,
    mergeStatus: 'succeeded',
    reviewers: [],
    ...over,
  };
}

function workItem(over: Partial<AzWorkItem> = {}): AzWorkItem {
  return {
    id: 42,
    title: 'Ship it',
    body: '',
    state: 'Active',
    workItemType: 'User Story',
    tags: ['watch'],
    areaPath: 'Contoso',
    relationUrls: [],
    parentId: null,
    childIds: [],
    url: 'https://dev.azure.com/o/p/_workitems/edit/42',
    createdAt: '2026-01-01T00:00:00Z',
    changedAt: '2026-01-02T00:00:00Z',
    ...over,
  };
}

/** The whole seam, scripted. Every read counts itself; every write is inert. */
function fakeApi(script: Script): { api: AzureDevOpsApi; counts: Counts; script: Script } {
  const counts: Counts = { threads: [], policyEvals: [], labels: [], updates: [] };
  const nope = async (): Promise<never> => {
    throw new Error('not scripted');
  };
  const api: AzureDevOpsApi = {
    async viewerUniqueName() {
      return 'bot@acme.com';
    },
    async listActivePullRequests() {
      return script.pulls ?? [];
    },
    async listRecentlyClosedPullRequests() {
      return [];
    },
    async listPullThreads(id) {
      counts.threads.push(id);
      return script.threads?.[id] ?? [];
    },
    async listPolicyEvaluations(id) {
      counts.policyEvals.push(id);
      return script.policyEvals?.[id] ?? [];
    },
    async listPullLabels(id) {
      counts.labels.push(id);
      return script.labels?.[id] ?? [];
    },
    async listOpenWorkItems() {
      return script.workItems ?? [];
    },
    async listWorkItemsChangedSince() {
      return script.workItems ?? [];
    },
    async getWorkItems() {
      return [];
    },
    async listWorkItemUpdates(id) {
      counts.updates.push(id);
      return script.updates?.[id] ?? [];
    },
    requeuePolicyEvaluation: nope,
    getBuildTimeline: nope,
    getBuildLog: nope,
    createThreadReply: nope,
    async setThreadStatus() {},
    createThread: nope,
    completePullRequest: nope,
    async setPullLabel() {},
    async setWorkItemState() {},
    createWorkItemComment: nope,
    updateWorkItemComment: nope,
    async linkWorkItemToPull() {},
    createWorkItem: nope,
    async relateWorkItem() {},
    async setWorkItemTag() {},
    async listAreaPaths() {
      return { root: 'Contoso', paths: [] };
    },
    async setWorkItemParent() {},
    async setWorkItemAreaPath() {},
    createPull: nope,
    async setPullTitle() {},
    async setPullBase() {},
    async abandonPullRequest() {},
    async deleteBranch() {
      return true;
    },
  };
  return { api, counts, script };
}

/** A settled (approved, unexpired) build policy — the state a reading may be reused from. */
function approvedBuild(): AzPolicyEvaluation {
  return {
    evaluationId: 'e1',
    typeId: BUILD_POLICY,
    displayName: 'CI',
    typeName: 'Build',
    status: 'approved',
    isBlocking: true,
    isEnabled: true,
  };
}

test('a second snapshot over an unmoved pull request re-reads no policy evaluation', async () => {
  const { api, counts } = fakeApi({ pulls: [pull()], policyEvals: { 7: [approvedBuild()] } });
  const sc = new AzureDevOpsSourceControlIntegration({ api });

  const first = await sc.snapshot();
  const second = await sc.snapshot();

  assert.deepEqual(counts.policyEvals, [7], 'the settled evaluation is read once, not once per pulse');
  // Threads and labels are not covered by any cheap token, so they are still paid
  // for — the change must not pretend otherwise.
  assert.deepEqual(counts.threads, [7, 7]);
  assert.deepEqual(counts.labels, [7, 7]);
  assert.equal(second.pullRequests?.[0]?.ciStatus, 'passing');
  assert.deepEqual(second.pullRequests?.[0]?.ciChecks, first.pullRequests?.[0]?.ciChecks);
});

test('a cache hit is a current reading and never marks the slice stale', async () => {
  const { api } = fakeApi({ pulls: [pull()], policyEvals: { 7: [approvedBuild()] } });
  const sc = new AzureDevOpsSourceControlIntegration({ api });

  await sc.snapshot();
  const second = await sc.snapshot();

  // `stale` is the degradation path — a failed read replayed from `lastGood`.
  // Reuse is the opposite and must be indistinguishable from a fresh fan-out.
  assert.equal(second.stale, undefined);
});

test('a pull request whose head commit moved is re-hydrated', async () => {
  const script: Script = { pulls: [pull()], policyEvals: { 7: [approvedBuild()] } };
  const { api, counts } = fakeApi(script);
  const sc = new AzureDevOpsSourceControlIntegration({ api });

  await sc.snapshot();
  script.pulls = [pull({ lastMergeSourceCommit: 'bbb222' })];
  await sc.snapshot();

  assert.deepEqual(counts.policyEvals, [7, 7]);
});

test('a policy evaluation still running is re-read even though nothing else moved', async () => {
  const running: AzPolicyEvaluation = { ...approvedBuild(), status: 'running' };
  const { api, counts } = fakeApi({ pulls: [pull()], policyEvals: { 7: [running] } });
  const sc = new AzureDevOpsSourceControlIntegration({ api });

  await sc.snapshot();
  await sc.snapshot();
  await sc.snapshot();

  // The head commit does not move when a build finishes, so a token-only gate
  // would cache "pending" forever. Settledness is the second half of the gate.
  assert.deepEqual(counts.policyEvals, [7, 7, 7]);
});

test('an expired build validation is unsettled, so its evaluation is re-read', async () => {
  const expired: AzPolicyEvaluation = { ...approvedBuild(), status: 'queued', isExpired: true };
  const { api, counts } = fakeApi({ pulls: [pull()], policyEvals: { 7: [expired] } });
  const sc = new AzureDevOpsSourceControlIntegration({ api });

  await sc.snapshot();
  await sc.snapshot();

  assert.deepEqual(counts.policyEvals, [7, 7]);
});

test('a reviewer voting moves the token, so the reviewer policy is not served from cache', async () => {
  const script: Script = { pulls: [pull()], policyEvals: { 7: [approvedBuild()] } };
  const { api, counts } = fakeApi(script);
  const sc = new AzureDevOpsSourceControlIntegration({ api });

  await sc.snapshot();
  script.pulls = [
    pull({ reviewers: [{ uniqueName: 'dev@acme.com', vote: 10, isRequired: true, isContainer: false }] }),
  ];
  await sc.snapshot();

  assert.deepEqual(counts.policyEvals, [7, 7]);
});

test('a new comment thread moves the token, so the comment policy is not served from cache', async () => {
  const script: Script = {
    pulls: [pull()],
    policyEvals: { 7: [approvedBuild(), { ...approvedBuild(), typeId: COMMENT_POLICY, evaluationId: 'e2' }] },
  };
  const { api, counts } = fakeApi(script);
  const sc = new AzureDevOpsSourceControlIntegration({ api });

  await sc.snapshot();
  script.threads = {
    7: [
      {
        id: 1,
        status: 'active',
        comments: [
          { id: 1, authorUniqueName: 'dev@acme.com', content: 'why?', parentCommentId: null, commentType: 'text' },
        ],
      },
    ],
  };
  await sc.snapshot();

  assert.deepEqual(counts.policyEvals, [7, 7]);
});

test('a pull request that leaves the active set is dropped from the cache', async () => {
  const script: Script = { pulls: [pull()], policyEvals: { 7: [approvedBuild()] } };
  const { api, counts } = fakeApi(script);
  const sc = new AzureDevOpsSourceControlIntegration({ api });

  await sc.snapshot();
  script.pulls = [];
  await sc.snapshot();
  script.pulls = [pull()];
  await sc.snapshot();

  // Re-read rather than served from an entry the retain pass should have dropped.
  assert.deepEqual(counts.policyEvals, [7, 7]);
});

test('labelsAddedByViewer survives a cache hit and follows a revision bump', async () => {
  const script: Script = {
    workItems: [workItem()],
    updates: {
      42: [{ revisedByUniqueName: 'bot@acme.com', tagsOld: '', tagsNew: 'watch' }],
    },
  };
  const { api, counts } = fakeApi(script);
  const wi = new AzureDevOpsWorkItemsIntegration({ api, ownershipTag: 'watch' });

  const first = await wi.snapshot();
  const second = await wi.snapshot();

  assert.deepEqual(counts.updates, [42], 'the revision history is folded once per revision, not once per pulse');
  // The gate that stops the fleet silently when it is wrong: the reused answer
  // must be the same answer, not an empty one.
  assert.deepEqual(first.issues?.[0]?.labelsAddedByViewer, ['watch']);
  assert.deepEqual(second.issues?.[0]?.labelsAddedByViewer, ['watch']);
  assert.equal(second.stale, undefined);

  // Somebody else re-adds the tag: a revision, so `changedAt` moves and the fold
  // is paid for again — and now reports the tag as not this viewer's.
  script.workItems = [workItem({ changedAt: '2026-01-03T00:00:00Z' })];
  script.updates = {
    42: [
      { revisedByUniqueName: 'bot@acme.com', tagsOld: '', tagsNew: 'watch' },
      { revisedByUniqueName: 'dev@acme.com', tagsOld: '', tagsNew: 'watch' },
    ],
  };
  const third = await wi.snapshot();

  assert.deepEqual(counts.updates, [42, 42]);
  assert.deepEqual(third.issues?.[0]?.labelsAddedByViewer, []);
});

test('a work item Azure reports without a changed date is never gated', async () => {
  const script: Script = {
    workItems: [workItem({ changedAt: '' })],
    updates: { 42: [{ revisedByUniqueName: 'bot@acme.com', tagsOld: '', tagsNew: 'watch' }] },
  };
  const { api, counts } = fakeApi(script);
  const wi = new AzureDevOpsWorkItemsIntegration({ api, ownershipTag: 'watch' });

  await wi.snapshot();
  const second = await wi.snapshot();

  assert.deepEqual(counts.updates, [42, 42]);
  assert.deepEqual(second.issues?.[0]?.labelsAddedByViewer, ['watch']);
});

test('a work item that leaves the open set is dropped from the authorship cache', async () => {
  const script: Script = {
    workItems: [workItem()],
    updates: { 42: [{ revisedByUniqueName: 'bot@acme.com', tagsOld: '', tagsNew: 'watch' }] },
  };
  const { api, counts } = fakeApi(script);
  const wi = new AzureDevOpsWorkItemsIntegration({ api, ownershipTag: 'watch' });

  await wi.snapshot();
  script.workItems = [];
  await wi.snapshot();
  script.workItems = [workItem()];
  await wi.snapshot();

  assert.deepEqual(counts.updates, [42, 42]);
});

test('policyEvalsSettled ignores disabled and non-automated policies', () => {
  assert.equal(policyEvalsSettled([]), true);
  assert.equal(policyEvalsSettled([{ ...approvedBuild(), status: 'running', isEnabled: false }]), true);
  // A comment policy is only ever moved by something the reuse token already
  // sees, so a pending one does not make the reading unsettled.
  assert.equal(policyEvalsSettled([{ ...approvedBuild(), typeId: COMMENT_POLICY, status: 'queued' }]), true);
  assert.equal(policyEvalsSettled([{ ...approvedBuild(), status: null }]), false, 'no verdict yet reads as unsettled');
});

test('a hydration entry expires rather than being reused forever', () => {
  // The bound is the caller's, not the cache's: it is whatever the entity's lane
  // allows (`hydrationMaxAgeMs`), which is why it is passed per read.
  const maxAgeMs = 5 * 60_000;
  let now = 0;
  const cache = new HydrationCache<string>(() => now);
  cache.set(1, 'v');
  now = 4 * 60_000;
  assert.equal(cache.get(1, maxAgeMs), 'v');
  now = maxAgeMs;
  assert.equal(cache.get(1, maxAgeMs), undefined, 'the backstop for what no token covers');
});

test('the etag store bounds itself and drops the least recently used', () => {
  const cache = new AzureEtagCache(2);
  cache.set('a', 'W/"1"', '{}');
  cache.set('b', 'W/"2"', '{}');
  cache.get('a');
  cache.set('c', 'W/"3"', '{}');
  assert.equal(cache.get('b'), undefined);
  assert.notEqual(cache.get('a'), undefined);
  assert.notEqual(cache.get('c'), undefined);
});

test('a GET Azure ETagged is re-asked conditionally, and a 304 replays the reading', async () => {
  const sent: Array<Record<string, string>> = [];
  const body = JSON.stringify({
    value: [
      {
        pullRequestId: 3,
        title: 'T',
        sourceRefName: 'refs/heads/f',
        targetRefName: 'refs/heads/main',
      },
    ],
  });
  let calls = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    sent.push({ ...((init?.headers ?? {}) as Record<string, string>) });
    calls += 1;
    if (calls === 1) {
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json', etag: 'W/"abc"' },
      });
    }
    // `new Response` refuses a 304 (it is a null-body status), so the not-modified
    // answer is shaped by hand — which is what a real transport hands back anyway.
    return {
      ok: false,
      status: 304,
      statusText: 'Not Modified',
      headers: new Headers({ etag: 'W/"abc"' }),
      text: async () => '',
    } as unknown as Response;
  };
  const api = new RestAzureDevOpsApi(
    'org',
    'proj',
    'repo',
    {
      async header() {
        return 'Bearer t';
      },
    },
    fetchImpl,
  );

  const first = await api.listActivePullRequests();
  const second = await api.listActivePullRequests();

  assert.equal(sent[0]?.['If-None-Match'], undefined, 'nothing to validate against on the first read');
  assert.equal(sent[1]?.['If-None-Match'], 'W/"abc"');
  assert.deepEqual(second, first, 'a 304 is a current answer, replayed from the stored body');
});

test('a GET Azure did not ETag is never asked conditionally', async () => {
  const sent: Array<Record<string, string>> = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    sent.push({ ...((init?.headers ?? {}) as Record<string, string>) });
    return new Response(JSON.stringify({ value: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const api = new RestAzureDevOpsApi(
    'org',
    'proj',
    'repo',
    {
      async header() {
        return 'Bearer t';
      },
    },
    fetchImpl,
  );

  await api.listActivePullRequests();
  await api.listActivePullRequests();

  // The layer makes no claim about which endpoints validate: an endpoint that
  // volunteers no validator is left exactly as expensive as it was.
  assert.equal(sent.length, 2);
  for (const headers of sent) assert.equal(headers['If-None-Match'], undefined);
});
