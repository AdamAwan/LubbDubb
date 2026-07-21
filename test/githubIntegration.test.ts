import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import {
  GitHubSourceControlIntegration,
  aggregateCiStatus,
  computeApproved,
  buildUnresolvedComments,
} from '../src/integrations/github/sourceControl.js';
import { GitHubIssuesIntegration, linkedPrFromTimeline } from '../src/integrations/github/issues.js';
import { resolvePullDetail } from '../src/integrations/github/octokitGitHubApi.js';
import type {
  GhCheckRun,
  GhCombinedStatus,
  GhCommentRef,
  GhIssue,
  GhMergeResult,
  GhPullDetail,
  GhPullSummary,
  GhReview,
  GhReviewComment,
  GhTimelineEvent,
  GitHubApi,
} from '../src/integrations/github/githubApi.js';
import type { MergeMethod } from '../src/sink/actionSink.js';

/** Everything a test wants to script. Every field defaults to empty/benign. */
interface Script {
  viewer?: string;
  pulls?: GhPullSummary[];
  detail?: Record<number, GhPullDetail>;
  reviews?: Record<number, GhReview[]>;
  reviewComments?: Record<number, GhReviewComment[]>;
  combinedStatus?: Record<string, GhCombinedStatus>;
  checkRuns?: Record<string, GhCheckRun[]>;
  issues?: GhIssue[];
  timeline?: Record<number, GhTimelineEvent[]>;
  throwOn?: 'listOpenPulls' | 'listOpenIssues';
}

interface Recorded {
  reviewReplies: Array<{ number: number; inReplyTo: number; body: string }>;
  issueComments: Array<{ number: number; body: string }>;
  merges: Array<{ number: number; method: MergeMethod }>;
  issueLabelQueries: Array<string | undefined>;
}

function fakeApi(script: Script = {}): { api: GitHubApi; recorded: Recorded } {
  const recorded: Recorded = { reviewReplies: [], issueComments: [], merges: [], issueLabelQueries: [] };
  const api: GitHubApi = {
    async viewerLogin() {
      return script.viewer ?? 'lubbdubb-bot';
    },
    async listOpenPulls() {
      if (script.throwOn === 'listOpenPulls') throw new Error('boom');
      return script.pulls ?? [];
    },
    async getPull(number) {
      return script.detail?.[number] ?? { mergeable: null, mergeableState: null, merged: false };
    },
    async listPullReviews(number) {
      return script.reviews?.[number] ?? [];
    },
    async listPullReviewComments(number) {
      return script.reviewComments?.[number] ?? [];
    },
    async getCombinedStatus(sha) {
      return script.combinedStatus?.[sha] ?? { state: '', totalCount: 0 };
    },
    async listCheckRuns(sha) {
      return script.checkRuns?.[sha] ?? [];
    },
    async listOpenIssues(label) {
      recorded.issueLabelQueries.push(label);
      if (script.throwOn === 'listOpenIssues') throw new Error('boom');
      return script.issues ?? [];
    },
    async listIssueTimeline(number) {
      return script.timeline?.[number] ?? [];
    },
    async createPullReviewReply(number, inReplyTo, body): Promise<GhCommentRef> {
      recorded.reviewReplies.push({ number, inReplyTo, body });
      return { url: `https://github.com/o/r/pull/${number}#discussion_r${inReplyTo}` };
    },
    async createIssueComment(number, body): Promise<GhCommentRef> {
      recorded.issueComments.push({ number, body });
      return { url: `https://github.com/o/r/issues/${number}#issuecomment-1` };
    },
    async mergePull(number, method): Promise<GhMergeResult> {
      recorded.merges.push({ number, method });
      return { sha: 'mergedsha', merged: true };
    },
  };
  return { api, recorded };
}

function pull(over: Partial<GhPullSummary> = {}): GhPullSummary {
  return {
    number: 7,
    title: 'X',
    branch: 'feat',
    baseBranch: 'main',
    headSha: 'sha7',
    authorLogin: 'alice',
    url: 'u',
    ...over,
  };
}

// --------------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------------

test('aggregateCiStatus: any failing check wins', () => {
  const runs: GhCheckRun[] = [
    { status: 'completed', conclusion: 'success' },
    { status: 'completed', conclusion: 'failure' },
  ];
  assert.equal(aggregateCiStatus(runs, { state: 'success', totalCount: 1 }), 'failing');
});

test('aggregateCiStatus: pending when a run is in progress and none failed', () => {
  const runs: GhCheckRun[] = [
    { status: 'completed', conclusion: 'success' },
    { status: 'in_progress', conclusion: null },
  ];
  assert.equal(aggregateCiStatus(runs, { state: '', totalCount: 0 }), 'pending');
});

test('aggregateCiStatus: passing when all signals succeed', () => {
  const runs: GhCheckRun[] = [{ status: 'completed', conclusion: 'success' }];
  assert.equal(aggregateCiStatus(runs, { state: 'success', totalCount: 2 }), 'passing');
});

test('aggregateCiStatus: unknown when there are no signals at all', () => {
  assert.equal(aggregateCiStatus([], { state: '', totalCount: 0 }), 'unknown');
});

test('aggregateCiStatus: combined-status failure counts even with no check-runs', () => {
  assert.equal(aggregateCiStatus([], { state: 'failure', totalCount: 1 }), 'failing');
});

test('computeApproved: approved when a reviewer approves and none requests changes', () => {
  const reviews: GhReview[] = [{ reviewerLogin: 'bob', state: 'APPROVED', submittedAt: '2026-01-01T00:00:00Z' }];
  assert.equal(computeApproved(reviews), true);
});

test('computeApproved: an outstanding CHANGES_REQUESTED cancels an approval', () => {
  const reviews: GhReview[] = [
    { reviewerLogin: 'bob', state: 'APPROVED', submittedAt: '2026-01-01T00:00:00Z' },
    { reviewerLogin: 'carol', state: 'CHANGES_REQUESTED', submittedAt: '2026-01-01T01:00:00Z' },
  ];
  assert.equal(computeApproved(reviews), false);
});

test('computeApproved: uses the latest review per reviewer', () => {
  // Bob first requested changes, then approved — his latest state is APPROVED.
  const reviews: GhReview[] = [
    { reviewerLogin: 'bob', state: 'CHANGES_REQUESTED', submittedAt: '2026-01-01T00:00:00Z' },
    { reviewerLogin: 'bob', state: 'APPROVED', submittedAt: '2026-01-01T02:00:00Z' },
  ];
  assert.equal(computeApproved(reviews), true);
});

test('buildUnresolvedComments: one entry per thread, keyed on the root comment', () => {
  const comments: GhReviewComment[] = [
    { id: 100, authorLogin: 'bob', body: 'why this?', inReplyToId: null },
    { id: 101, authorLogin: 'alice', body: 'because X', inReplyToId: 100 },
  ];
  const out = buildUnresolvedComments(comments, 'lubbdubb-bot');
  assert.equal(out.length, 1);
  assert.equal(out[0]!.id, '100');
  assert.equal(out[0]!.author, 'bob');
  assert.equal(out[0]!.body, 'why this?');
});

test('buildUnresolvedComments: handled when the bot authored the latest reply', () => {
  const comments: GhReviewComment[] = [
    { id: 100, authorLogin: 'bob', body: 'why?', inReplyToId: null },
    { id: 101, authorLogin: 'lubbdubb-bot', body: 'here is why', inReplyToId: 100 },
  ];
  assert.equal(buildUnresolvedComments(comments, 'lubbdubb-bot')[0]!.handled, true);
});

test('buildUnresolvedComments: not handled while the human commented last', () => {
  const comments: GhReviewComment[] = [
    { id: 100, authorLogin: 'lubbdubb-bot', body: 'thoughts?', inReplyToId: null },
    { id: 101, authorLogin: 'bob', body: 'change this', inReplyToId: 100 },
  ];
  assert.equal(buildUnresolvedComments(comments, 'lubbdubb-bot')[0]!.handled, false);
});

test('linkedPrFromTimeline: takes the most recent PR cross-reference', () => {
  const events: GhTimelineEvent[] = [
    { event: 'cross-referenced', sourcePrNumber: 40 },
    { event: 'labeled', sourcePrNumber: null },
    { event: 'connected', sourcePrNumber: 43 },
  ];
  assert.equal(linkedPrFromTimeline(events), 43);
});

test('linkedPrFromTimeline: null when nothing links a PR', () => {
  assert.equal(linkedPrFromTimeline([{ event: 'labeled', sourcePrNumber: null }]), null);
});

// --------------------------------------------------------------------------
// GitHubSourceControlIntegration.snapshot
// --------------------------------------------------------------------------

test('snapshot maps a PR with its CI / approval / mergeability / comments', async () => {
  const { api } = fakeApi({
    viewer: 'lubbdubb-bot',
    pulls: [pull({ number: 7, title: 'Add widget', branch: 'feat/widget', headSha: 'sha7', url: 'https://pr/7' })],
    detail: { 7: { mergeable: true, mergeableState: 'clean', merged: false } },
    reviews: { 7: [{ reviewerLogin: 'bob', state: 'APPROVED', submittedAt: '2026-01-01T00:00:00Z' }] },
    reviewComments: { 7: [{ id: 100, authorLogin: 'bob', body: 'why?', inReplyToId: null }] },
    combinedStatus: { sha7: { state: 'success', totalCount: 1 } },
    checkRuns: { sha7: [{ status: 'completed', conclusion: 'success' }] },
  });
  const store = new Store(':memory:');
  const sc = new GitHubSourceControlIntegration({ api, store });
  const slice = await sc.snapshot();
  const pr = slice.pullRequests![0]!;
  assert.equal(pr.number, 7);
  assert.equal(pr.title, 'Add widget');
  assert.equal(pr.branch, 'feat/widget');
  assert.equal(pr.ciStatus, 'passing');
  assert.equal(pr.approved, true);
  assert.equal(pr.mergeable, true);
  assert.equal(pr.merged, false);
  assert.equal(pr.url, 'https://pr/7');
  assert.equal(pr.unresolvedComments.length, 1);
  assert.equal(pr.unresolvedComments[0]!.handled, false);
  store.close();
});

test('snapshot leaves mergeable undefined when GitHub is still computing (null)', async () => {
  const { api } = fakeApi({
    pulls: [pull({ number: 7 })],
    detail: { 7: { mergeable: null, mergeableState: null, merged: false } },
  });
  const store = new Store(':memory:');
  const sc = new GitHubSourceControlIntegration({ api, store });
  const pr = (await sc.snapshot()).pullRequests![0]!;
  assert.equal(pr.mergeable, undefined);
  store.close();
});

// --------------------------------------------------------------------------
// resolvePullDetail: chase GitHub's lazily-computed merge state (#35)
// --------------------------------------------------------------------------

const noSleep = async (): Promise<void> => {};

test('resolvePullDetail re-polls past a transient unknown until a concrete state lands', async () => {
  const details: GhPullDetail[] = [
    { mergeable: null, mergeableState: 'unknown', merged: false }, // first read only triggers the compute
    { mergeable: false, mergeableState: 'dirty', merged: false }, // concrete on the second read
  ];
  let calls = 0;
  const detail = await resolvePullDetail(async () => details[calls++]!, { sleep: noSleep });
  assert.equal(calls, 2, 'polled again after the unknown');
  assert.equal(detail.mergeableState, 'dirty');
  assert.equal(detail.mergeable, false);
});

test('resolvePullDetail returns immediately when the first read is already concrete', async () => {
  let calls = 0;
  const detail = await resolvePullDetail(
    async () => {
      calls++;
      return { mergeable: true, mergeableState: 'clean', merged: false };
    },
    { sleep: noSleep },
  );
  assert.equal(calls, 1, 'no extra polls when the state is already known');
  assert.equal(detail.mergeableState, 'clean');
});

test('resolvePullDetail is bounded: it gives up after the retry budget and falls back to unknown', async () => {
  let calls = 0;
  const detail = await resolvePullDetail(
    async () => {
      calls++;
      return { mergeable: null, mergeableState: 'unknown', merged: false };
    },
    { retries: 3, sleep: noSleep },
  );
  assert.equal(calls, 4, 'the initial read plus three retries');
  assert.equal(detail.mergeable, null, 'unresolved after the budget — the next heartbeat tries again');
});

test('resolvePullDetail does not burn retries on a merged PR (mergeable is null but final)', async () => {
  let calls = 0;
  const detail = await resolvePullDetail(
    async () => {
      calls++;
      return { mergeable: null, mergeableState: 'unknown', merged: true };
    },
    { sleep: noSleep },
  );
  assert.equal(calls, 1, 'merged short-circuits the retry loop');
  assert.equal(detail.merged, true);
});

test('snapshot maps baseBranch and normalises mergeable_state', async () => {
  const { api } = fakeApi({
    pulls: [pull({ number: 7, baseBranch: 'develop' })],
    detail: { 7: { mergeable: false, mergeableState: 'dirty', merged: false } },
  });
  const store = new Store(':memory:');
  const sc = new GitHubSourceControlIntegration({ api, store });
  const pr = (await sc.snapshot()).pullRequests![0]!;
  assert.equal(pr.baseBranch, 'develop');
  assert.equal(pr.mergeableState, 'dirty');
  assert.equal(pr.mergeable, false);
  store.close();
});

test('an unrecognised mergeable_state normalises to unknown', async () => {
  const { api } = fakeApi({
    pulls: [pull({ number: 7 })],
    detail: { 7: { mergeable: true, mergeableState: 'unstable', merged: false } },
  });
  const store = new Store(':memory:');
  const sc = new GitHubSourceControlIntegration({ api, store });
  const pr = (await sc.snapshot()).pullRequests![0]!;
  assert.equal(pr.mergeableState, 'unknown');
  store.close();
});

test('snapshot applies the prAuthor filter client-side', async () => {
  const { api } = fakeApi({
    pulls: [pull({ number: 7, authorLogin: 'alice' }), pull({ number: 8, authorLogin: 'bob' })],
  });
  const store = new Store(':memory:');
  const sc = new GitHubSourceControlIntegration({ api, store, prAuthor: 'alice' });
  const prs = (await sc.snapshot()).pullRequests!;
  assert.deepEqual(
    prs.map((p) => p.number),
    [7],
  );
  store.close();
});

test('snapshot returns the last-good slice and records an error event on failure', async () => {
  const store = new Store(':memory:');
  const good = fakeApi({
    pulls: [pull({ number: 7 })],
    detail: { 7: { mergeable: true, mergeableState: 'clean', merged: false } },
  });
  const sc = new GitHubSourceControlIntegration({ api: good.api, store });
  await sc.snapshot(); // warm the last-good cache

  const bad = fakeApi({ throwOn: 'listOpenPulls' });
  const sc2 = new GitHubSourceControlIntegration({ api: bad.api, store });
  await sc2.snapshot(); // cold + failing → empty, and it must not throw
  const slice = await sc2.snapshot();
  assert.deepEqual(slice.pullRequests, []);
  store.close();
});

// --------------------------------------------------------------------------
// Outbound
// --------------------------------------------------------------------------

test('postPrReply threads under a review comment when commentId is set', async () => {
  const { api, recorded } = fakeApi();
  const store = new Store(':memory:');
  const sc = new GitHubSourceControlIntegration({ api, store });
  const res = await sc.postPrReply({ prNumber: 7, commentId: '100', body: 'because X' });
  assert.equal(res.ok, true);
  assert.match(res.ref!, /discussion_r100/);
  assert.deepEqual(recorded.reviewReplies, [{ number: 7, inReplyTo: 100, body: 'because X' }]);
  assert.equal(recorded.issueComments.length, 0);
  store.close();
});

test('postPrReply posts a top-level comment when commentId is null', async () => {
  const { api, recorded } = fakeApi();
  const store = new Store(':memory:');
  const sc = new GitHubSourceControlIntegration({ api, store });
  const res = await sc.postPrReply({ prNumber: 7, commentId: null, body: 'ping' });
  assert.equal(res.ok, true);
  assert.deepEqual(recorded.issueComments, [{ number: 7, body: 'ping' }]);
  assert.equal(recorded.reviewReplies.length, 0);
  store.close();
});

test('mergePr merges with the requested method and returns the merge sha', async () => {
  const { api, recorded } = fakeApi();
  const store = new Store(':memory:');
  const sc = new GitHubSourceControlIntegration({ api, store });
  const res = await sc.mergePr({ prNumber: 7, method: 'squash' });
  assert.equal(res.ok, true);
  assert.equal(res.ref, 'mergedsha');
  assert.deepEqual(recorded.merges, [{ number: 7, method: 'squash' }]);
  store.close();
});

// --------------------------------------------------------------------------
// GitHubIssuesIntegration.snapshot
// --------------------------------------------------------------------------

test('issues snapshot drops PRs and maps state / labels / linked PR', async () => {
  const { api } = fakeApi({
    issues: [
      {
        number: 101,
        title: 'Bug',
        body: 'b',
        labels: ['bug'],
        state: 'open',
        url: 'https://i/101',
        isPullRequest: false,
      },
      { number: 200, title: 'A PR', body: '', labels: [], state: 'open', url: 'https://i/200', isPullRequest: true },
    ],
    timeline: { 101: [{ event: 'cross-referenced', sourcePrNumber: 55 }] },
  });
  const store = new Store(':memory:');
  const issues = new GitHubIssuesIntegration({ api, store });
  const slice = await issues.snapshot();
  assert.equal(slice.issues!.length, 1);
  const issue = slice.issues![0]!;
  assert.equal(issue.number, 101);
  assert.equal(issue.state, 'open');
  assert.deepEqual(issue.labels, ['bug']);
  assert.equal(issue.linkedPrNumber, 55);
  assert.equal(issue.url, 'https://i/101');
  store.close();
});

test('issues snapshot passes the issueLabel filter through to the API', async () => {
  const { api, recorded } = fakeApi({ issues: [] });
  const store = new Store(':memory:');
  const issues = new GitHubIssuesIntegration({ api, store, issueLabel: 'bug' });
  await issues.snapshot();
  assert.deepEqual(recorded.issueLabelQueries, ['bug']);
  store.close();
});

test('issues snapshot returns the last-good slice and records an error event on failure', async () => {
  const store = new Store(':memory:');
  const bad = fakeApi({ throwOn: 'listOpenIssues' });
  const issues = new GitHubIssuesIntegration({ api: bad.api, store });
  const slice = await issues.snapshot();
  assert.deepEqual(slice.issues, []);
  store.close();
});
