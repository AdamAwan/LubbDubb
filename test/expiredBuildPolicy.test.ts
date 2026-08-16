import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import {
  AzureDevOpsSourceControlIntegration,
  aggregatePolicyCiStatus,
  listPolicyCiChecks,
} from '../src/integrations/azure/sourceControl.js';
import { ciWatchNote, classifyWatchedChecks, type CiPolicy } from '../src/ci/ciPolicy.js';
import { prHealth } from '../src/prHealth.js';
import { prAttentionStatus, type PrAttentionContext } from '../src/prAttention.js';
import { DEFAULT_COOLDOWN } from '../src/dispatcher/dispatchCooldown.js';
import type { AzPolicyEvaluation, AzPull, AzureDevOpsApi } from '../src/integrations/azure/azureDevOpsApi.js';
import type { PullRequest, WorldSnapshot } from '../src/types.js';

/**
 * An **expired** Azure build-validation policy, from the evaluation to the agent.
 *
 * A branch that receives commits after its last policy build leaves the
 * evaluation `status: "queued"` with `context.isExpired` — a build that has to be
 * queued or the policy never resolves. Azure reports a build that is genuinely
 * running with the same `status`, so the harness folded both onto `pending`,
 * `ciNeedsAttention` was false, no rule claimed the PR, and `prAttentionStatus`
 * read "CI is still running" for as long as anyone left it (fourteen hours, on
 * the deployment this came from).
 *
 * What this pins: the expired one is watched with **no `ci.checks` rule** while
 * the running one is not, and nothing downstream of `ciStatus` moves for either —
 * a build that has not run is not a failing build, and must never claim the pull
 * request cannot merge.
 */

const BUILD_POLICY = '0609b952-1397-4640-95ec-e00a01b2c241';

function evaluation(over: Partial<AzPolicyEvaluation> = {}): AzPolicyEvaluation {
  return {
    typeId: BUILD_POLICY,
    displayName: 'NXG-CI',
    typeName: 'Build',
    buildDefinitionName: 'NXG-CI',
    status: 'queued',
    isBlocking: true,
    isEnabled: true,
    ...over,
  };
}

/** The evaluation as it comes back for a branch pushed to since its last build. */
const EXPIRED = evaluation({ isExpired: true });
/** The same policy with a build genuinely in flight — one word apart, and the whole point. */
const RUNNING = evaluation({ status: 'running' });

function pull(over: Partial<AzPull> = {}): AzPull {
  return {
    pullRequestId: 31702,
    title: 'Carry isExpired through',
    branch: 'feature/expiry',
    baseBranch: 'Development',
    lastMergeSourceCommit: 'abc123',
    authorUniqueName: 'bot@nxg.example',
    url: 'https://dev.azure.com/o/p/_git/r/pullrequest/31702',
    isDraft: false,
    mergeStatus: 'succeeded',
    reviewerVotes: [],
    ...over,
  };
}

/** The slice of the provider seam this exercises; anything unscripted throws rather than returning empty. */
function fakeApi(evals: AzPolicyEvaluation[]): AzureDevOpsApi {
  const unused = (name: string) => (): never => {
    throw new Error(`${name} is not scripted in this test`);
  };
  return {
    async viewerUniqueName() {
      return 'bot@nxg.example';
    },
    async listActivePullRequests() {
      return [pull()];
    },
    async listRecentlyClosedPullRequests() {
      return [];
    },
    async listPullThreads() {
      return [];
    },
    async listPolicyEvaluations() {
      return evals;
    },
    async listPullLabels() {
      return [];
    },
    listOpenWorkItems: unused('listOpenWorkItems'),
    listWorkItemsChangedSince: unused('listWorkItemsChangedSince'),
    getWorkItems: unused('getWorkItems'),
    listWorkItemUpdates: unused('listWorkItemUpdates'),
    createThreadReply: unused('createThreadReply'),
    createThread: unused('createThread'),
    completePullRequest: unused('completePullRequest'),
    setPullLabel: unused('setPullLabel'),
    setWorkItemState: unused('setWorkItemState'),
    setWorkItemTag: unused('setWorkItemTag'),
    createWorkItemComment: unused('createWorkItemComment'),
    updateWorkItemComment: unused('updateWorkItemComment'),
    createPull: unused('createPull'),
    setPullTitle: unused('setPullTitle'),
    setPullBase: unused('setPullBase'),
    deleteBranch: unused('deleteBranch'),
    getBuildTimeline: unused('getBuildTimeline'),
    getBuildLog: unused('getBuildLog'),
  };
}

/** The world the Azure provider maps from those evaluations — never a hand-written PR. */
async function azurePullRequests(evals: AzPolicyEvaluation[]): Promise<PullRequest[]> {
  const slice = await new AzureDevOpsSourceControlIntegration({ api: fakeApi(evals) }).snapshot();
  return slice.pullRequests ?? [];
}

/** A whole system on fakes, pulsing on the Azure-derived world. `ci.checks` is empty throughout. */
function build(pullRequests: PullRequest[]): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-expired-'));
  const system = buildSystem(
    loadConfig({
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      defaultBranch: 'Development',
      ci: { checks: [] },
    }),
    { backend: new FakePtyBackend(), worktrees: new FakeWorktreeManager(dir), errorMirror: () => {} },
  );
  const world: WorldSnapshot = { takenAt: '2026-08-14T09:00:00.000Z', pullRequests, issues: [] };
  system.connector.getState = async () => world;
  return system;
}

test('an expired queued build maps to a pending check flagged expired; a running one does not', () => {
  assert.deepEqual(listPolicyCiChecks([EXPIRED]), [
    { name: 'NXG-CI', status: 'pending', blocking: true, expired: true },
  ]);
  // The distinction Azure's `status` cannot make, and the reason the flag exists.
  assert.deepEqual(listPolicyCiChecks([RUNNING]), [{ name: 'NXG-CI', status: 'pending', blocking: true }]);
  // A verdict is a verdict, whatever `isExpired` reads beside it: no flag once the
  // policy has resolved, or a settled check would read as one still waiting.
  assert.deepEqual(listPolicyCiChecks([evaluation({ status: 'approved', isExpired: true })]), [
    { name: 'NXG-CI', status: 'passing', blocking: true },
  ]);
});

test('the aggregate and the health verdict do not move for an expired build', async () => {
  // `aggregatePolicyCiStatus` is frozen. An expired build is not a failing build:
  // saying so would have `prHealth` claim the PR cannot merge over a build that
  // has not run, and would stop the merge rule completing a PR Azure would.
  assert.equal(aggregatePolicyCiStatus([EXPIRED]), 'pending');
  const [pr] = await azurePullRequests([EXPIRED]);
  assert.equal(pr?.ciStatus, 'pending');
  assert.deepEqual(prHealth(pr!).reasons, [], 'an expired build is not a reason the PR is blocked');
});

test('an expired check is watched with no rule; a running one is not', async () => {
  const empty: CiPolicy = { checks: [] };
  const [expiredPr] = await azurePullRequests([EXPIRED]);
  const [runningPr] = await azurePullRequests([RUNNING]);

  const verdict = classifyWatchedChecks(expiredPr?.ciChecks, empty);
  assert.deepEqual(
    verdict.watched.map((m) => ({ name: m.name, rule: m.rule, expired: m.expired })),
    [{ name: 'NXG-CI', rule: null, expired: true }],
  );
  // The control, and the reason `states: ["pending"]` on the build checks was the
  // wrong fix: it would claim this one too, and send an agent to release a gate
  // that was about to release itself.
  assert.deepEqual(classifyWatchedChecks(runningPr?.ciChecks, empty).watched, []);

  // The agent is told what an expired check needs, because no operator guidance
  // exists for a check nobody had to name.
  const note = ciWatchNote(verdict);
  assert.match(note, /expired, not running — NXG-CI/);
  assert.match(note, /a new run has to be queued against the current head/);
});

test('an operator rule that does not dispatch still shadows the expiry default', async () => {
  const [pr] = await azurePullRequests([EXPIRED]);
  const muted: CiPolicy = { checks: [{ match: 'NXG-*', states: ['failing', 'pending'], onFailure: 'ignore' }] };
  assert.deepEqual(classifyWatchedChecks(pr?.ciChecks, muted).watched, []);
});

test('the harness dispatches a gate agent for the expired build, through buildSystem', async () => {
  const system = build(await azurePullRequests([EXPIRED]));
  await system.harness.runCycle('manual');

  const task = system.store.listTasks().find((t) => t.originRef === 'pr:31702:ci-gate');
  assert.ok(task, 'the expired build should be claimed on the gate origin');
  assert.equal(task.branch, 'feature/expiry');
  assert.match(task.prompt, /waiting, not failing/);
  assert.match(task.prompt, /expired, not running — NXG-CI/);

  const decision = system.store
    .listDecisions()
    .find((d) => d.action.type === 'dispatch_code_agent' && d.action.originRef === 'pr:31702:ci-gate');
  assert.equal(decision?.rule, 'pr-ci-gate');
  system.store.close();
});

test('the same world with the build merely running dispatches nothing', async () => {
  const system = build(await azurePullRequests([RUNNING]));
  await system.harness.runCycle('manual');

  assert.deepEqual(system.store.listTasks(), []);
  system.store.close();
});

test('the lens agrees with the dispatcher: an expired build is the harness’s court', async () => {
  const ctx = (pr: PullRequest): PrAttentionContext => ({
    openPrs: [pr],
    defaultBranch: 'Development',
    ignoreLabel: '',
    tasks: [],
    proposals: [],
    recentDecisions: [],
    cooldown: DEFAULT_COOLDOWN,
    ci: { checks: [] },
    now: '2026-08-14T09:00:00.000Z',
  });

  const [expiredPr] = await azurePullRequests([EXPIRED]);
  const expired = prAttentionStatus(expiredPr!, ctx(expiredPr!));
  assert.equal(expired.status, 'harness');
  assert.match(expired.reasons[0]!, /NXG-CI waiting on an action/);

  // A build that is genuinely running is what it always was: outside the loop.
  const [runningPr] = await azurePullRequests([RUNNING]);
  const running = prAttentionStatus(runningPr!, ctx(runningPr!));
  assert.equal(running.status, 'elsewhere');
  assert.deepEqual(running.reasons, ['CI is still running']);
});
