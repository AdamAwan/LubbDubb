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
} from '../src/integrations/azure/sourceControl.js';
import { policyDisplayAliases, policyDisplayName } from '../src/integrations/azure/restAzureDevOpsApi.js';
import { prHealth } from '../src/prHealth.js';
import { prAttentionStatus, type PrAttentionContext } from '../src/prAttention.js';
import { DEFAULT_COOLDOWN } from '../src/dispatcher/dispatchCooldown.js';
import type { AzPolicyEvaluation, AzPull, AzureDevOpsApi } from '../src/integrations/azure/azureDevOpsApi.js';
import type { CiPolicy } from '../src/ci/ciPolicy.js';
import type { PullRequest, WorldSnapshot } from '../src/types.js';

/**
 * The whole path for a check watched in a **non-failing** state, from the Azure
 * evaluation to the agent — the case that motivated `states` (PR 31676).
 *
 * A `pr-agent-review` **status** branch policy on `Development` is blocking,
 * enabled, and permanently `queued`: nothing is red, so no rule looked at it, and
 * the pull request sat "CI still running" until a human ran `/pr-agent-review` by
 * hand. What this file pins is that the rule now fires **and** that everything
 * downstream of `ciStatus` is exactly where it was — a waiting gate must never
 * read as a failure to `prHealth`, and must never stop a merge Azure would
 * complete.
 */

/** Azure's well-known GUIDs, transcribed rather than imported: the map is private to `policyKinds`. */
const STATUS_POLICY = 'cbdc66da-9728-4af8-aada-9a5a32e4a226';
const BUILD_POLICY = '0609b952-1397-4640-95ec-e00a01b2c241';

/** The raw shape Azure's `/policy/evaluations` returns for the status policy. */
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
    url: 'https://dev.azure.com/o/p/_git/r/pullrequest/31676',
    isDraft: false,
    mergeStatus: 'succeeded',
    reviewerVotes: [],
    ...over,
  };
}

/**
 * The slice of the provider seam this exercises. Everything else throws: a call
 * this test did not script is a change in what the snapshot reads, and should
 * fail loudly rather than return a benign empty.
 */
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

/** A whole system on fakes, with the Azure-derived world standing in for the connector's. */
function build(ci: CiPolicy, pullRequests: PullRequest[]): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-gate-'));
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
  // The fake connector has no way to carry per-check detail, and the point of the
  // test is that the *provider's own* mapping produces a dispatchable world — so
  // the snapshot the harness pulses on is the Azure one.
  const world: WorldSnapshot = { takenAt: '2026-08-12T09:00:00.000Z', pullRequests, issues: [] };
  system.connector.getState = async () => world;
  return system;
}

test('a queued Azure status policy maps to a pending check, named and aliased', async () => {
  // The mapping the rest of this file stands on, at the layer where Azure's JSON
  // becomes a `CiCheck`. `displayName` is the genre/name pair the harness keys on;
  // the label the PR page shows rides along as an alias so a glob written against
  // what an operator can see claims the same check.
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
  // `aggregatePolicyCiStatus` is frozen: a queued blocking policy is `pending`,
  // which is what it said before `states` existed and must keep saying. Anything
  // else would have `prHealth` claim the PR cannot merge, and stop the merge rule.
  assert.equal(aggregatePolicyCiStatus([evaluation()]), 'pending');
  assert.equal(pr?.ciStatus, 'pending');
  assert.deepEqual(prHealth(pr!).reasons, [], 'a waiting gate is not a reason the PR is blocked');

  // And an approved build alongside it still folds to the same answer: the gate
  // contributes `pending`, exactly as it always did.
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

  const task = system.store.listTasks().find((t) => t.originRef === 'pr:31676:ci-gate');
  assert.ok(task, 'a gate task should exist on its own origin');
  assert.equal(task.branch, 'feature/thing');
  assert.match(task.prompt, /waiting, not failing/);
  // The operator's guidance reached the agent, appended after the template.
  assert.match(task.prompt, /pr-agent-review\/reviewed: Run `\/pr-agent-review` on this branch/);

  // The dispatch is auditable as the gate rule's, not the red-build rule's.
  const decision = system.store
    .listDecisions()
    .find((d) => d.action.type === 'dispatch_code_agent' && d.action.originRef === 'pr:31676:ci-gate');
  assert.equal(decision?.rule, 'pr-ci-gate');
  system.store.close();
});

test('the same world with no rule dispatches nothing at all', async () => {
  // The control: everything above is the `states` rule doing it, not the pending
  // check being newly visible to something else.
  const pullRequests = await azurePullRequests([evaluation()]);
  const system = build({ checks: [] }, pullRequests);
  await system.harness.runCycle('manual');

  assert.deepEqual(system.store.listTasks(), []);
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

  // Without the rule it is what it always was: outside the loop, CI still running.
  const unwatched = prAttentionStatus(pr!, ctx({ checks: [] }));
  assert.equal(unwatched.status, 'elsewhere');
  assert.deepEqual(unwatched.reasons, ['CI is still running']);
});
