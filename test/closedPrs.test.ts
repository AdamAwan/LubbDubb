import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { FakeConnector } from '../src/connector/fakeConnector.js';
import { closedWindowStart, withinClosedWindow } from '../src/integrations/closedWindow.js';
import { GitHubSourceControlIntegration, mapClosedPull } from '../src/integrations/github/sourceControl.js';
import {
  AzureDevOpsSourceControlIntegration,
  mapClosedPull as mapAzClosedPull,
} from '../src/integrations/azure/sourceControl.js';
import type { AzClosedPull, AzureDevOpsApi } from '../src/integrations/azure/azureDevOpsApi.js';
import type { GhClosedPull, GitHubApi } from '../src/integrations/github/githubApi.js';
import { diffWorlds } from '../src/world/worldDiff.js';
import { observePartPr } from '../src/plans/parts.js';
import { prState } from '../src/prHealth.js';
import type { PlanPart, PullRequest, WorldSnapshot } from '../src/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-07-25T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function pr(number: number, over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: `pr_${number}`,
    number,
    title: `PR ${number}`,
    branch: `feat/${number}`,
    ciStatus: 'passing',
    unresolvedComments: [],
    ...over,
  };
}

function world(over: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    takenAt: new Date(NOW).toISOString(),
    pullRequests: [],
    closedPullRequests: [],
    issues: [],
    ...over,
  };
}

function part(over: Partial<PlanPart> = {}): PlanPart {
  return {
    id: 'plan_1:api',
    planId: 'plan_1',
    slug: 'api',
    seq: 1,
    title: 'API',
    scope: 'src/server/',
    rationale: null,
    acceptance: null,
    touches: [],
    acceptanceMet: [],
    size: null,
    expectedKind: null,
    outcomeKind: null,
    outcomeRef: null,
    outcomeSummary: null,
    dependsOn: [],
    branch: 'issue/12/api',
    prNumber: null,
    status: 'dispatched',
    blockedReason: null,
    blockedBy: null,
    taskId: 'task_1',
    createdAt: '2026-07-25T10:00:00.000Z',
    updatedAt: '2026-07-25T10:00:00.000Z',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The window itself
// ---------------------------------------------------------------------------

test('closedWindowStart is the window measured back from the caller‑supplied clock', () => {
  assert.equal(closedWindowStart(NOW, 6 * HOUR), '2026-07-25T06:00:00.000Z');
});

test('withinClosedWindow keeps the boundary and drops a PR with no recorded close time', () => {
  const since = '2026-07-25T06:00:00.000Z';
  assert.equal(withinClosedWindow(since, since), true, 'inclusive at the boundary');
  assert.equal(withinClosedWindow('2026-07-25T05:59:59.000Z', since), false);
  // A row we cannot place in the window is dropped: inventing "closed just now"
  // would put a stale PR in front of the reconciler as fresh evidence.
  assert.equal(withinClosedWindow(null, since), false);
  assert.equal(withinClosedWindow(undefined, since), false);
});

test('prState never invents `closed`: an unobserved PR is open or merged, never abandoned', () => {
  assert.equal(prState(pr(1)), 'open');
  assert.equal(prState(pr(1, { merged: true })), 'merged');
  assert.equal(prState(pr(1, { state: 'closed', merged: false })), 'closed');
  // The explicit state wins — that is the only way `closed` can ever be reached.
  assert.equal(prState(pr(1, { state: 'merged' })), 'merged');
});

// ---------------------------------------------------------------------------
// worldDiff — pr_merged becomes real, pr_closed appears
// ---------------------------------------------------------------------------

test('a PR leaving the open set as merged emits pr_merged — the transition real providers never showed', () => {
  // The regression this fixes: `!before.merged && pr.merged` needs the PR to still
  // be in `pullRequests`, and neither provider lists a merged PR, so the event was
  // unreachable outside the fake.
  const before = world({ pullRequests: [pr(42)] });
  const after = world({
    closedPullRequests: [pr(42, { merged: true, state: 'merged', closedAt: '2026-07-25T11:00:00.000Z' })],
  });
  const events = diffWorlds(before, after);
  assert.deepEqual(
    events.map((e) => [e.kind, e.ref]),
    [['pr_merged', 'pr:42']],
  );
});

test('a PR closed without merging emits pr_closed, not pr_merged', () => {
  const before = world({ pullRequests: [pr(42)] });
  const after = world({ closedPullRequests: [pr(42, { merged: false, state: 'closed' })] });
  const [event] = diffWorlds(before, after);
  assert.equal(event!.kind, 'pr_closed');
  assert.match(event!.summary, /closed without merging/);
});

test('a closed PR lingering in the retention window is not re-announced every cycle', () => {
  const closed = [pr(42, { merged: true, state: 'merged' })];
  const first = world({ pullRequests: [pr(42)] });
  const second = world({ closedPullRequests: closed });
  assert.equal(diffWorlds(first, second).length, 1);
  // Same list next pulse — it stays for the whole window, and says nothing new.
  assert.deepEqual(diffWorlds(second, world({ closedPullRequests: closed })), []);
});

test('a merge already announced from the open list is not announced a second time when the PR closes', () => {
  // The fake marks a PR merged in place (so the loop settles) before it ever
  // leaves the open set, which is two observations of one merge.
  const merged = pr(42, { merged: true });
  const before = world({ pullRequests: [merged] });
  const after = world({ closedPullRequests: [{ ...merged, state: 'merged' as const }] });
  assert.deepEqual(diffWorlds(before, after), []);
});

test('the closed list does not disturb the open-PR diff', () => {
  const before = world({ pullRequests: [pr(7, { ciStatus: 'pending' })] });
  const after = world({
    pullRequests: [pr(7, { ciStatus: 'failing' })],
    closedPullRequests: [pr(42, { merged: true, state: 'merged' })],
  });
  assert.deepEqual(
    diffWorlds(before, after).map((e) => e.kind),
    ['pr_ci', 'pr_merged'],
  );
});

// ---------------------------------------------------------------------------
// The GitHub provider
// ---------------------------------------------------------------------------

function ghClosed(over: Partial<GhClosedPull> = {}): GhClosedPull {
  return {
    number: 42,
    title: 'Old work',
    branch: 'issue/12/api',
    baseBranch: 'main',
    authorLogin: 'alice',
    url: 'https://github.com/o/r/pull/42',
    merged: true,
    closedAt: '2026-07-25T11:00:00.000Z',
    mergeCommitSha: 'deadbee',
    ...over,
  };
}

function ghApi(closed: GhClosedPull[], recorded: string[]): GitHubApi {
  const unused = (): never => {
    throw new Error('not used by this test');
  };
  return {
    getJobLog: unused,
    listCheckRunAnnotations: unused,
    async viewerLogin() {
      return 'bot';
    },
    async listOpenPulls() {
      return [];
    },
    async listPullReviewThreads() {
      return [];
    },
    async listRecentlyClosedPulls(since) {
      recorded.push(since);
      return closed.filter((p) => p.closedAt >= since);
    },
    getPull: unused,
    listPullReviews: unused,
    listPullReviewComments: unused,
    getCombinedStatus: unused,
    listCheckRuns: unused,
    listOpenIssues: unused,
    listIssuesChangedSince: unused,
    listIssueTimeline: unused,
    createPullReviewReply: unused,
    createIssueComment: unused,
    updateIssueComment: unused,
    mergePull: unused,
    setPullLabel: unused,
    closeIssue: (): never => {
      throw new Error('closeIssue is not scripted in this test');
    },
    setIssueLabel: unused,
    createIssue: unused,
    createPull: unused,
    setPullTitle: unused,
    setPullBase: unused,
    updatePullBranch: unused,
    deleteBranch: unused,
  };
}

test('the github provider reports recently-closed PRs, marked merged vs closed-unmerged', async () => {
  const since: string[] = [];
  const integration = new GitHubSourceControlIntegration({
    api: ghApi([ghClosed(), ghClosed({ number: 43, merged: false, closedAt: '2026-07-25T10:00:00.000Z' })], since),
    closedPrWindowMs: 6 * HOUR,
    now: () => NOW,
  });

  const slice = await integration.snapshot();

  assert.deepEqual(since, ['2026-07-25T06:00:00.000Z'], 'the window is measured back from now');
  assert.deepEqual(
    slice.closedPullRequests?.map((p) => [p.number, p.state, p.merged]),
    [
      [42, 'merged', true],
      [43, 'closed', false],
    ],
  );
  assert.deepEqual(slice.pullRequests, [], 'closed PRs never join the open list');
});

test('the github provider skips the extra request entirely when the window is disabled', async () => {
  const since: string[] = [];
  const integration = new GitHubSourceControlIntegration({
    api: ghApi([ghClosed()], since),
    closedPrWindowMs: 0,
  });
  const slice = await integration.snapshot();
  assert.deepEqual(since, [], 'no lookup — an operator who has not asked for this pays nothing');
  assert.deepEqual(slice.closedPullRequests, []);
});

test('the prAuthor filter applies to closed PRs too', async () => {
  const integration = new GitHubSourceControlIntegration({
    api: ghApi([ghClosed(), ghClosed({ number: 43, authorLogin: 'someone-else' })], []),
    prAuthor: 'alice',
    closedPrWindowMs: 6 * HOUR,
    now: () => NOW,
  });
  assert.deepEqual(
    (await integration.snapshot()).closedPullRequests?.map((p) => p.number),
    [42],
  );
});

test('mapClosedPull (github) carries no CI or comment signal — nothing acts on a dead PR', () => {
  const mapped = mapClosedPull(ghClosed({ merged: false }));
  assert.equal(mapped.ciStatus, 'unknown');
  assert.deepEqual(mapped.unresolvedComments, []);
  assert.equal(mapped.state, 'closed');
  assert.equal(mapped.closedAt, '2026-07-25T11:00:00.000Z');
  assert.equal(mapped.branch, 'issue/12/api', 'the branch survives — reconciliation joins on it');
});

// ---------------------------------------------------------------------------
// The Azure provider
// ---------------------------------------------------------------------------

function azClosed(over: Partial<AzClosedPull> = {}): AzClosedPull {
  return {
    pullRequestId: 42,
    title: 'Old work',
    branch: 'issue/12/api',
    baseBranch: 'main',
    authorUniqueName: 'alice@acme.com',
    url: 'https://dev.azure.com/o/p/_git/r/pullrequest/42',
    merged: true,
    closedAt: '2026-07-25T11:00:00.000Z',
    mergeCommitSha: 'deadbee',
    ...over,
  };
}

function azApi(closed: AzClosedPull[], recorded: string[]): AzureDevOpsApi {
  const unused = (): never => {
    throw new Error('not used by this test');
  };
  return {
    getBuildTimeline: unused,
    requeuePolicyEvaluation: unused,
    getBuildLog: unused,
    async viewerUniqueName() {
      return 'bot@acme.com';
    },
    async listActivePullRequests() {
      return [];
    },
    async listRecentlyClosedPullRequests(since) {
      recorded.push(since);
      return closed.filter((p) => p.closedAt >= since);
    },
    listPullThreads: unused,
    listPolicyEvaluations: unused,
    listPullLabels: unused,
    listOpenWorkItems: unused,
    listWorkItemsChangedSince: unused,
    getWorkItems: unused,
    listWorkItemUpdates: unused,
    createThreadReply: unused,
    createThread: unused,
    completePullRequest: unused,
    setPullLabel: unused,
    createPull: unused,
    setPullTitle: unused,
    setPullBase: unused,
    deleteBranch: unused,
    setWorkItemState: unused,
    createWorkItemComment: unused,
    updateWorkItemComment: unused,
    createWorkItem: unused,
    relateWorkItem: unused,
    listAreaPaths: () => Promise.resolve({ root: 'Contoso', paths: [] }),
    setWorkItemParent: () => Promise.reject(new Error('not used')),
    setWorkItemAreaPath: () => Promise.reject(new Error('not used')),
    setWorkItemTag: unused,
    linkWorkItemToPull: unused,
  };
}

test('the azure provider reports completed and abandoned PRs, told apart', async () => {
  const since: string[] = [];
  const integration = new AzureDevOpsSourceControlIntegration({
    api: azApi([azClosed(), azClosed({ pullRequestId: 43, merged: false })], since),
    closedPrWindowMs: 3 * HOUR,
    now: () => NOW,
  });

  const slice = await integration.snapshot();

  assert.deepEqual(since, ['2026-07-25T09:00:00.000Z']);
  assert.deepEqual(
    slice.closedPullRequests?.map((p) => [p.number, p.state]),
    [
      [42, 'merged'],
      [43, 'closed'],
    ],
  );
});

test('the azure provider skips the lookup when the window is disabled, and filters by prAuthor', async () => {
  const since: string[] = [];
  const off = new AzureDevOpsSourceControlIntegration({
    api: azApi([azClosed()], since),
    closedPrWindowMs: 0,
  });
  assert.deepEqual((await off.snapshot()).closedPullRequests, []);
  assert.deepEqual(since, []);

  const filtered = new AzureDevOpsSourceControlIntegration({
    api: azApi([azClosed(), azClosed({ pullRequestId: 43, authorUniqueName: 'bob@acme.com' })], since),
    prAuthor: 'alice@acme.com',
    closedPrWindowMs: 3 * HOUR,
    now: () => NOW,
  });
  assert.deepEqual(
    (await filtered.snapshot()).closedPullRequests?.map((p) => p.number),
    [42],
  );
});

test('mapClosedPull (azure) blanks the signals only an active PR has', () => {
  const mapped = mapAzClosedPull(azClosed({ merged: false }));
  assert.equal(mapped.ciStatus, 'unknown');
  assert.deepEqual(mapped.unresolvedComments, []);
  assert.equal(mapped.state, 'closed');
  assert.equal(mapped.merged, false);
});

// ---------------------------------------------------------------------------
// Plan reconciliation reads the truth instead of guessing
// ---------------------------------------------------------------------------

test('observePartPr: a part whose PR was closed unmerged goes back to ready, not merged', () => {
  const inReview = part({ status: 'in_review', prNumber: 42 });
  const patch = observePartPr(inReview, 'issue/12/api', [], [pr(42, { state: 'closed', merged: false })]);
  assert.deepEqual(patch, { status: 'ready', branch: 'issue/12/api', prNumber: null });
});

test('observePartPr: a merged PR in the closed window completes the part', () => {
  const inReview = part({ status: 'in_review', prNumber: 42 });
  const patch = observePartPr(inReview, 'issue/12/api', [], [pr(42, { state: 'merged', merged: true })]);
  assert.deepEqual(patch, { status: 'merged', branch: 'issue/12/api', prNumber: 42 });
});

test('observePartPr: absence still means merged — a PR that closed outside the window must not reopen the part', () => {
  // The property that keeps this fix from being worse than the bug: the observed
  // signal *replaces* the inference only inside the retention window.
  const inReview = part({ status: 'in_review', prNumber: 42 });
  assert.deepEqual(observePartPr(inReview, 'issue/12/api', [], []), { status: 'merged' });
});

test('observePartPr: an abandoned PR does not yank the part back on every later pulse', () => {
  // A dead PR sits in the window for hours. Matching it by *branch* would re-ready
  // the part every cycle — including after it was re-dispatched — so the closed
  // reading is keyed on the number the part was actually tracking, and clearing
  // that number is what makes the transition fire once.
  const abandoned = pr(42, { state: 'closed', merged: false, branch: 'issue/12/api' });

  const readied = part({ status: 'ready', prNumber: null });
  assert.equal(observePartPr(readied, 'issue/12/api', [], [abandoned]), null, 'idempotent once readied');

  const redispatched = part({ status: 'dispatched', prNumber: null });
  assert.equal(observePartPr(redispatched, 'issue/12/api', [], [abandoned]), null, 'the retry is left alone');

  // ...and the retry's own PR is picked up normally.
  const retryPr = pr(51, { branch: 'issue/12/api' });
  assert.deepEqual(observePartPr(redispatched, 'issue/12/api', [retryPr], [abandoned]), {
    status: 'in_review',
    branch: 'issue/12/api',
    prNumber: 51,
  });
});

test('observePartPr: a merge is read off the branch, so a PR opened and merged between pulses still lands', () => {
  const dispatched = part({ status: 'dispatched', prNumber: null });
  const patch = observePartPr(
    dispatched,
    'issue/12/api',
    [],
    [
      pr(42, { state: 'closed', merged: false, branch: 'issue/12/api' }),
      pr(51, { state: 'merged', merged: true, branch: 'issue/12/api' }),
    ],
  );
  assert.deepEqual(patch, { status: 'merged', branch: 'issue/12/api', prNumber: 51 });
});

test('observePartPr: an open PR still wins over anything in the closed list', () => {
  const inReview = part({ status: 'in_review', prNumber: 51 });
  const patch = observePartPr(
    inReview,
    'issue/12/api',
    [pr(51, { branch: 'issue/12/api' })],
    [pr(42, { state: 'closed', merged: false, branch: 'issue/12/api' })],
  );
  assert.deepEqual(patch, { status: 'in_review', branch: 'issue/12/api', prNumber: 51 });
});

// ---------------------------------------------------------------------------
// End to end through the fake world
// ---------------------------------------------------------------------------

test('the fake world models a PR leaving the open set, and the diff calls it', async () => {
  const store = new Store(':memory:');
  const connector = new FakeConnector(store);
  connector.inject({ kind: 'new_pr', number: 42, title: 'Work', branch: 'feat/x' });
  connector.inject({ kind: 'new_pr', number: 43, title: 'Other', branch: 'feat/y' });
  const before = await connector.getState();

  connector.inject({ kind: 'pr_closed', prNumber: 42, merged: true });
  connector.inject({ kind: 'pr_closed', prNumber: 43, merged: false });
  const after = await connector.getState();

  assert.deepEqual(after.pullRequests, [], 'the row moves rather than being copied');
  assert.deepEqual(
    after.closedPullRequests?.map((p) => [p.number, p.state]),
    [
      [42, 'merged'],
      [43, 'closed'],
    ],
  );
  assert.deepEqual(
    diffWorlds(before, after).map((e) => e.kind),
    ['pr_merged', 'pr_closed'],
  );
});
