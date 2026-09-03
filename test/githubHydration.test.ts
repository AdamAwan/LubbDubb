import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubSourceControlIntegration } from '../src/integrations/github/sourceControl.js';
import { GitHubIssuesIntegration } from '../src/integrations/github/issues.js';
import type {
  GhCheckRun,
  GhCombinedStatus,
  GhIssue,
  GhPullSummary,
  GhReview,
  GhReviewComment,
  GhReviewThread,
  GhTimelineEvent,
  GitHubApi,
} from '../src/integrations/github/githubApi.js';

/**
 * Change-gated hydration (`hydrationCache.ts`): a snapshot over a world nothing
 * has moved in must cost the list requests and nothing else, and a cache hit is a
 * *current* reading — never `stale`, which means a read failed.
 *
 * Every assertion here is about the **request tape**, because the saving is the
 * requests: a test that only compared the two snapshots' output would pass on an
 * implementation that fetched everything twice.
 */

/** Every per-entity read, in call order — the tape the reuse is asserted against. */
interface Tape {
  listOpenPulls: number;
  getPull: number[];
  listPullReviews: number[];
  listPullReviewComments: number[];
  listPullReviewThreads: number[];
  getCombinedStatus: string[];
  listCheckRuns: string[];
  listOpenIssues: number;
  listIssueTimeline: number[];
}

interface Script {
  pulls?: GhPullSummary[];
  issues?: GhIssue[];
  reviews?: Record<number, GhReview[]>;
  reviewComments?: Record<number, GhReviewComment[]>;
  reviewThreads?: Record<number, GhReviewThread[]>;
  combinedStatus?: Record<string, GhCombinedStatus>;
  checkRuns?: Record<string, GhCheckRun[]>;
  timeline?: Record<number, GhTimelineEvent[]>;
  /** GraphQL is unavailable — the one snapshot read allowed to fail on its own. */
  threadsThrow?: boolean;
  /** The list read is down — the failure the `lastGood` degradation exists for. */
  listThrows?: boolean;
}

/**
 * A `GitHubApi` that answers from `script` and records what it was asked for.
 * `script` is captured by reference, so a test moves the world between snapshots
 * by mutating it — which is exactly what the gating has to notice.
 */
function fakeApi(script: Script): { api: GitHubApi; tape: Tape } {
  const tape: Tape = {
    listOpenPulls: 0,
    getPull: [],
    listPullReviews: [],
    listPullReviewComments: [],
    listPullReviewThreads: [],
    getCombinedStatus: [],
    listCheckRuns: [],
    listOpenIssues: 0,
    listIssueTimeline: [],
  };
  const unused = (): never => {
    throw new Error('not part of the world read');
  };
  const api: GitHubApi = {
    async viewerLogin() {
      return 'lubbdubb-bot';
    },
    async listOpenPulls() {
      tape.listOpenPulls += 1;
      if (script.listThrows === true) throw new Error('502');
      return script.pulls ?? [];
    },
    async getPull(number) {
      tape.getPull.push(number);
      return { mergeable: true, mergeableState: 'clean', merged: false };
    },
    async listPullReviews(number) {
      tape.listPullReviews.push(number);
      return script.reviews?.[number] ?? [];
    },
    async listPullReviewComments(number) {
      tape.listPullReviewComments.push(number);
      return script.reviewComments?.[number] ?? [];
    },
    async listPullReviewThreads(number) {
      tape.listPullReviewThreads.push(number);
      if (script.threadsThrow === true) throw new Error('graphql unavailable');
      return script.reviewThreads?.[number] ?? [];
    },
    async getCombinedStatus(sha) {
      tape.getCombinedStatus.push(sha);
      return script.combinedStatus?.[sha] ?? { state: '', totalCount: 0 };
    },
    async listCheckRuns(sha) {
      tape.listCheckRuns.push(sha);
      return script.checkRuns?.[sha] ?? [];
    },
    async listOpenIssues() {
      tape.listOpenIssues += 1;
      return script.issues ?? [];
    },
    async listIssueTimeline(number) {
      tape.listIssueTimeline.push(number);
      return script.timeline?.[number] ?? [];
    },
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
  return { api, tape };
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
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function issue(over: Partial<GhIssue> = {}): GhIssue {
  return {
    number: 5,
    title: 'T',
    body: 'B',
    labels: [],
    state: 'open',
    url: 'u',
    isPullRequest: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const green: GhCheckRun[] = [{ name: 'build', status: 'completed', conclusion: 'success' }];

// --------------------------------------------------------------------------
// Pull requests
// --------------------------------------------------------------------------

test('hydration: a second snapshot over an unmoved world issues no per-PR detail requests', async () => {
  const script: Script = {
    pulls: [pull({ number: 7 }), pull({ number: 8, headSha: 'sha8' })],
    checkRuns: { sha7: green, sha8: green },
  };
  const { api, tape } = fakeApi(script);
  const scm = new GitHubSourceControlIntegration({ api });

  await scm.snapshot();
  assert.deepEqual(tape.getPull, [7, 8]);
  assert.deepEqual(tape.getCombinedStatus, ['sha7', 'sha8']);

  const second = await scm.snapshot();
  // The list is still read every pulse — it is what says nothing moved.
  assert.equal(tape.listOpenPulls, 2);
  assert.deepEqual(tape.getPull, [7, 8]);
  assert.deepEqual(tape.listPullReviews, [7, 8]);
  assert.deepEqual(tape.listPullReviewComments, [7, 8]);
  assert.deepEqual(tape.listPullReviewThreads, [7, 8]);
  assert.deepEqual(tape.getCombinedStatus, ['sha7', 'sha8']);
  assert.deepEqual(tape.listCheckRuns, ['sha7', 'sha8']);
  // A hit is a current reading, not a degraded one. `stale` means the read failed.
  assert.equal(second.stale, undefined);
  assert.equal(second.pullRequests?.length, 2);
});

test('hydration: a reused PR still reports what the previous fan-out found', async () => {
  const script: Script = {
    pulls: [pull()],
    reviews: { 7: [{ reviewerLogin: 'bob', state: 'APPROVED', submittedAt: '2026-01-01T00:00:00Z' }] },
    reviewComments: { 7: [{ id: 11, authorLogin: 'bob', body: 'fix this', inReplyToId: null }] },
    checkRuns: { sha7: green },
  };
  const { api } = fakeApi(script);
  const scm = new GitHubSourceControlIntegration({ api });

  const first = (await scm.snapshot()).pullRequests?.[0];
  const second = (await scm.snapshot()).pullRequests?.[0];
  assert.deepEqual(second, first);
  assert.equal(second?.approved, true);
  assert.equal(second?.ciStatus, 'passing');
  assert.equal(second?.unresolvedComments.length, 1);
});

test('hydration: a moved `updated_at` re-hydrates the detail reads', async () => {
  const script: Script = { pulls: [pull()], checkRuns: { sha7: green } };
  const { api, tape } = fakeApi(script);
  const scm = new GitHubSourceControlIntegration({ api });

  await scm.snapshot();
  script.reviewComments = { 7: [{ id: 11, authorLogin: 'bob', body: 'a review', inReplyToId: null }] };
  script.pulls = [pull({ updatedAt: '2026-01-02T00:00:00Z' })];
  const second = await scm.snapshot();

  assert.deepEqual(tape.getPull, [7, 7]);
  assert.deepEqual(tape.listPullReviewComments, [7, 7]);
  assert.equal(second.pullRequests?.[0]?.unresolvedComments.length, 1);
  // CI is gated separately: the head SHA did not move and the verdict was settled.
  assert.deepEqual(tape.listCheckRuns, ['sha7']);
});

test('hydration: a PR with no `updatedAt` on the list payload is never reused', async () => {
  const script: Script = { pulls: [{ ...pull(), updatedAt: undefined }], checkRuns: { sha7: green } };
  const { api, tape } = fakeApi(script);
  const scm = new GitHubSourceControlIntegration({ api });

  await scm.snapshot();
  await scm.snapshot();
  assert.deepEqual(tape.getPull, [7, 7]);
});

test('hydration: pending CI is re-read even though `updated_at` has not moved', async () => {
  const script: Script = {
    pulls: [pull()],
    checkRuns: { sha7: [{ name: 'build', status: 'in_progress', conclusion: null }] },
  };
  const { api, tape } = fakeApi(script);
  const scm = new GitHubSourceControlIntegration({ api });

  assert.equal((await scm.snapshot()).pullRequests?.[0]?.ciStatus, 'pending');
  script.checkRuns = { sha7: [{ name: 'build', status: 'completed', conclusion: 'failure' }] };
  const second = await scm.snapshot();

  // The check reads happened again; the reads `updated_at` covers did not.
  assert.deepEqual(tape.listCheckRuns, ['sha7', 'sha7']);
  assert.deepEqual(tape.getCombinedStatus, ['sha7', 'sha7']);
  assert.deepEqual(tape.getPull, [7]);
  assert.equal(second.pullRequests?.[0]?.ciStatus, 'failing');

  // Now settled on the same SHA — the one CI reading that cannot change.
  await scm.snapshot();
  assert.deepEqual(tape.listCheckRuns, ['sha7', 'sha7']);
});

test('hydration: CI with nothing reported yet is re-read rather than held as `unknown`', async () => {
  const script: Script = { pulls: [pull()] };
  const { api, tape } = fakeApi(script);
  const scm = new GitHubSourceControlIntegration({ api });

  assert.equal((await scm.snapshot()).pullRequests?.[0]?.ciStatus, 'unknown');
  script.checkRuns = { sha7: green };
  assert.equal((await scm.snapshot()).pullRequests?.[0]?.ciStatus, 'passing');
  assert.deepEqual(tape.listCheckRuns, ['sha7', 'sha7']);
});

test('hydration: a new head SHA re-reads the checks with `updated_at` unmoved', async () => {
  const script: Script = { pulls: [pull()], checkRuns: { sha7: green, sha9: green } };
  const { api, tape } = fakeApi(script);
  const scm = new GitHubSourceControlIntegration({ api });

  await scm.snapshot();
  script.pulls = [pull({ headSha: 'sha9' })];
  await scm.snapshot();
  assert.deepEqual(tape.listCheckRuns, ['sha7', 'sha9']);
});

test('hydration: a failed review-thread read is not held as a hit', async () => {
  const script: Script = { pulls: [pull()], checkRuns: { sha7: green }, threadsThrow: true };
  const { api, tape } = fakeApi(script);
  const scm = new GitHubSourceControlIntegration({ api });

  await scm.snapshot();
  await scm.snapshot();
  // Degradation is retried every pulse, exactly as before the cache existed.
  assert.deepEqual(tape.listPullReviewThreads, [7, 7]);
  assert.deepEqual(tape.getPull, [7, 7]);
});

test('hydration: a PR that leaves the open set and returns is hydrated afresh', async () => {
  const script: Script = { pulls: [pull()], checkRuns: { sha7: green } };
  const { api, tape } = fakeApi(script);
  const scm = new GitHubSourceControlIntegration({ api });

  await scm.snapshot();
  script.pulls = [];
  await scm.snapshot();
  script.pulls = [pull()];
  await scm.snapshot();
  assert.deepEqual(tape.getPull, [7, 7]);
  assert.deepEqual(tape.listCheckRuns, ['sha7', 'sha7']);
});

test('hydration: an entry past its reuse window is re-read even with every token unmoved', async () => {
  const script: Script = { pulls: [pull()], checkRuns: { sha7: green } };
  const { api, tape } = fakeApi(script);
  let clock = 1_000;
  const scm = new GitHubSourceControlIntegration({ api, now: () => clock });

  // The bound is the lane's, handed in per read — the cache states none of its own
  // (`src/world/readPlan.ts`).
  const lane = { hot: 'all' as const, hotMaxAgeMs: 5 * 60_000, coldMaxAgeMs: 10 * 60_000 };
  await scm.snapshot(lane);
  clock += 60_000;
  await scm.snapshot(lane);
  assert.deepEqual(tape.getPull, [7], 'inside the window, nothing is re-read');
  clock += 5 * 60_000;
  await scm.snapshot(lane);
  assert.deepEqual(tape.getPull, [7, 7]);
  assert.deepEqual(tape.listCheckRuns, ['sha7', 'sha7']);
});

/**
 * The lane split, where it actually bites: the backstop that re-reads an entity
 * nothing has moved is the **lane's** number, so two pull requests on one pulse
 * are re-hydrated on different clocks. → `docs/spec/04-harness-cycle.md#hot-and-cold`
 */
test('hydration: the hot lane re-reads on its backstop while the cold one holds', async () => {
  const script: Script = {
    pulls: [pull({ number: 7 }), pull({ number: 8, headSha: 'sha8' })],
    checkRuns: { sha7: green, sha8: green },
  };
  const { api, tape } = fakeApi(script);
  let clock = 1_000;
  const scm = new GitHubSourceControlIntegration({ api, now: () => clock });
  // PR 7 is moving; PR 8 is not. Nothing on either token moves for the whole test.
  const plan = { hot: new Set(['pr:7']), hotMaxAgeMs: 60_000, coldMaxAgeMs: 600_000 };

  await scm.snapshot(plan);
  assert.deepEqual(tape.getPull, [7, 8], 'the first read hydrates both — there is nothing to reuse');

  clock += 90_000;
  const second = await scm.snapshot(plan);
  assert.deepEqual(tape.getPull, [7, 8, 7], 'past its backstop, the hot one is paid for again');
  assert.equal(
    second.pullRequests?.length,
    2,
    'and the cold one is still in the slice: cold is a slower read, not a missing entity',
  );
  assert.deepEqual(
    second.pullRequests?.map((p) => p.number),
    [7, 8],
  );

  clock += 9 * 60_000;
  await scm.snapshot(plan);
  assert.deepEqual(tape.getPull, [7, 8, 7, 7, 8], 'the slow lane comes due eventually — cold is never never');
});

test('hydration: an issue on the slow lane is listed every pulse and hydrated on its own clock', async () => {
  const script: Script = { issues: [issue({ number: 5 }), issue({ number: 6 })] };
  const { api, tape } = fakeApi(script);
  let clock = 1_000;
  const issues = new GitHubIssuesIntegration({ api, now: () => clock });
  const plan = { hot: new Set(['issue:5']), hotMaxAgeMs: 60_000, coldMaxAgeMs: 600_000 };

  await issues.snapshot(plan);
  clock += 90_000;
  const second = await issues.snapshot(plan);

  assert.deepEqual(tape.listIssueTimeline, [5, 6, 5], 'the hot issue only');
  assert.equal(tape.listOpenIssues, 2, 'the cheap list is read every pulse either way');
  assert.deepEqual(
    second.issues?.map((i) => i.number),
    [5, 6],
    'both are in the world the dispatcher reasons over',
  );
});

test('hydration: reuse and staleness stay distinct — a hit is clean, a failure is stale', async () => {
  const script: Script = { pulls: [pull()], checkRuns: { sha7: green } };
  const { api } = fakeApi(script);
  const scm = new GitHubSourceControlIntegration({ api });

  await scm.snapshot();
  const hit = await scm.snapshot();
  assert.equal(hit.stale, undefined, 'a cache hit is a current reading, not a degraded one');

  script.listThrows = true;
  const degraded = await scm.snapshot();
  assert.equal(degraded.stale, true);
  assert.equal(degraded.pullRequests?.length, 1);
});

// --------------------------------------------------------------------------
// Issues
// --------------------------------------------------------------------------

test('hydration: a second issues snapshot over an unmoved world reads no timelines', async () => {
  const script: Script = { issues: [issue({ number: 5 }), issue({ number: 6 })] };
  const { api, tape } = fakeApi(script);
  const issues = new GitHubIssuesIntegration({ api });

  await issues.snapshot();
  const second = await issues.snapshot();
  assert.equal(tape.listOpenIssues, 2);
  assert.deepEqual(tape.listIssueTimeline, [5, 6]);
  assert.equal(second.stale, undefined);
  assert.equal(second.issues?.length, 2);
});

test('hydration: a moved issue is re-hydrated, and its linked PR with it', async () => {
  const script: Script = { issues: [issue()] };
  const { api, tape } = fakeApi(script);
  const issues = new GitHubIssuesIntegration({ api });

  await issues.snapshot();
  assert.equal((await issues.snapshot()).issues?.[0]?.linkedPrNumber, null);

  script.timeline = { 5: [{ event: 'cross-referenced', sourcePrNumber: 42, label: null, actorLogin: null }] };
  script.issues = [issue({ updatedAt: '2026-02-01T00:00:00Z' })];
  const third = await issues.snapshot();
  assert.deepEqual(tape.listIssueTimeline, [5, 5]);
  assert.equal(third.issues?.[0]?.linkedPrNumber, 42);
});

/**
 * The sharp edge this whole cache has to survive: `labelsAddedByViewer` gates
 * pickup fleet-wide, and a wrong answer stops the fleet with nothing red.
 */
test('hydration: a reused issue still reports the viewer-added labels', async () => {
  const script: Script = {
    issues: [issue({ labels: ['agent-ready'] })],
    timeline: { 5: [{ event: 'labeled', sourcePrNumber: null, label: 'agent-ready', actorLogin: 'lubbdubb-bot' }] },
  };
  const { api } = fakeApi(script);
  const issues = new GitHubIssuesIntegration({ api, ownershipLabel: 'agent-ready' });

  assert.deepEqual((await issues.snapshot()).issues?.[0]?.labelsAddedByViewer, ['agent-ready']);
  assert.deepEqual((await issues.snapshot()).issues?.[0]?.labelsAddedByViewer, ['agent-ready']);
});

test('hydration: a label removed since the cached timeline cannot come back through it', async () => {
  const script: Script = {
    issues: [issue({ labels: ['agent-ready', 'bug'] })],
    timeline: {
      5: [
        { event: 'labeled', sourcePrNumber: null, label: 'agent-ready', actorLogin: 'lubbdubb-bot' },
        { event: 'labeled', sourcePrNumber: null, label: 'bug', actorLogin: 'lubbdubb-bot' },
      ],
    },
  };
  const { api } = fakeApi(script);
  const issues = new GitHubIssuesIntegration({ api, ownershipLabel: 'agent-ready' });
  await issues.snapshot();

  // Only the list payload moves — a hand-edited label the timeline hasn't caught up on.
  script.issues = [issue({ labels: ['agent-ready'] })];
  assert.deepEqual((await issues.snapshot()).issues?.[0]?.labelsAddedByViewer, ['agent-ready']);
});

test('hydration: an issue past its reuse window re-reads its timeline', async () => {
  const script: Script = { issues: [issue()] };
  const { api, tape } = fakeApi(script);
  let clock = 0;
  const issues = new GitHubIssuesIntegration({ api, now: () => clock });

  await issues.snapshot();
  clock += 5 * 60_000;
  await issues.snapshot();
  assert.deepEqual(tape.listIssueTimeline, [5, 5]);
});
