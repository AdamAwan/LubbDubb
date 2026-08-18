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
import {
  ciWatchNote,
  classifyCiFailures,
  classifyWatchedChecks,
  validateCiPolicy,
  type CiPolicy,
} from '../src/ci/ciPolicy.js';
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
 *
 * And the operator's way out, for a deployment where required builds expire on
 * every push: a `pending`-only `ignore` rule mutes the chase and leaves the same
 * check's genuine failures on the dispatching default. That combination used to be
 * refused at load on the grounds that nothing acts on a non-failing check — a
 * justification the expiry default itself made false.
 */

const BUILD_POLICY = '0609b952-1397-4640-95ec-e00a01b2c241';

function evaluation(over: Partial<AzPolicyEvaluation> = {}): AzPolicyEvaluation {
  return {
    typeId: BUILD_POLICY,
    displayName: 'Example-CI',
    typeName: 'Build',
    buildDefinitionName: 'Example-CI',
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
/** The same policy having actually run and failed — the side muting the expiry must not touch. */
const REJECTED = evaluation({ status: 'rejected' });

/**
 * The operator's lever for a check that expires on every push: mute the *waiting*
 * state and leave the failing one on the dispatching default. Pending-only, so the
 * `(glob, state)` match never claims the red build.
 */
const MUTE_EXPIRY: CiPolicy = { checks: [{ match: 'Example-*', states: ['pending'], onFailure: 'ignore' }] };

function pull(over: Partial<AzPull> = {}): AzPull {
  return {
    pullRequestId: 31702,
    title: 'Carry isExpired through',
    branch: 'feature/expiry',
    baseBranch: 'Development',
    lastMergeSourceCommit: 'abc123',
    authorUniqueName: 'bot@example.com',
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
      return 'bot@example.com';
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

/** A whole system on fakes, pulsing on the Azure-derived world. `ci.checks` is empty unless a policy is given. */
function build(pullRequests: PullRequest[], ci: CiPolicy = { checks: [] }): System {
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
      ci,
    }),
    { backend: new FakePtyBackend(), worktrees: new FakeWorktreeManager(dir), errorMirror: () => {} },
  );
  const world: WorldSnapshot = { takenAt: '2026-08-14T09:00:00.000Z', pullRequests, issues: [] };
  system.connector.getState = async () => world;
  return system;
}

test('an expired queued build maps to a pending check flagged expired; a running one does not', () => {
  assert.deepEqual(listPolicyCiChecks([EXPIRED]), [
    { name: 'Example-CI', status: 'pending', blocking: true, expired: true },
  ]);
  // The distinction Azure's `status` cannot make, and the reason the flag exists.
  assert.deepEqual(listPolicyCiChecks([RUNNING]), [{ name: 'Example-CI', status: 'pending', blocking: true }]);
  // A verdict is a verdict, whatever `isExpired` reads beside it: no flag once the
  // policy has resolved, or a settled check would read as one still waiting.
  assert.deepEqual(listPolicyCiChecks([evaluation({ status: 'approved', isExpired: true })]), [
    { name: 'Example-CI', status: 'passing', blocking: true },
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
    [{ name: 'Example-CI', rule: null, expired: true }],
  );
  // The control, and the reason `states: ["pending"]` on the build checks was the
  // wrong fix: it would claim this one too, and send an agent to release a gate
  // that was about to release itself.
  assert.deepEqual(classifyWatchedChecks(runningPr?.ciChecks, empty).watched, []);

  // The agent is told what an expired check needs, because no operator guidance
  // exists for a check nobody had to name.
  const note = ciWatchNote(verdict);
  assert.match(note, /expired, not running — Example-CI/);
  assert.match(note, /a new run has to be queued against the current head/);
});

test('an operator rule that does not dispatch still shadows the expiry default', async () => {
  const [pr] = await azurePullRequests([EXPIRED]);
  const muted: CiPolicy = { checks: [{ match: 'Example-*', states: ['failing', 'pending'], onFailure: 'ignore' }] };
  assert.deepEqual(classifyWatchedChecks(pr?.ciChecks, muted).watched, []);
});

test('a pending-only ignore rule mutes the expiry chase and is legal config', async () => {
  // The refusal this used to hit was justified by "nothing in the harness acts on a
  // check that is not failing" — which stopped being true when the expiry default
  // landed. The rule has a job now: shadowing that default.
  validateCiPolicy(MUTE_EXPIRY);

  const [pr] = await azurePullRequests([EXPIRED]);
  assert.deepEqual(classifyWatchedChecks(pr?.ciChecks, MUTE_EXPIRY).watched, []);
});

test('muting the expiry leaves the failing side of the same policy dispatching', async () => {
  // The whole reason a pending-only rule had to become legal. The shape the old
  // validation forced — `states: ["failing", "pending"]` with `ignore` — would put
  // this build in `ignored` instead, giving up agent auto-fix on genuine failures.
  const [pr] = await azurePullRequests([REJECTED]);
  assert.equal(pr?.ciStatus, 'failing');

  const verdict = classifyCiFailures(pr?.ciChecks, MUTE_EXPIRY);
  assert.deepEqual(
    verdict.dispatch.map((m) => ({ name: m.name, rule: m.rule })),
    [{ name: 'Example-CI', rule: null }],
    'the pending-only rule does not claim the red build, so it falls through to the dispatching default',
  );
  assert.deepEqual(verdict.ignored, []);
  assert.equal(verdict.actionable, true);
});

test('escalate on a pending-only rule is still refused, and says why', () => {
  assert.throws(
    () => validateCiPolicy({ checks: [{ match: 'Example-*', states: ['pending'], onFailure: 'escalate' }] }),
    /no escalation arm for a check that is merely waiting/,
  );
});

test('the harness dispatches a gate agent for the expired build, through buildSystem', async () => {
  const system = build(await azurePullRequests([EXPIRED]));
  await system.harness.runCycle('manual');

  const task = system.store.listTasks().find((t) => t.originRef === 'pr:31702:ci-gate');
  assert.ok(task, 'the expired build should be claimed on the gate origin');
  assert.equal(task.branch, 'feature/expiry');
  assert.match(task.prompt, /waiting, not failing/);
  assert.match(task.prompt, /expired, not running — Example-CI/);

  const decision = system.store
    .listDecisions()
    .find((d) => d.action.type === 'dispatch_code_agent' && d.action.originRef === 'pr:31702:ci-gate');
  assert.equal(decision?.rule, 'pr-ci-gate');
  system.store.close();
});

test('with the expiry muted, the same world dispatches no gate agent', async () => {
  const system = build(await azurePullRequests([EXPIRED]), MUTE_EXPIRY);
  await system.harness.runCycle('manual');

  assert.equal(
    system.store.listTasks().find((t) => t.originRef === 'pr:31702:ci-gate'),
    undefined,
    'the muted expiry must not reach rule `pr-ci-gate`',
  );
  assert.deepEqual(system.store.listTasks(), []);
  assert.equal(
    system.store.listDecisions().find((d) => d.action.type === 'dispatch_code_agent'),
    undefined,
  );
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
    watchLabel: '',
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
  assert.match(expired.reasons[0]!, /Example-CI waiting on an action/);

  // A build that is genuinely running is what it always was: outside the loop.
  const [runningPr] = await azurePullRequests([RUNNING]);
  const running = prAttentionStatus(runningPr!, ctx(runningPr!));
  assert.equal(running.status, 'elsewhere');
  assert.deepEqual(running.reasons, ['CI is still running']);
});
