import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import {
  GitHubSourceControlIntegration,
  aggregateCiStatus,
  computeApproved,
  buildUnresolvedComments,
} from '../src/integrations/github/sourceControl.js';
import { GitHubIssuesIntegration, linkedPrFromTimeline, viewerAddedLabels } from '../src/integrations/github/issues.js';
import { diffWorlds } from '../src/world/worldDiff.js';
import type { Issue, WorldSnapshot } from '../src/types.js';
import { resolvePullDetail } from '../src/integrations/github/octokitGitHubApi.js';
import type {
  GhAnnotation,
  GhCheckRun,
  GhClosedPull,
  GhCombinedStatus,
  GhCommentRef,
  GhIssue,
  GhMergeResult,
  GhPullDetail,
  GhPullSummary,
  GhReview,
  GhReviewComment,
  GhReviewThread,
  GhTimelineEvent,
  GitHubApi,
} from '../src/integrations/github/githubApi.js';
import type { MergeMethod } from '../src/sink/actionSink.js';

/** Everything a test wants to script. Every field defaults to empty/benign. */
interface Script {
  viewer?: string;
  pulls?: GhPullSummary[];
  closedPulls?: GhClosedPull[];
  detail?: Record<number, GhPullDetail>;
  reviews?: Record<number, GhReview[]>;
  reviewComments?: Record<number, GhReviewComment[]>;
  reviewThreads?: Record<number, GhReviewThread[]>;
  combinedStatus?: Record<string, GhCombinedStatus>;
  checkRuns?: Record<string, GhCheckRun[]>;
  /**
   * Issues the two listings serve. Timestamps are optional here and defaulted by
   * {@link scriptedIssue} — a fixture about labels or linked PRs has no business
   * stating a `created_at` to satisfy the mirror's ordering.
   */
  issues?: Array<Omit<GhIssue, 'createdAt' | 'updatedAt'> & Partial<Pick<GhIssue, 'createdAt' | 'updatedAt'>>>;
  /** What `listIssuesChangedSince` was asked from, in call order. */
  historySince?: string[];
  timeline?: Record<number, GhTimelineEvent[]>;
  throwOn?:
    | 'listOpenPulls'
    | 'listOpenIssues'
    | 'listPullReviewThreads'
    | 'resolveReviewThread'
    | 'updatePullBranch'
    | 'getJobLog'
    | 'viewerLogin';
  /** Check-run annotations by check-run id — the structured half of CI evidence. */
  annotations?: Record<number, GhAnnotation[]>;
  /** Actions job logs by job id — the fallback half. */
  jobLogs?: Record<number, string>;
  createdPullNumber?: number;
  createdIssueNumber?: number;
  /** Branches the remote says are already gone — `deleteBranch` reports false for these. */
  missingBranches?: string[];
}

/** A scripted issue with the timestamps the mirror reads defaulted in. */
function scriptedIssue(
  i: Omit<GhIssue, 'createdAt' | 'updatedAt'> & Partial<Pick<GhIssue, 'createdAt' | 'updatedAt'>>,
): GhIssue {
  return { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...i };
}

interface Recorded {
  reviewReplies: Array<{ number: number; inReplyTo: number; body: string }>;
  issueComments: Array<{ number: number; body: string }>;
  commentEdits: Array<{ commentId: number; body: string }>;
  merges: Array<{ number: number; method: MergeMethod }>;
  issueLabelQueries: Array<string | undefined>;
  /** Instants `listIssuesChangedSince` was called with. */
  historySince: string[];
  labelSets: Array<{ number: number; label: string; present: boolean }>;
  closed: Array<{ number: number; reason: string }>;
  closedSince: string[];
  annotationReads: number[];
  jobLogReads: number[];
  createdPulls: Array<{ head: string; base: string; title: string; body: string }>;
  createdIssues: Array<{ title: string; body: string; labels: string[]; assignee: string | null }>;
  titleSets: Array<{ number: number; title: string }>;
  baseSets: Array<{ number: number; base: string }>;
  /** PR numbers `updatePullBranch` was called for — the server-side base merge. */
  branchUpdates: number[];
  deletedBranches: string[];
  /** Threads `resolveReviewThread` was called for — the resolution write. */
  resolvedThreads: Array<{ number: number; rootCommentId: number }>;
}

function fakeApi(script: Script = {}): { api: GitHubApi; recorded: Recorded } {
  const recorded: Recorded = {
    reviewReplies: [],
    issueComments: [],
    commentEdits: [],
    merges: [],
    issueLabelQueries: [],
    historySince: [],
    labelSets: [],
    closed: [],
    closedSince: [],
    annotationReads: [],
    jobLogReads: [],
    createdPulls: [],
    createdIssues: [],
    titleSets: [],
    baseSets: [],
    branchUpdates: [],
    deletedBranches: [],
    resolvedThreads: [],
  };
  const api: GitHubApi = {
    async listCheckRunAnnotations(checkRunId) {
      recorded.annotationReads.push(checkRunId);
      return script.annotations?.[checkRunId] ?? [];
    },
    async getJobLog(jobId) {
      recorded.jobLogReads.push(jobId);
      if (script.throwOn === 'getJobLog') throw new Error('log expired');
      return script.jobLogs?.[jobId] ?? '';
    },
    async createPull(input) {
      recorded.createdPulls.push(input);
      return { number: script.createdPullNumber ?? 77 };
    },
    async createIssue(input) {
      recorded.createdIssues.push(input);
      return { number: script.createdIssueNumber ?? 314 };
    },
    async setPullTitle(number, title) {
      recorded.titleSets.push({ number, title });
    },
    async setPullBase(number, base) {
      recorded.baseSets.push({ number, base });
    },
    async updatePullBranch(number) {
      if (script.throwOn === 'updatePullBranch') throw new Error('merge conflict between base and head');
      recorded.branchUpdates.push(number);
    },
    async deleteBranch(branch) {
      recorded.deletedBranches.push(branch);
      return script.missingBranches?.includes(branch) !== true;
    },
    async viewerLogin() {
      if (script.throwOn === 'viewerLogin') throw new Error('Bad credentials');
      return script.viewer ?? 'lubbdubb-bot';
    },
    async listOpenPulls() {
      if (script.throwOn === 'listOpenPulls') throw new Error('boom');
      return script.pulls ?? [];
    },
    async listRecentlyClosedPulls(since) {
      recorded.closedSince.push(since);
      return (script.closedPulls ?? []).filter((p) => p.closedAt >= since);
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
    async listPullReviewThreads(number) {
      if (script.throwOn === 'listPullReviewThreads') throw new Error('graphql unavailable');
      return script.reviewThreads?.[number] ?? [];
    },
    async resolveReviewThread(number, rootCommentId) {
      if (script.throwOn === 'resolveReviewThread') throw new Error('graphql unavailable');
      recorded.resolvedThreads.push({ number, rootCommentId });
      return (script.reviewThreads?.[number] ?? []).some((t) => t.rootCommentId === rootCommentId);
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
      return (script.issues ?? []).filter((i) => i.state === 'open').map(scriptedIssue);
    },
    async listIssuesChangedSince(since, label) {
      recorded.historySince.push(since);
      recorded.issueLabelQueries.push(label);
      // Every state, unlike the open list above — the whole point of the seam.
      return (script.issues ?? []).map(scriptedIssue);
    },
    async listIssueTimeline(number) {
      return script.timeline?.[number] ?? [];
    },
    async createPullReviewReply(number, inReplyTo, body): Promise<GhCommentRef> {
      recorded.reviewReplies.push({ number, inReplyTo, body });
      return { url: `https://github.com/o/r/pull/${number}#discussion_r${inReplyTo}`, id: inReplyTo };
    },
    async createIssueComment(number, body): Promise<GhCommentRef> {
      recorded.issueComments.push({ number, body });
      return { url: `https://github.com/o/r/issues/${number}#issuecomment-1`, id: 900 + number };
    },
    async updateIssueComment(commentId, body): Promise<GhCommentRef> {
      recorded.commentEdits.push({ commentId, body });
      return { url: `https://github.com/o/r/issues/1#issuecomment-${commentId}`, id: commentId };
    },
    async mergePull(number, method): Promise<GhMergeResult> {
      recorded.merges.push({ number, method });
      return { sha: 'mergedsha', merged: true };
    },
    async setPullLabel(number, label, present) {
      recorded.labelSets.push({ number, label, present });
    },
    async setIssueLabel(number, label, present) {
      recorded.labelSets.push({ number, label, present });
    },
    async closeIssue(number, reason) {
      recorded.closed.push({ number, reason });
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
    labels: [],
    assigneeLogins: [],
    ...over,
  };
}

// --------------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------------

test('aggregateCiStatus: any failing check wins', () => {
  const runs: GhCheckRun[] = [
    { name: 'build', status: 'completed', conclusion: 'success' },
    { name: 'lint', status: 'completed', conclusion: 'failure' },
  ];
  assert.equal(aggregateCiStatus(runs, { state: 'success', totalCount: 1 }), 'failing');
});

test('aggregateCiStatus: pending when a run is in progress and none failed', () => {
  const runs: GhCheckRun[] = [
    { name: 'build', status: 'completed', conclusion: 'success' },
    { name: 'e2e', status: 'in_progress', conclusion: null },
  ];
  assert.equal(aggregateCiStatus(runs, { state: '', totalCount: 0 }), 'pending');
});

test('aggregateCiStatus: passing when all signals succeed', () => {
  const runs: GhCheckRun[] = [{ name: 'build', status: 'completed', conclusion: 'success' }];
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

test('buildUnresolvedComments: the reviewer resolving the thread settles it', () => {
  // The primary arm, and the reviewer's own verdict. GitHub exposes it only in
  // GraphQL, which is the entire reason this function ever had to infer anything.
  const comments: GhReviewComment[] = [{ id: 100, authorLogin: 'bob', body: 'rename this', inReplyToId: null }];
  const threads: GhReviewThread[] = [{ rootCommentId: 100, isResolved: true }];
  assert.equal(buildUnresolvedComments(comments, 'lubbdubb-bot', threads)[0]!.handled, true);
});

test('buildUnresolvedComments: an unresolved thread the bot already replied to is still handled', () => {
  // The arms are independent: an unresolved verdict does not reopen a thread the
  // harness has answered, or every reply would be re-litigated until a human
  // clicked resolve.
  const comments: GhReviewComment[] = [
    { id: 100, authorLogin: 'bob', body: 'why?', inReplyToId: null },
    { id: 101, authorLogin: 'lubbdubb-bot', body: 'because X', inReplyToId: 100 },
  ];
  const threads: GhReviewThread[] = [{ rootCommentId: 100, isResolved: false }];
  assert.equal(buildUnresolvedComments(comments, 'lubbdubb-bot', threads)[0]!.handled, true);
});

test('buildUnresolvedComments: an unanswered thread the operator opened is not handled', () => {
  // The bug this closes, on the fallback arm: `viewerLogin` is whoever holds
  // GITHUB_TOKEN, which on a single-operator deployment is the operator.
  // Comparing the *root's* author against it marked every review comment they
  // left as handled the instant they wrote it, so the harness silently ignored
  // exactly the reviews a human took the time to write. The harness posts nothing
  // but replies, so the position test needs no identity to work.
  const comments: GhReviewComment[] = [
    { id: 100, authorLogin: 'the-operator', body: 'rename this', inReplyToId: null },
  ];
  assert.equal(buildUnresolvedComments(comments, 'the-operator')[0]!.handled, false);
  // And unchanged when resolution was read and said nothing about it.
  assert.equal(
    buildUnresolvedComments(comments, 'the-operator', [{ rootCommentId: 100, isResolved: false }])[0]!.handled,
    false,
  );
});

test('buildUnresolvedComments: missing resolution degrades to the reply arm, never to handled', () => {
  // `threads` is empty when the GraphQL read failed or a caller supplied none.
  // Absence means "no verdict", never "resolved" — a thread must fail open.
  const comments: GhReviewComment[] = [{ id: 100, authorLogin: 'bob', body: 'rename this', inReplyToId: null }];
  assert.equal(buildUnresolvedComments(comments, 'lubbdubb-bot', [])[0]!.handled, false);
  assert.equal(buildUnresolvedComments(comments, 'lubbdubb-bot')[0]!.handled, false);
});

test('buildUnresolvedComments: the operator reviewing under their own token still settles on a reply', () => {
  // The other half: once a reply *has* gone out under that same identity, the
  // thread is answered. The fix must not turn every settled thread back on.
  const comments: GhReviewComment[] = [
    { id: 100, authorLogin: 'the-operator', body: 'rename this', inReplyToId: null },
    { id: 101, authorLogin: 'the-operator', body: 'done', inReplyToId: 100 },
  ];
  assert.equal(buildUnresolvedComments(comments, 'the-operator')[0]!.handled, true);
});

test('linkedPrFromTimeline: takes the most recent PR cross-reference', () => {
  const events: GhTimelineEvent[] = [
    { event: 'cross-referenced', sourcePrNumber: 40, label: null, actorLogin: null },
    { event: 'labeled', sourcePrNumber: null, label: 'bug', actorLogin: 'someone' },
    { event: 'connected', sourcePrNumber: 43, label: null, actorLogin: null },
  ];
  assert.equal(linkedPrFromTimeline(events), 43);
});

test('linkedPrFromTimeline: null when nothing links a PR', () => {
  assert.equal(
    linkedPrFromTimeline([{ event: 'labeled', sourcePrNumber: null, label: 'bug', actorLogin: 'me' }]),
    null,
  );
});

// --------------------------------------------------------------------------
// GitHubSourceControlIntegration.snapshot
// --------------------------------------------------------------------------

test('a PR somebody assigned to you is kept by the owner filter and reported as yours', async () => {
  const { api } = fakeApi({
    viewer: 'lubbdubb-bot',
    pulls: [
      pull({ number: 7, authorLogin: 'lubbdubb-bot' }),
      // Somebody else's, put on you: the whole case the widened filter exists for.
      pull({ number: 8, authorLogin: 'carol', assigneeLogins: ['lubbdubb-bot'] }),
      // Somebody else's, and nothing to do with you.
      pull({ number: 9, authorLogin: 'carol' }),
    ],
    detail: {
      7: { mergeable: true, mergeableState: 'clean', merged: false },
      8: { mergeable: true, mergeableState: 'clean', merged: false },
      9: { mergeable: true, mergeableState: 'clean', merged: false },
    },
  });
  const sc = new GitHubSourceControlIntegration({ api, prAuthor: 'lubbdubb-bot' });
  const slice = await sc.snapshot();

  assert.deepEqual(
    slice.pullRequests!.map((p) => p.number),
    [7, 8],
  );
  assert.equal(slice.pullRequests!.find((p) => p.number === 7)?.viewerAssignment, undefined);
  assert.equal(slice.pullRequests!.find((p) => p.number === 8)?.viewerAssignment, 'assignee');
});

test("someone else's assignee is not yours", async () => {
  const { api } = fakeApi({
    viewer: 'lubbdubb-bot',
    pulls: [pull({ number: 7, authorLogin: 'lubbdubb-bot', assigneeLogins: ['carol'] })],
    detail: { 7: { mergeable: true, mergeableState: 'clean', merged: false } },
  });
  const sc = new GitHubSourceControlIntegration({ api });
  assert.equal((await sc.snapshot()).pullRequests![0]!.viewerAssignment, undefined);
});

test('snapshot maps a PR with its CI / approval / mergeability / comments', async () => {
  const { api } = fakeApi({
    viewer: 'lubbdubb-bot',
    pulls: [pull({ number: 7, title: 'Add widget', branch: 'feat/widget', headSha: 'sha7', url: 'https://pr/7' })],
    detail: { 7: { mergeable: true, mergeableState: 'clean', merged: false } },
    reviews: { 7: [{ reviewerLogin: 'bob', state: 'APPROVED', submittedAt: '2026-01-01T00:00:00Z' }] },
    reviewComments: { 7: [{ id: 100, authorLogin: 'bob', body: 'why?', inReplyToId: null }] },
    combinedStatus: { sha7: { state: 'success', totalCount: 1 } },
    checkRuns: { sha7: [{ name: 'build', status: 'completed', conclusion: 'success' }] },
  });
  const store = new Store(':memory:');
  const sc = new GitHubSourceControlIntegration({ api });
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
  const sc = new GitHubSourceControlIntegration({ api });
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
  const sc = new GitHubSourceControlIntegration({ api });
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
  const sc = new GitHubSourceControlIntegration({ api });
  const pr = (await sc.snapshot()).pullRequests![0]!;
  assert.equal(pr.mergeableState, 'unknown');
  store.close();
});

test('snapshot applies the prAuthor filter client-side', async () => {
  const { api } = fakeApi({
    pulls: [pull({ number: 7, authorLogin: 'alice' }), pull({ number: 8, authorLogin: 'bob' })],
  });
  const store = new Store(':memory:');
  const sc = new GitHubSourceControlIntegration({ api, prAuthor: 'alice' });
  const prs = (await sc.snapshot()).pullRequests!;
  assert.deepEqual(
    prs.map((p) => p.number),
    [7],
  );
  store.close();
});

test('a first-read failure rejects rather than serving an empty world', async () => {
  const store = new Store(':memory:');
  const bad = fakeApi({ throwOn: 'listOpenPulls' });
  const sc = new GitHubSourceControlIntegration({ api: bad.api });
  // With no successful read to fall back on, an empty slice would fabricate a
  // world in which every open PR has vanished. It must fail instead.
  await assert.rejects(() => sc.snapshot(), /boom/);
  store.close();
});

test('a failure after a successful read serves the last-good slice, marked stale', async () => {
  const store = new Store(':memory:');
  const good = fakeApi({
    pulls: [pull({ number: 7 })],
    detail: { 7: { mergeable: true, mergeableState: 'clean', merged: false } },
  });
  const sc = new GitHubSourceControlIntegration({ api: good.api });
  const first = await sc.snapshot(); // warm the last-good cache
  assert.deepEqual(
    first.pullRequests!.map((p) => p.number),
    [7],
  );

  // Fail the second read, in place, on the same integration.
  good.api.listOpenPulls = async () => {
    throw new Error('boom');
  };
  const slice = await sc.snapshot();
  assert.deepEqual(
    slice.pullRequests!.map((p) => p.number),
    [7],
  );
  assert.equal(slice.stale, true);
  store.close();
});

test('a slice served fresh is not marked stale', async () => {
  const store = new Store(':memory:');
  const { api } = fakeApi({
    pulls: [pull({ number: 7 })],
    detail: { 7: { mergeable: true, mergeableState: 'clean', merged: false } },
  });
  const slice = await new GitHubSourceControlIntegration({ api }).snapshot();
  assert.equal(slice.stale, undefined);
  store.close();
});

test('a failing resolution read costs the verdict, not the snapshot', async () => {
  // The GraphQL read is the one call in the snapshot allowed to fail alone: it is
  // reachable for reasons the REST reads are not (token scope, Enterprise schema,
  // a proxy that passes /repos and not /graphql), and letting it throw would
  // freeze the whole world on `lastGood` over a field that only refines a verdict.
  const store = new Store(':memory:');
  const errors: string[] = [];
  const { api } = fakeApi({
    throwOn: 'listPullReviewThreads',
    pulls: [pull({ number: 7 })],
    detail: { 7: { mergeable: true, mergeableState: 'clean', merged: false } },
    reviewComments: { 7: [{ id: 100, authorLogin: 'bob', body: 'rename this', inReplyToId: null }] },
  });
  const sc = new GitHubSourceControlIntegration({
    api,
    errors: { record: (e: { message: string }) => errors.push(e.message) } as never,
  });
  const slice = await sc.snapshot();
  const prs = slice.pullRequests ?? [];

  assert.equal(prs.length, 1, 'the PR is still in the world');
  // Degraded to the reply arm — which fails toward the thread staying open.
  assert.equal(prs[0]!.unresolvedComments[0]!.handled, false);
  assert.equal(errors.length, 1, 'and the operator is told the verdict is degraded');
  assert.match(errors[0]!, /review-thread resolution/);
  store.close();
});

// --------------------------------------------------------------------------
// Outbound
// --------------------------------------------------------------------------

test('postPrReply threads under a review comment when commentId is set', async () => {
  const { api, recorded } = fakeApi();
  const store = new Store(':memory:');
  const sc = new GitHubSourceControlIntegration({ api });
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
  const sc = new GitHubSourceControlIntegration({ api });
  const res = await sc.postPrReply({ prNumber: 7, commentId: null, body: 'ping' });
  assert.equal(res.ok, true);
  assert.deepEqual(recorded.issueComments, [{ number: 7, body: 'ping' }]);
  assert.equal(recorded.reviewReplies.length, 0);
  store.close();
});

test('resolvePrThread resolves the thread keyed on the root comment the reply threads under', async () => {
  const { api, recorded } = fakeApi({ reviewThreads: { 7: [{ rootCommentId: 100, isResolved: false }] } });
  const store = new Store(':memory:');
  const sc = new GitHubSourceControlIntegration({ api });
  const res = await sc.resolvePrThread({ prNumber: 7, commentId: '100' });
  assert.equal(res.ok, true);
  assert.deepEqual(recorded.resolvedThreads, [{ number: 7, rootCommentId: 100 }]);
  store.close();
});

test('resolvePrThread reports a thread the pull request does not carry, rather than claiming one closed', async () => {
  // A stale reading rather than a fault: the executor says so on the reply's own
  // audit line and leaves the thread alone.
  const { api } = fakeApi({ reviewThreads: { 7: [{ rootCommentId: 100, isResolved: false }] } });
  const store = new Store(':memory:');
  const sc = new GitHubSourceControlIntegration({ api });
  assert.equal((await sc.resolvePrThread({ prNumber: 7, commentId: '999' })).ok, false);
  store.close();
});

test('mergePr merges with the requested method and returns the merge sha', async () => {
  const { api, recorded } = fakeApi();
  const store = new Store(':memory:');
  const sc = new GitHubSourceControlIntegration({ api });
  const res = await sc.mergePr({ prNumber: 7, method: 'squash' });
  assert.equal(res.ok, true);
  assert.equal(res.ref, 'mergedsha');
  assert.deepEqual(recorded.merges, [{ number: 7, method: 'squash' }]);
  store.close();
});

test('snapshot maps the PR labels through (the exclusion-tag signal)', async () => {
  const { api } = fakeApi({ pulls: [pull({ number: 7, labels: ['lubbdubb-ignore', 'bug'] })] });
  const store = new Store(':memory:');
  const sc = new GitHubSourceControlIntegration({ api });
  const prSlice = (await sc.snapshot()).pullRequests![0]!;
  assert.deepEqual(prSlice.labels, ['lubbdubb-ignore', 'bug']);
  store.close();
});

test('setPrLabel adds or removes a label through the API', async () => {
  const { api, recorded } = fakeApi();
  const store = new Store(':memory:');
  const sc = new GitHubSourceControlIntegration({ api });

  const added = await sc.setPrLabel({ prNumber: 7, label: 'lubbdubb-ignore', present: true });
  assert.equal(added.ok, true);
  await sc.setPrLabel({ prNumber: 7, label: 'lubbdubb-ignore', present: false });
  assert.deepEqual(recorded.labelSets, [
    { number: 7, label: 'lubbdubb-ignore', present: true },
    { number: 7, label: 'lubbdubb-ignore', present: false },
  ]);
  store.close();
});

// --------------------------------------------------------------------------
// Ref → URL resolution (RefResolvable)
// --------------------------------------------------------------------------

test('sourceControl resolves refs to canonical URLs using its owner/repo', () => {
  const { api } = fakeApi();
  const store = new Store(':memory:');
  const sc = new GitHubSourceControlIntegration({ api, owner: 'octo', repo: 'demo' });
  assert.equal(sc.resolveRefUrl('pr:42:ci'), 'https://github.com/octo/demo/pull/42');
  assert.equal(sc.resolveRefUrl('issue:13'), 'https://github.com/octo/demo/issues/13');
  assert.equal(sc.resolveRefUrl('epic:e1:groom'), null);
  store.close();
});

test('issues provider is also a ref resolver', () => {
  const { api } = fakeApi();
  const store = new Store(':memory:');
  const issues = new GitHubIssuesIntegration({ api, owner: 'octo', repo: 'demo' });
  assert.equal(issues.resolveRefUrl('#7'), 'https://github.com/octo/demo/issues/7');
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
    timeline: { 101: [{ event: 'cross-referenced', sourcePrNumber: 55, label: null, actorLogin: null }] },
  });
  const store = new Store(':memory:');
  const issues = new GitHubIssuesIntegration({ api });
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

test('viewerAddedLabels: keeps only current labels the viewer most recently added', () => {
  const events: GhTimelineEvent[] = [
    { event: 'labeled', sourcePrNumber: null, label: 'agent-ready', actorLogin: 'me' },
    { event: 'labeled', sourcePrNumber: null, label: 'bug', actorLogin: 'someone-else' },
  ];
  assert.deepEqual(viewerAddedLabels(events, 'me', ['agent-ready', 'bug']), ['agent-ready']);
});

test('viewerAddedLabels: a re-add by someone else transfers ownership away', () => {
  const events: GhTimelineEvent[] = [
    { event: 'labeled', sourcePrNumber: null, label: 'agent-ready', actorLogin: 'me' },
    { event: 'unlabeled', sourcePrNumber: null, label: 'agent-ready', actorLogin: 'someone-else' },
    { event: 'labeled', sourcePrNumber: null, label: 'agent-ready', actorLogin: 'someone-else' },
  ];
  assert.deepEqual(viewerAddedLabels(events, 'me', ['agent-ready']), []);
});

test('viewerAddedLabels: ignores a since-removed label even if the viewer once added it', () => {
  const events: GhTimelineEvent[] = [
    { event: 'labeled', sourcePrNumber: null, label: 'agent-ready', actorLogin: 'me' },
  ];
  // The label is no longer on the issue, so it must not count.
  assert.deepEqual(viewerAddedLabels(events, 'me', ['bug']), []);
});

test('issues snapshot resolves tag ownership when the ownership gate is on', async () => {
  const { api } = fakeApi({
    viewer: 'me',
    issues: [
      { number: 1, title: 'mine', body: '', labels: ['agent-ready'], state: 'open', url: 'u1', isPullRequest: false },
      {
        number: 2,
        title: 'theirs',
        body: '',
        labels: ['agent-ready'],
        state: 'open',
        url: 'u2',
        isPullRequest: false,
      },
      { number: 3, title: 'untagged', body: '', labels: ['bug'], state: 'open', url: 'u3', isPullRequest: false },
    ],
    timeline: {
      1: [{ event: 'labeled', sourcePrNumber: null, label: 'agent-ready', actorLogin: 'me' }],
      2: [{ event: 'labeled', sourcePrNumber: null, label: 'agent-ready', actorLogin: 'attacker' }],
      3: [],
    },
  });
  const store = new Store(':memory:');
  const issues = new GitHubIssuesIntegration({ api, ownershipLabel: 'agent-ready' });
  const slice = await issues.snapshot();
  const byNumber = new Map(slice.issues!.map((i) => [i.number, i]));
  // Both tagged issues carry the label, but only #1's was added by the viewer.
  assert.deepEqual(byNumber.get(1)!.labelsAddedByViewer, ['agent-ready']);
  assert.deepEqual(byNumber.get(2)!.labelsAddedByViewer, []);
  // #3 doesn't carry the gate label, so authorship is left untracked.
  assert.equal(byNumber.get(3)!.labelsAddedByViewer, undefined);
  store.close();
});

test('issues snapshot leaves ownership untracked when the gate is off', async () => {
  const { api } = fakeApi({
    issues: [
      { number: 1, title: 'x', body: '', labels: ['agent-ready'], state: 'open', url: 'u1', isPullRequest: false },
    ],
  });
  const store = new Store(':memory:');
  const issues = new GitHubIssuesIntegration({ api });
  const slice = await issues.snapshot();
  assert.equal(slice.issues![0]!.labelsAddedByViewer, undefined);
  store.close();
});

test('issues snapshot fetches every open issue (no ingest label filter)', async () => {
  const { api, recorded } = fakeApi({ issues: [] });
  const store = new Store(':memory:');
  const issues = new GitHubIssuesIntegration({ api });
  await issues.snapshot();
  assert.deepEqual(recorded.issueLabelQueries, [undefined], 'no label is passed — all open issues are ingested');
  store.close();
});

test('closeIssue closes with the reason GitHub draws on the timeline', async () => {
  const { api, recorded } = fakeApi();
  const store = new Store(':memory:');
  const issues = new GitHubIssuesIntegration({ api });
  // `not_planned` rather than `completed`: the plan back-out is "we are not doing
  // this", and the two read very differently to whoever finds the ticket later.
  await issues.closeIssue({ number: 7, reason: 'not_planned' });
  assert.deepEqual(recorded.closed, [{ number: 7, reason: 'not_planned' }]);
  store.close();
});

test('setIssueLabel adds/removes a label through the labels API', async () => {
  const { api, recorded } = fakeApi();
  const store = new Store(':memory:');
  const issues = new GitHubIssuesIntegration({ api });
  await issues.setIssueLabel({ number: 7, label: 'lubbdubb-watch', present: true });
  await issues.setIssueLabel({ number: 7, label: 'lubbdubb-ignore', present: false });
  assert.deepEqual(recorded.labelSets, [
    { number: 7, label: 'lubbdubb-watch', present: true },
    { number: 7, label: 'lubbdubb-ignore', present: false },
  ]);
  store.close();
});

test('createIssue files an issue with its labels and assignee on the create itself', async () => {
  const { api, recorded } = fakeApi({ createdIssueNumber: 314 });
  const issues = new GitHubIssuesIntegration({ api });

  const res = await issues.createIssue({
    title: 'CSV export 404s on Safari',
    body: 'Reported by the operator.',
    labels: ['lubbdubb-watch', 'bug'],
    // GitHub has no work item type — the field is dropped rather than turned into
    // a label nobody asked for on the repository.
    type: 'User Story',
    assignee: 'adamawan',
    relatedTo: null,
  });

  // The harness's own vocabulary, not a provider id: that is what a filing row
  // stores and what `link_ticket` speaks.
  assert.deepEqual(res, { ok: true, ref: 'issue:314' });
  assert.deepEqual(recorded.createdIssues, [
    {
      title: 'CSV export 404s on Safari',
      body: 'Reported by the operator.',
      labels: ['lubbdubb-watch', 'bug'],
      assignee: 'adamawan',
    },
  ]);
});

test('a related item becomes the cross-reference GitHub draws on both issues', async () => {
  const { api, recorded } = fakeApi();
  const issues = new GitHubIssuesIntegration({ api });
  await issues.createIssue({
    title: 'Bug',
    body: 'The symptom.',
    labels: [],
    type: null,
    assignee: null,
    relatedTo: 12,
  });
  // Naming `#12` in the body *is* GitHub's related link — the closest thing it has
  // to Azure's relation — so it is appended here rather than left to a caller who
  // would have to know which tracker they were filing into.
  assert.match(recorded.createdIssues[0]!.body, /The symptom\.\n\nRelated to #12\./);
});

test('a first-read failure rejects rather than serving an empty issue list', async () => {
  const store = new Store(':memory:');
  const bad = fakeApi({ throwOn: 'listOpenIssues' });
  const issues = new GitHubIssuesIntegration({ api: bad.api });
  await assert.rejects(() => issues.snapshot(), /boom/);
  store.close();
});

test('the plan status comment is created once, then edited in place', () => {
  const { api, recorded } = fakeApi();
  const store = new Store(':memory:');
  const issues = new GitHubIssuesIntegration({ api });
  return issues
    .upsertIssueComment({ number: 12, body: 'first', commentRef: null })
    .then((created) => {
      assert.deepEqual(recorded.issueComments, [{ number: 12, body: 'first' }]);
      assert.equal(created.ref, '912', 'the comment id comes back so the next write edits it');
      return issues.upsertIssueComment({ number: 12, body: 'second', commentRef: created.ref ?? null });
    })
    .then((edited) => {
      assert.deepEqual(recorded.commentEdits, [{ commentId: 912, body: 'second' }]);
      assert.equal(recorded.issueComments.length, 1, 'one living comment, not a stream');
      assert.equal(edited.ref, '912');
      store.close();
    });
});

test('createPullRequest posts head/base to the pulls API and returns the new number', async () => {
  const { api, recorded } = fakeApi({ createdPullNumber: 77 });
  const sc = new GitHubSourceControlIntegration({ api });
  const res = await sc.createPullRequest({
    branch: 'issue/12/cursor',
    base: 'issue/12/schema',
    title: '#12 [2/2] feat(store): cursor',
    body: 'part of #12',
  });
  assert.deepEqual(res, { ok: true, ref: '77' });
  assert.deepEqual(recorded.createdPulls, [
    { head: 'issue/12/cursor', base: 'issue/12/schema', title: '#12 [2/2] feat(store): cursor', body: 'part of #12' },
  ]);
});

test('deleteBranch reaps a merged branch, and an already-absent one is still a success', async () => {
  const { api, recorded } = fakeApi({ missingBranches: ['issue/13'] });
  const sc = new GitHubSourceControlIntegration({ api });

  assert.deepEqual(await sc.deleteBranch({ branch: 'issue/12' }), { ok: true, ref: 'issue/12' });
  // A repository with "automatically delete head branches" on removed it at merge
  // time. That is the common case, not a failure — throwing here would put a
  // permanent stream of noise in the error log on the best-configured repos.
  assert.deepEqual(await sc.deleteBranch({ branch: 'issue/13' }), {
    ok: true,
    ref: 'issue/13 (already absent)',
  });
  assert.deepEqual(recorded.deletedBranches, ['issue/12', 'issue/13']);
});

test('updatePrBranch merges the base in server-side, and a refusal throws', async () => {
  const { api, recorded } = fakeApi();
  const sc = new GitHubSourceControlIntegration({ api });

  // No worktree, no clone, no push — one call, and the base named back for the
  // audit line.
  assert.deepEqual(await sc.updatePrBranch({ prNumber: 12, base: 'main' }), { ok: true, ref: 'main' });
  assert.deepEqual(recorded.branchUpdates, [12]);

  // GitHub refusing the merge it called clean is the fallback's signal: it has to
  // reach the caller, never be swallowed into an ok result.
  const refusing = new GitHubSourceControlIntegration({ api: fakeApi({ throwOn: 'updatePullBranch' }).api });
  await assert.rejects(() => refusing.updatePrBranch({ prNumber: 12, base: 'main' }), /merge conflict/);
});

test('setPullTitle and setPullBase each write only their own field', async () => {
  const { api, recorded } = fakeApi();
  const sc = new GitHubSourceControlIntegration({ api });
  await sc.setPullTitle({ prNumber: 42, title: '#12 feat(store): cursor' });
  await sc.setPullBase({ prNumber: 42, base: 'main' });
  assert.deepEqual(recorded.titleSets, [{ number: 42, title: '#12 feat(store): cursor' }]);
  assert.deepEqual(recorded.baseSets, [{ number: 42, base: 'main' }]);
});

/**
 * `issue_closed` is unreachable on a real provider (issue #577).
 *
 * `diffWorlds` needs an in-place open→closed transition, and the issues provider
 * snapshots the **open set** only — so a closed issue simply leaves the world, and
 * "a removal emits nothing" is absolute. `pr_merged` has the identical defect and
 * arrives on `closedPullRequests` instead; there is no closed-issue list, so the
 * closure signal a reader wants is the ticket mirror and never `world_events`.
 *
 * `test/worldDiff.test.ts` exercises the branch with a hand-built pair of
 * snapshots in which a closed issue is still present — a world no provider
 * produces — so this drives the real integration instead.
 */
test('a closed issue produces no world event, because it leaves the world instead', async () => {
  const open: Script['issues'] = [
    { number: 10, title: 'Bug', body: '', labels: [], state: 'open', url: 'https://i/10', isPullRequest: false },
  ];
  const store = new Store(':memory:');

  const before = await new GitHubIssuesIntegration({ api: fakeApi({ issues: open }).api }).snapshot();
  assert.deepEqual(
    before.issues!.map((i) => `#${i.number}(${i.state})`),
    ['#10(open)'],
  );

  // The tracker closes it. The open list stops carrying it — which is the whole
  // point: `state: 'closed'` never reaches a snapshot.
  const closedScript: Script['issues'] = [{ ...open[0]!, state: 'closed' }];
  const after = await new GitHubIssuesIntegration({ api: fakeApi({ issues: closedScript }).api }).snapshot();
  assert.deepEqual(after.issues, [], 'the issue left the world rather than changing state in it');

  const world = (issues: Issue[]): WorldSnapshot => ({ takenAt: 'now', pullRequests: [], issues });
  assert.deepEqual(
    diffWorlds(world(before.issues!), world(after.issues!)),
    [],
    'no issue_closed, ever — a disappearance is not a progress signal',
  );

  // The one thing this lifecycle does report: a reopen is an appearance.
  assert.deepEqual(
    diffWorlds(world(after.issues!), world(before.issues!)).map((e) => e.kind),
    ['issue_opened'],
  );
  store.close();
});
