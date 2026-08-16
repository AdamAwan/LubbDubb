import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { GitHubSourceControlIntegration } from '../src/integrations/github/sourceControl.js';
import { AzureDevOpsSourceControlIntegration } from '../src/integrations/azure/sourceControl.js';
import { ciEvidenceNote, type CiFailureEvidence } from '../src/ci/ciEvidence.js';
import type { GhAnnotation, GhCheckRun, GitHubApi } from '../src/integrations/github/githubApi.js';
import type {
  AzPolicyEvaluation,
  AzPull,
  AzTimelineRecord,
  AzureDevOpsApi,
} from '../src/integrations/azure/azureDevOpsApi.js';
import type { ErrorRecorder } from '../src/errorLog.js';
import type { PullRequest, WorldSnapshot } from '../src/types.js';

/**
 * Evidence on a CI-fix dispatch (issue #334): the agent is handed what broke,
 * not only the name of the check that broke.
 *
 * The three things worth pinning are the three ways this can go wrong silently.
 * A dispatch that carries the failing assertion is the feature; a dispatch whose
 * log fetch **failed** must be byte-identical to the one composed before this
 * existed, or a provider outage quietly degrades every CI agent; and the cap
 * must say what it dropped, or an agent reads a trimmed log as a whole one and
 * concludes from an absence that was manufactured here.
 *
 * The world is built by the **real provider integrations** over scripted `*Api`
 * fakes rather than hand-written, because half of what is under test is the
 * mapping — a check run that carries no evidence ref produces no excerpt however
 * well the rest of the path works.
 */

const BUILD_POLICY = '0609b952-1397-4640-95ec-e00a01b2c241';

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

interface GhScript {
  checkRuns?: GhCheckRun[];
  annotations?: Record<number, GhAnnotation[]>;
  jobLogs?: Record<number, string>;
  throwOn?: 'annotations' | 'jobLog';
}

function ghApi(script: GhScript): GitHubApi {
  const unused = (name: string) => (): never => {
    throw new Error(`${name} is not scripted in this test`);
  };
  return {
    async viewerLogin() {
      return 'bot';
    },
    async listOpenPulls() {
      return [
        {
          number: 42,
          title: 'Add the thing',
          branch: 'feature/thing',
          baseBranch: 'main',
          headSha: 'sha42',
          authorLogin: 'bot',
          url: 'https://github.com/o/r/pull/42',
          labels: [],
        },
      ];
    },
    async getPull() {
      return { mergeable: true, mergeableState: 'clean', merged: false };
    },
    async listPullReviews() {
      return [];
    },
    async listPullReviewComments() {
      return [];
    },
    async listPullReviewThreads() {
      return [];
    },
    async getCombinedStatus() {
      return { state: '', totalCount: 0 };
    },
    async listCheckRuns() {
      return script.checkRuns ?? [];
    },
    async listCheckRunAnnotations(checkRunId) {
      if (script.throwOn === 'annotations') throw new Error('403 Forbidden (no actions:read)');
      return script.annotations?.[checkRunId] ?? [];
    },
    async getJobLog(jobId) {
      if (script.throwOn === 'jobLog') throw new Error('log expired out of retention');
      return script.jobLogs?.[jobId] ?? '';
    },
    listRecentlyClosedPulls: unused('listRecentlyClosedPulls'),
    listOpenIssues: unused('listOpenIssues'),
    listIssuesChangedSince: unused('listIssuesChangedSince'),
    listIssueTimeline: unused('listIssueTimeline'),
    createPullReviewReply: unused('createPullReviewReply'),
    createIssueComment: unused('createIssueComment'),
    updateIssueComment: unused('updateIssueComment'),
    mergePull: unused('mergePull'),
    setPullLabel: unused('setPullLabel'),
    setIssueLabel: unused('setIssueLabel'),
    createPull: unused('createPull'),
    setPullTitle: unused('setPullTitle'),
    setPullBase: unused('setPullBase'),
    updatePullBranch: unused('updatePullBranch'),
    deleteBranch: unused('deleteBranch'),
  };
}

/** A failing Actions check run, with the `/job/<id>` detail URL its log hangs off. */
function failingRun(over: Partial<GhCheckRun> = {}): GhCheckRun {
  return {
    name: 'test',
    status: 'completed',
    conclusion: 'failure',
    id: 900,
    detailsUrl: 'https://github.com/o/r/actions/runs/5/job/9001',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Azure
// ---------------------------------------------------------------------------

interface AzScript {
  timeline?: Record<number, AzTimelineRecord[]>;
  buildLogs?: Record<string, string[]>;
  throwOn?: 'timeline';
}

function azApi(script: AzScript): AzureDevOpsApi {
  const unused = (name: string) => (): never => {
    throw new Error(`${name} is not scripted in this test`);
  };
  const pull: AzPull = {
    pullRequestId: 42,
    title: 'Add the thing',
    branch: 'feature/thing',
    baseBranch: 'main',
    lastMergeSourceCommit: 'abc123',
    authorUniqueName: 'bot@acme.com',
    url: 'https://dev.azure.com/o/p/_git/r/pullrequest/42',
    isDraft: false,
    mergeStatus: 'succeeded',
    reviewerVotes: [],
  };
  const evaluation: AzPolicyEvaluation = {
    typeId: BUILD_POLICY,
    displayName: 'CI',
    typeName: 'Build',
    status: 'rejected',
    isBlocking: true,
    isEnabled: true,
    buildId: 7788,
  };
  return {
    async viewerUniqueName() {
      return 'bot@acme.com';
    },
    async listActivePullRequests() {
      return [pull];
    },
    async listPullThreads() {
      return [];
    },
    async listPolicyEvaluations() {
      return [evaluation];
    },
    async listPullLabels() {
      return [];
    },
    async getBuildTimeline(buildId) {
      if (script.throwOn === 'timeline') throw new Error('403 Forbidden (PAT lacks Build read)');
      return script.timeline?.[buildId] ?? [];
    },
    async getBuildLog(buildId, logId) {
      return script.buildLogs?.[`${buildId}/${logId}`] ?? [];
    },
    listRecentlyClosedPullRequests: unused('listRecentlyClosedPullRequests'),
    listOpenWorkItems: unused('listOpenWorkItems'),
    listWorkItemsChangedSince: unused('listWorkItemsChangedSince'),
    getWorkItems: unused('getWorkItems'),
    listWorkItemUpdates: unused('listWorkItemUpdates'),
    createThreadReply: unused('createThreadReply'),
    createThread: unused('createThread'),
    completePullRequest: unused('completePullRequest'),
    setPullLabel: unused('setPullLabel'),
    setWorkItemState: unused('setWorkItemState'),
    createWorkItemComment: unused('createWorkItemComment'),
    updateWorkItemComment: unused('updateWorkItemComment'),
    setWorkItemTag: unused('setWorkItemTag'),
    createPull: unused('createPull'),
    setPullTitle: unused('setPullTitle'),
    setPullBase: unused('setPullBase'),
    deleteBranch: unused('deleteBranch'),
  };
}

/** A timeline task record — the structured half of Azure's evidence. */
function taskRecord(over: Partial<AzTimelineRecord> = {}): AzTimelineRecord {
  return { type: 'Task', name: 'Run tests', result: 'failed', logId: 12, issues: [], ...over };
}

// ---------------------------------------------------------------------------
// The system, pulsed on a world the real provider mapped
// ---------------------------------------------------------------------------

async function build(
  make: (errors: ErrorRecorder) => GitHubSourceControlIntegration | AzureDevOpsSourceControlIntegration,
): Promise<{ system: System; pullRequests: PullRequest[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-evidence-'));
  // The integration needs the system's error log, and the system needs the
  // integration — so the reader handed to `buildSystem` delegates, and is bound
  // by the time a pulse can reach it. Production has no such knot: the registry
  // builds the integration with `ctx.errors` before the executor exists.
  let integration: GitHubSourceControlIntegration | AzureDevOpsSourceControlIntegration | null = null;
  const system = buildSystem(
    loadConfig({
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      defaultBranch: 'main',
    }),
    {
      backend: new FakePtyBackend(),
      worktrees: new FakeWorktreeManager(dir),
      errorMirror: () => {},
      // The same integration that mapped the world answers for its evidence —
      // which is the pairing production has, since both are the one provider.
      ciEvidence: { readCiFailureEvidence: (n, c) => integration!.readCiFailureEvidence(n, c) },
    },
  );
  integration = make(system.errors);
  const slice = await integration.snapshot();
  const pullRequests = slice.pullRequests ?? [];
  const world: WorldSnapshot = { takenAt: '2026-08-15T09:00:00.000Z', pullRequests, issues: [] };
  system.connector.getState = async () => world;
  return { system, pullRequests };
}

/** The CI-fix task the pulse dispatched for PR 42, or undefined. */
function ciTask(system: System) {
  return system.store.listTasks().find((t) => t.originRef === 'pr:42:ci');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('a GitHub CI-fix dispatch carries the check run annotations', async () => {
  const api = ghApi({
    checkRuns: [failingRun()],
    annotations: {
      900: [
        {
          path: 'src/thing.ts',
          startLine: 12,
          level: 'failure',
          message: 'Expected 3, received 4',
          title: 'AssertionError',
        },
        { path: 'src/other.ts', startLine: 4, level: 'warning', message: 'unused var', title: '' },
      ],
    },
  });
  const { system, pullRequests } = await build((errors) => new GitHubSourceControlIntegration({ api, errors }));

  // The mapping first: only the *failing* run carries a ref, and it pairs the
  // check-run id with the job id parsed out of `details_url`.
  assert.deepEqual(pullRequests[0]?.ciChecks, [{ name: 'test', status: 'failing', evidenceRef: '900/9001' }]);

  await system.harness.runCycle('manual');
  const task = ciTask(system);
  assert.ok(task, 'a CI-fix task should have been dispatched');
  assert.match(task.prompt, /src\/thing\.ts:12: AssertionError: Expected 3, received 4/);
  // A warning is not a failure: annotations are filtered to the level that broke
  // the build, or the excerpt fills with lint noise the check tolerated.
  assert.doesNotMatch(task.prompt, /unused var/);
  system.store.close();
});

test('with no annotations, GitHub falls back to the tail of the job log and names what it did not fetch', async () => {
  const lines = Array.from({ length: 500 }, (_, i) => `2026-08-15T09:00:00.000Z line ${i + 1}`);
  const api = ghApi({ checkRuns: [failingRun()], jobLogs: { 9001: lines.join('\n') } });
  const { system } = await build((errors) => new GitHubSourceControlIntegration({ api, errors }));

  await system.harness.runCycle('manual');
  const task = ciTask(system);
  assert.ok(task);
  // The tail, not the head — a log fails at the bottom.
  assert.match(task.prompt, /line 500/);
  assert.doesNotMatch(task.prompt, /line 1\b/);
  // The timestamp prefix is stripped: 29 characters a line is a fifth of the budget.
  assert.doesNotMatch(task.prompt, /2026-08-15T09:00:00\.000Z/);
  // And the loss is named rather than silent.
  assert.match(task.prompt, /380 earlier lines were not fetched/);
  system.store.close();
});

test('an Azure CI-fix dispatch carries the build timeline errors, keyed off the policy buildId', async () => {
  const api = azApi({
    timeline: {
      7788: [
        taskRecord({ issues: [{ type: 'error', message: 'AssertionError: expected 3 to equal 4' }] }),
        // A failed Job is the aggregate of the task above — reporting it too
        // would say the same thing twice at the top of the budget.
        { type: 'Job', name: 'Build and test', result: 'failed', logId: 3, issues: [] },
      ],
    },
  });
  const { system, pullRequests } = await build((errors) => new AzureDevOpsSourceControlIntegration({ api, errors }));

  assert.equal(pullRequests[0]?.ciChecks?.[0]?.evidenceRef, '7788', 'a failing build policy carries its build id');

  await system.harness.runCycle('manual');
  const task = ciTask(system);
  assert.ok(task);
  assert.match(task.prompt, /Run tests: AssertionError: expected 3 to equal 4/);
  assert.doesNotMatch(task.prompt, /Build and test/);
  system.store.close();
});

test('a fetch that fails leaves the prompt exactly as it was, and records the failure', async () => {
  // Both providers' worst realistic case: a token that reads everything else and
  // 403s on the log API. Azure's is the likelier one — Build (read) is a scope an
  // operator granting code + work items does not think to add.
  const api = azApi({ throwOn: 'timeline' });
  const { system } = await build((errors) => new AzureDevOpsSourceControlIntegration({ api, errors }));

  await system.harness.runCycle('manual');
  const task = ciTask(system);
  assert.ok(task, 'the dispatch still happens — evidence is an enrichment, not a precondition');
  assert.doesNotMatch(task.prompt, /What the failing checks actually reported/);

  // Recorded, never swallowed: the Errors panel is where a provider failure has
  // to surface, and this one is invisible in the dispatch itself by design.
  const errors = system.store.listErrors();
  assert.ok(
    errors.some((e) => e.source === 'provider' && /could not read CI evidence for "CI" on PR #42/.test(e.message)),
    `expected a recorded provider failure, got: ${errors.map((e) => e.message).join(' | ')}`,
  );
  system.store.close();
});

test('the whole-prompt cap trims the excerpt and says how much it trimmed', () => {
  // Pure, at the renderer: the cap is arithmetic over a budget, and driving it
  // through a dispatch would test the plumbing again instead of the boundary.
  const long: CiFailureEvidence = {
    check: 'test',
    kind: 'log',
    lines: Array.from({ length: 400 }, (_, i) => `${'x'.repeat(60)} ${i}`),
  };
  const note = ciEvidenceNote([long]);
  assert.ok(note.length < 8000, `the excerpt should be capped, got ${note.length} characters`);
  assert.match(note, /lines were trimmed to fit/);
  // The tail survives the trim, because that is where a log fails.
  assert.match(note, /399/);

  // Two checks share one budget rather than taking one each — three red checks
  // must not be three times the prompt.
  const two = ciEvidenceNote([long, { ...long, check: 'lint' }]);
  assert.ok(two.length < note.length * 1.6, 'a second check splits the budget, it does not double it');

  // Nothing to say composes nothing at all, which is what keeps a failed fetch
  // byte-identical to the prompt before this existed.
  assert.equal(ciEvidenceNote([]), '');
  assert.equal(ciEvidenceNote([{ check: 'test', kind: 'log', lines: [] }]), '');
});
