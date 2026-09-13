import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import {
  AzureDevOpsSourceControlIntegration,
  aggregatePolicyCiStatus,
} from '../src/integrations/azure/sourceControl.js';
import { policyDisplayAliases, policyDisplayName } from '../src/integrations/azure/restAzureDevOpsApi.js';
import { prHealth } from '../src/pr/prHealth.js';
import { prAttentionStatus, type PrAttentionContext } from '../src/pr/prAttention.js';
import { DEFAULT_COOLDOWN } from '../src/dispatcher/dispatchCooldown.js';
import type { AzPolicyEvaluation, AzPull, AzureDevOpsApi } from '../src/integrations/azure/azureDevOpsApi.js';
import type { CiPolicy } from '../src/ci/ciPolicy.js';
import type { PullRequest, WorldSnapshot } from '../src/types.js';
import { findTask } from './support/tasks.js';

const STATUS_POLICY = 'cbdc66da-9728-4af8-aada-9a5a32e4a226';
const BUILD_POLICY = '0609b952-1397-4640-95ec-e00a01b2c241';

const RAW_STATUS_EVALUATION = {
  status: 'queued',
  configuration: {
    isBlocking: true,
    isEnabled: true,
    type: { id: STATUS_POLICY, displayName: 'Status' },
    settings: {
      statusGenre: 'pr-agent-review',
      statusName: 'reviewed',
      defaultDisplayName: 'PR-Agent-Reviewed',
    },
  },
};

function evaluation(over: Partial<AzPolicyEvaluation> = {}): AzPolicyEvaluation {
  return {
    typeId: STATUS_POLICY,
    displayName: 'pr-agent-review/reviewed',
    displayAliases: ['PR-Agent-Reviewed'],
    typeName: 'Status',
    status: 'queued',
    isBlocking: true,
    isEnabled: true,
    ...over,
  };
}

function pull(over: Partial<AzPull> = {}): AzPull {
  return {
    pullRequestId: 31676,
    title: 'Add the thing',
    branch: 'feature/thing',
    baseBranch: 'Development',
    lastMergeSourceCommit: 'abc123',
    authorUniqueName: 'bot@example.com',
    authorDisplayName: '',
    url: 'https://dev.azure.com/o/p/_git/r/pullrequest/31676',
    isDraft: false,
    mergeStatus: 'succeeded',
    reviewers: [],
    ...over,
  };
}

function fakeApi(evals: AzPolicyEvaluation[], pulls: AzPull[] = [pull()]): AzureDevOpsApi {
  const unused = (name: string) => (): never => {
    throw new Error(`${name} is not scripted in this test`);
  };
  return {
    async viewerUniqueName() {
      return 'bot@example.com';
    },
    async listActivePullRequests() {
      return pulls;
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
    requeuePolicyEvaluation: unused('requeuePolicyEvaluation'),
    getBuildLog: unused('getBuildLog'),
  };
}

async function azurePullRequests(evals: AzPolicyEvaluation[], pulls?: AzPull[]): Promise<PullRequest[]> {
  const slice = await new AzureDevOpsSourceControlIntegration({ api: fakeApi(evals, pulls) }).snapshot();
  return slice.pullRequests ?? [];
}

const GATE: CiPolicy = {
  checks: [
    {
      match: 'pr-agent-review*',
      states: ['pending'],
      onFailure: 'dispatch',
      guidance: 'Run `/pr-agent-review` on this branch and wait for it to post its status.',
    },
  ],
};

function build(ci: CiPolicy, pullRequests: PullRequest[]): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-gate-'));
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
    { backend: new FakePtyBackend(), worktrees: new FakeWorktreeManager(dir), errorMirror: () => {} },
  );
  const world: WorldSnapshot = { takenAt: '2026-08-12T09:00:00.000Z', pullRequests, issues: [] };
  system.connector.getState = async () => world;
  return system;
}

test('a queued Azure status policy maps to a pending check, named and aliased', async () => {
  assert.equal(policyDisplayName(RAW_STATUS_EVALUATION), 'pr-agent-review/reviewed');
  assert.deepEqual(policyDisplayAliases(RAW_STATUS_EVALUATION), ['PR-Agent-Reviewed']);

  const [pr] = await azurePullRequests([evaluation()]);
  assert.deepEqual(pr?.ciChecks, [
    {
      name: 'pr-agent-review/reviewed',
      status: 'pending',
      blocking: true,
      aliases: ['PR-Agent-Reviewed'],
    },
  ]);
});

test('the aggregate and the health verdict do not move for a queued blocking policy', async () => {
  const [pr] = await azurePullRequests([evaluation()]);
  assert.equal(aggregatePolicyCiStatus([evaluation()]), 'pending');
  assert.equal(pr?.ciStatus, 'pending');
  assert.deepEqual(prHealth(pr!).reasons, [], 'a waiting gate is not a reason the PR is blocked');

  assert.equal(
    aggregatePolicyCiStatus([
      evaluation(),
      evaluation({ typeId: BUILD_POLICY, displayName: 'CI', status: 'approved' }),
    ]),
    'pending',
  );
});

test('the harness dispatches a code agent for the waiting gate, through buildSystem', async () => {
  const pullRequests = await azurePullRequests([evaluation()]);
  const system = build(GATE, pullRequests);
  await system.harness.runCycle('manual');

  const task = findTask(system.store, (t) => t.originRef === 'pr:31676:ci-gate');
  assert.ok(task, 'a gate task should exist on its own origin');
  assert.equal(task.branch, 'feature/thing');
  assert.match(task.prompt, /waiting, not failing/);
  assert.match(task.prompt, /pr-agent-review\/reviewed: Run `\/pr-agent-review` on this branch/);

  const decision = system.store.decisions
    .listDecisions()
    .find((d) => d.action.type === 'dispatch_code_agent' && d.action.originRef === 'pr:31676:ci-gate');
  assert.equal(decision?.rule, 'pr-ci-gate');
  system.store.close();
});

test('the same world with no rule dispatches nothing at all', async () => {
  const pullRequests = await azurePullRequests([evaluation()]);
  const system = build({ checks: [] }, pullRequests);
  await system.harness.runCycle('manual');

  assert.deepEqual(system.store.tasks.listTasks(), []);
  system.store.close();
});

test('an advisory-only red aggregate dispatches no code agent', async () => {
  const evals = [evaluation({ typeId: BUILD_POLICY, displayName: 'build', status: 'rejected' })];
  const slice = await new AzureDevOpsSourceControlIntegration({
    api: fakeApi(evals),
    policyChecks: { build: 'advisory' },
  }).snapshot();
  const pullRequests = slice.pullRequests ?? [];
  const [pr] = pullRequests;
  assert.equal(pr?.ciStatus, 'failing');
  assert.deepEqual(
    pr?.ciChecks?.map((c) => ({ name: c.name, status: c.status, advisory: c.advisory })),
    [{ name: 'build', status: 'failing', advisory: true }],
  );

  const system = build({ checks: [] }, pullRequests);
  await system.harness.runCycle('manual');

  assert.deepEqual(
    system.store.decisions.listDecisions().filter((d) => d.action.type === 'dispatch_code_agent'),
    [],
  );
  system.store.close();
});

test('a genuine non-advisory failure alongside an advisory one still dispatches', async () => {
  const evals = [
    evaluation({ typeId: BUILD_POLICY, displayName: 'build', status: 'rejected' }),
    evaluation({ typeId: STATUS_POLICY, displayName: 'lint/status', status: 'rejected' }),
  ];
  const slice = await new AzureDevOpsSourceControlIntegration({
    api: fakeApi(evals),
    policyChecks: { build: 'advisory' },
  }).snapshot();
  const pullRequests = slice.pullRequests ?? [];

  const system = build({ checks: [] }, pullRequests);
  await system.harness.runCycle('manual');

  const decision = system.store.decisions
    .listDecisions()
    .find((d) => d.action.type === 'dispatch_code_agent' && d.action.originRef === 'pr:31676:ci');
  assert.ok(decision, 'the non-advisory failure should still dispatch');
  const task = findTask(system.store, (t) => t.originRef === 'pr:31676:ci');
  assert.ok(task);
  assert.match(task.dispatchReason ?? '', /lint\/status/);
  assert.doesNotMatch(task.dispatchReason ?? '', /\bbuild\b/);
  system.store.close();
});

test('the lens agrees with the dispatcher: the gate is the harness’s court, not elsewhere', async () => {
  const [pr] = await azurePullRequests([evaluation()]);
  const ctx = (ci: CiPolicy): PrAttentionContext => ({
    openPrs: [pr!],
    defaultBranch: 'Development',
    watchLabel: '',
    tasks: [],
    proposals: [],
    recentDecisions: [],
    cooldown: DEFAULT_COOLDOWN,
    ci,
    now: '2026-08-12T09:00:00.000Z',
  });

  const watched = prAttentionStatus(pr!, ctx(GATE));
  assert.equal(watched.status, 'harness');
  assert.match(watched.reasons[0]!, /pr-agent-review\/reviewed waiting on an action — an agent will be dispatched/);

  const unwatched = prAttentionStatus(pr!, ctx({ checks: [] }));
  assert.equal(unwatched.status, 'elsewhere');
  assert.deepEqual(unwatched.reasons, ['CI is still running']);
});

test('the three policy modes are in order of decreasing effect, and `off` is the strongest', async () => {
  const evals = [evaluation({ typeId: BUILD_POLICY, displayName: 'CI build', status: 'rejected' })];
  const dispatchesFor = async (mode: 'check' | 'advisory' | 'off') => {
    const slice = await new AzureDevOpsSourceControlIntegration({
      api: fakeApi(evals),
      policyChecks: { build: mode },
    }).snapshot();
    const pullRequests = slice.pullRequests ?? [];
    const system = build({ checks: [] }, pullRequests);
    await system.harness.runCycle('manual');
    const named = system.store.decisions
      .listDecisions()
      .filter((d) => d.action.type === 'dispatch_code_agent')
      .map(() => findTask(system.store, (t) => t.originRef === 'pr:31676:ci')?.dispatchReason ?? '');
    const pr = pullRequests[0];
    system.store.close();
    return { pr, named };
  };

  const asCheck = await dispatchesFor('check');
  assert.equal(asCheck.named.length, 1, '`check` dispatches');
  assert.match(asCheck.named[0] ?? '', /CI build/, 'and names the check for the agent to look at');

  const asAdvisory = await dispatchesFor('advisory');
  assert.deepEqual(asAdvisory.named, [], '`advisory` does nothing');

  const asOff = await dispatchesFor('off');
  assert.equal(asOff.pr?.ciStatus, 'failing', 'no mode reaches the aggregate, so the PR is still red');
  assert.deepEqual(asOff.pr?.ciChecks, [], 'and the check is genuinely not emitted');
  assert.equal(asOff.pr?.ciChecksWithheld, true, 'what separates it from a provider that reported nothing');
  assert.deepEqual(asOff.named, [], '`off` does nothing either, which is what makes it the strongest');
});

test('an `off` kind beside a reported one withholds nothing', async () => {
  const slice = await new AzureDevOpsSourceControlIntegration({
    api: fakeApi([
      evaluation({ typeId: BUILD_POLICY, displayName: 'CI build', status: 'rejected' }),
      evaluation({ typeId: STATUS_POLICY, displayName: 'lint/status', status: 'rejected' }),
    ]),
    policyChecks: { build: 'off' },
  }).snapshot();
  const [pr] = slice.pullRequests ?? [];
  assert.deepEqual(
    pr?.ciChecks?.map((c) => c.name),
    ['lint/status'],
  );
  assert.equal(pr?.ciChecksWithheld, false);
});
