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
import type { ActionSink } from '../src/sink/actionSink.js';
import type { PullRequest, WorldSnapshot } from '../src/types.js';
import { findTask } from './support/tasks.js';

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
    evaluationId: 'eval-31702-ci',
    ...over,
  };
}

const EXPIRED = evaluation({ isExpired: true });
const RUNNING = evaluation({ status: 'running' });
const REJECTED = evaluation({ status: 'rejected' });
const UNADDRESSABLE = evaluation({ isExpired: true, evaluationId: undefined });

const MUTE_EXPIRY: CiPolicy = { checks: [{ match: 'Example-*', states: ['pending'], onFailure: 'ignore' }] };

function pull(over: Partial<AzPull> = {}): AzPull {
  return {
    pullRequestId: 31702,
    title: 'Carry isExpired through',
    branch: 'feature/expiry',
    baseBranch: 'Development',
    lastMergeSourceCommit: 'abc123',
    authorUniqueName: 'bot@example.com',
    authorDisplayName: '',
    url: 'https://dev.azure.com/o/p/_git/r/pullrequest/31702',
    isDraft: false,
    mergeStatus: 'succeeded',
    reviewers: [],
    ...over,
  };
}

interface RequeueScript {
  asked: string[];
  answer?: 'requeued' | 'refuse' | 'throw';
}

function fakeApi(evals: AzPolicyEvaluation[], requeue: RequeueScript = { asked: [] }): AzureDevOpsApi {
  const unused = (name: string) => (): never => {
    throw new Error(`${name} is not scripted in this test`);
  };
  return {
    async requeuePolicyEvaluation(evaluationId) {
      requeue.asked.push(evaluationId);
      if (requeue.answer === 'throw') throw new Error('403 Forbidden (PAT lacks Build execute)');
      if (requeue.answer === 'refuse') return { status: 'queued', isExpired: true };
      return { status: 'queued', isExpired: false };
    },
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
    async setThreadStatus() {},
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
    createWorkItem: unused('createWorkItem'),
    relateWorkItem: unused('relateWorkItem'),
    listAreaPaths: () => Promise.resolve({ root: 'Contoso', paths: [] }),
    setWorkItemParent: () => Promise.reject(new Error('not used')),
    setWorkItemAreaPath: () => Promise.reject(new Error('not used')),
    setWorkItemTag: unused('setWorkItemTag'),
    linkWorkItemToPull: unused('linkWorkItemToPull'),
    createWorkItemComment: unused('createWorkItemComment'),
    updateWorkItemComment: unused('updateWorkItemComment'),
    createPull: unused('createPull'),
    setPullTitle: unused('setPullTitle'),
    setPullBase: unused('setPullBase'),
    abandonPullRequest: unused('abandonPullRequest'),
    deleteBranch: unused('deleteBranch'),
    getBuildTimeline: unused('getBuildTimeline'),
    getBuildLog: unused('getBuildLog'),
  };
}

async function azurePullRequests(evals: AzPolicyEvaluation[]): Promise<PullRequest[]> {
  const slice = await new AzureDevOpsSourceControlIntegration({ api: fakeApi(evals) }).snapshot();
  return slice.pullRequests ?? [];
}

function azureSink(evals: AzPolicyEvaluation[], requeue: RequeueScript): ActionSink {
  const integration = new AzureDevOpsSourceControlIntegration({ api: fakeApi(evals, requeue) });
  const unused = (name: string) => (): never => {
    throw new Error(`${name} is not scripted in this test`);
  };
  return {
    canCloseIssue: () => false,
    canClosePr: () => false,
    closePr: (): never => {
      throw new Error('closePr is not scripted in this test');
    },
    canResolvePrThread: () => false,
    resolvePrThread: (): never => {
      throw new Error('resolvePrThread is not scripted in this test');
    },
    closeIssue: (): never => {
      throw new Error('closeIssue is not scripted in this test');
    },
    canSetWorkItemState: () => false,
    canPlaceWorkItem: () => false,
    setWorkItemParent: () => Promise.reject(new Error('not used')),
    setWorkItemAreaPath: () => Promise.reject(new Error('not used')),
    requeueCiCheck: (input) => integration.requeueCiCheck(input),
    createIssue: unused('createIssue'),
    postPrReply: unused('postPrReply'),
    mergePr: unused('mergePr'),
    setPrLabel: unused('setPrLabel'),
    setIssueLabel: unused('setIssueLabel'),
    setWorkItemState: unused('setWorkItemState'),
    upsertIssueComment: unused('upsertIssueComment'),
    linkWorkItem: unused('linkWorkItem'),
    createPullRequest: unused('createPullRequest'),
    setPullTitle: unused('setPullTitle'),
    setPullBase: unused('setPullBase'),
    updatePrBranch: unused('updatePrBranch'),
    deleteBranch: unused('deleteBranch'),
  };
}

function build(pullRequests: PullRequest[], ci: CiPolicy = { checks: [] }, sink?: ActionSink): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-expired-'));
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      defaultBranch: 'Development',
      ci,
    }),
    {
      backend: new FakePtyBackend(),
      worktrees: new FakeWorktreeManager(dir),
      errorMirror: () => {},
      ...(sink ? { sink } : {}),
    },
  );
  const world: WorldSnapshot = { takenAt: '2026-08-14T09:00:00.000Z', pullRequests, issues: [] };
  system.connector.getState = async () => world;
  return system;
}

test('an expired queued build maps to a pending check flagged expired; a running one does not', () => {
  assert.deepEqual(listPolicyCiChecks([EXPIRED]), [
    { name: 'Example-CI', status: 'pending', blocking: true, expired: true, requeueRef: 'eval-31702-ci' },
  ]);
  assert.deepEqual(listPolicyCiChecks([UNADDRESSABLE]), [
    { name: 'Example-CI', status: 'pending', blocking: true, expired: true },
  ]);
  assert.deepEqual(listPolicyCiChecks([RUNNING]), [{ name: 'Example-CI', status: 'pending', blocking: true }]);
  assert.deepEqual(listPolicyCiChecks([evaluation({ status: 'approved', isExpired: true })]), [
    { name: 'Example-CI', status: 'passing', blocking: true },
  ]);
});

test('the aggregate and the health verdict do not move for an expired build', async () => {
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
  assert.deepEqual(classifyWatchedChecks(runningPr?.ciChecks, empty).watched, []);

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
  validateCiPolicy(MUTE_EXPIRY);

  const [pr] = await azurePullRequests([EXPIRED]);
  assert.deepEqual(classifyWatchedChecks(pr?.ciChecks, MUTE_EXPIRY).watched, []);
});

test('muting the expiry leaves the failing side of the same policy dispatching', async () => {
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

test('the harness clears the expired build with one write and no agent, through buildSystem', async () => {
  const requeue: RequeueScript = { asked: [] };
  const system = build(await azurePullRequests([EXPIRED]), { checks: [] }, azureSink([EXPIRED], requeue));
  await system.harness.runCycle('manual');

  assert.deepEqual(system.store.tasks.listTasks(), [], 'no agent is spent on a gate whose cause is known');
  assert.deepEqual(requeue.asked, ['eval-31702-ci']);

  const decision = system.store.decisions
    .listDecisions()
    .find((d) => d.action.type === 'requeue_ci_check' && d.action.originRef === 'pr:31702:ci-gate');
  assert.equal(decision?.outcome, 'executed');
  assert.equal(decision?.rule, 'pr-ci-gate');
  assert.match(decision!.detail ?? '', /Example-CI/);
  system.store.close();
});

test('a requeue the provider will not perform falls back to the dispatch it always was', async () => {
  const requeue: RequeueScript = { asked: [], answer: 'refuse' };
  const system = build(await azurePullRequests([EXPIRED]), { checks: [] }, azureSink([EXPIRED], requeue));
  await system.harness.runCycle('manual');

  assert.deepEqual(requeue.asked, ['eval-31702-ci']);
  assert.deepEqual(system.store.tasks.listTasks(), [], 'the write is tried before the agent, not beside it');
  const refused = system.store.decisions.listDecisions().find((d) => d.action.type === 'requeue_ci_check');
  assert.equal(refused?.outcome, 'skipped', 'a provider that would not do it is a configuration, not an error');

  await system.harness.runCycle('manual');
  const task = findTask(system.store, (t) => t.originRef === 'pr:31702:ci-gate');
  assert.ok(task, 'the gate is never left waiting because the cheap path was unavailable');
  assert.equal(task.branch, 'feature/expiry');
  assert.match(task.prompt, /waiting, not failing/);
  assert.match(task.prompt, /expired, not running — Example-CI/);
  assert.equal(requeue.asked.length, 1, 'and the refused write is not tried again while the row stands');
  system.store.close();
});

test('a requeue that fails is recorded as an error and falls back the same way', async () => {
  const requeue: RequeueScript = { asked: [], answer: 'throw' };
  const errors: string[] = [];
  const system = build(await azurePullRequests([EXPIRED]), { checks: [] }, azureSink([EXPIRED], requeue));
  system.errors.on('logged', (e) => errors.push(e.message));
  await system.harness.runCycle('manual');

  const rejected = system.store.decisions.listDecisions().find((d) => d.action.type === 'requeue_ci_check');
  assert.equal(rejected?.outcome, 'rejected');
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /Requeueing the expired check\(s\) on PR #31702 failed/);

  await system.harness.runCycle('manual');
  assert.ok(system.store.tasks.listTasks().find((t) => t.originRef === 'pr:31702:ci-gate'));
  system.store.close();
});

test('an expired evaluation with nothing to address keeps its agent', async () => {
  const requeue: RequeueScript = { asked: [] };
  const system = build(await azurePullRequests([UNADDRESSABLE]), { checks: [] }, azureSink([UNADDRESSABLE], requeue));
  await system.harness.runCycle('manual');

  const task = findTask(system.store, (t) => t.originRef === 'pr:31702:ci-gate');
  assert.ok(task, 'the expired build should be claimed on the gate origin');
  assert.equal(task.branch, 'feature/expiry');
  assert.match(task.prompt, /expired, not running — Example-CI/);
  assert.deepEqual(requeue.asked, []);
  system.store.close();
});

test('a check that is both expired and guided keeps its agent — the operator outranks the known cause', async () => {
  const guided: CiPolicy = {
    checks: [{ match: 'Example-*', states: ['pending'], onFailure: 'dispatch', guidance: 'Ask #build-eng to run it.' }],
  };
  const requeue: RequeueScript = { asked: [] };
  const system = build(await azurePullRequests([EXPIRED]), guided, azureSink([EXPIRED], requeue));
  await system.harness.runCycle('manual');

  const task = findTask(system.store, (t) => t.originRef === 'pr:31702:ci-gate');
  assert.ok(task, 'guidance keeps the gate on an agent');
  assert.match(task.prompt, /Ask #build-eng to run it\./);
  assert.deepEqual(requeue.asked, [], 'and nothing is queued behind the operator’s back');
  system.store.close();
});

test('with the expiry muted, the same world dispatches no gate agent', async () => {
  const system = build(await azurePullRequests([EXPIRED]), MUTE_EXPIRY);
  await system.harness.runCycle('manual');

  assert.equal(
    system.store.tasks.listTasks().find((t) => t.originRef === 'pr:31702:ci-gate'),
    undefined,
    'the muted expiry must not reach rule `pr-ci-gate`',
  );
  assert.deepEqual(system.store.tasks.listTasks(), []);
  assert.equal(
    system.store.decisions.listDecisions().find((d) => d.action.type === 'dispatch_code_agent'),
    undefined,
  );
  system.store.close();
});

test('the same world with the build merely running dispatches nothing', async () => {
  const system = build(await azurePullRequests([RUNNING]));
  await system.harness.runCycle('manual');

  assert.deepEqual(system.store.tasks.listTasks(), []);
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

  const [runningPr] = await azurePullRequests([RUNNING]);
  const running = prAttentionStatus(runningPr!, ctx(runningPr!));
  assert.equal(running.status, 'elsewhere');
  assert.deepEqual(running.reasons, ['CI is still running']);
});
