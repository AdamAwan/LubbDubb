import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
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
import { findTask } from './support/tasks.js';

const BUILD_POLICY = '0609b952-1397-4640-95ec-e00a01b2c241';

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
          assigneeLogins: [],
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
    async resolveReviewThread() {
      return false;
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
    closeIssue: (): never => {
      throw new Error('closeIssue is not scripted in this test');
    },
    setIssueLabel: unused('setIssueLabel'),
    createIssue: unused('createIssue'),
    createPull: unused('createPull'),
    setPullTitle: unused('setPullTitle'),
    setPullBase: unused('setPullBase'),
    updatePullBranch: unused('updatePullBranch'),
    closePull: unused('closePull'),
    deleteBranch: unused('deleteBranch'),
  };
}

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
    authorDisplayName: '',
    url: 'https://dev.azure.com/o/p/_git/r/pullrequest/42',
    isDraft: false,
    mergeStatus: 'succeeded',
    reviewers: [],
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
    async setThreadStatus() {},
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
    requeuePolicyEvaluation: unused('requeuePolicyEvaluation'),
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
    createWorkItem: unused('createWorkItem'),
    relateWorkItem: unused('relateWorkItem'),
    listAreaPaths: () => Promise.resolve({ root: 'Contoso', paths: [] }),
    setWorkItemParent: () => Promise.reject(new Error('not used')),
    setWorkItemAreaPath: () => Promise.reject(new Error('not used')),
    setWorkItemTag: unused('setWorkItemTag'),
    linkWorkItemToPull: unused('linkWorkItemToPull'),
    createPull: unused('createPull'),
    setPullTitle: unused('setPullTitle'),
    setPullBase: unused('setPullBase'),
    abandonPullRequest: unused('abandonPullRequest'),
    deleteBranch: unused('deleteBranch'),
  };
}

function taskRecord(over: Partial<AzTimelineRecord> = {}): AzTimelineRecord {
  return { type: 'Task', name: 'Run tests', result: 'failed', logId: 12, issues: [], ...over };
}

async function build(
  make: (errors: ErrorRecorder) => GitHubSourceControlIntegration | AzureDevOpsSourceControlIntegration,
): Promise<{ system: System; pullRequests: PullRequest[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-evidence-'));
  let integration: GitHubSourceControlIntegration | AzureDevOpsSourceControlIntegration | null = null;
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
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

function ciTask(system: System) {
  return findTask(system.store, (t) => t.originRef === 'pr:42:ci');
}

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

  assert.deepEqual(pullRequests[0]?.ciChecks, [{ name: 'test', status: 'failing', evidenceRef: '900/9001' }]);

  await system.harness.runCycle('manual');
  const task = ciTask(system);
  assert.ok(task, 'a CI-fix task should have been dispatched');
  assert.match(task.prompt, /src\/thing\.ts:12: AssertionError: Expected 3, received 4/);
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
  assert.match(task.prompt, /line 500/);
  assert.doesNotMatch(task.prompt, /line 1\b/);
  assert.doesNotMatch(task.prompt, /2026-08-15T09:00:00\.000Z/);
  assert.match(task.prompt, /380 earlier lines were not fetched/);
  system.store.close();
});

test('an Azure CI-fix dispatch carries the build timeline errors, keyed off the policy buildId', async () => {
  const api = azApi({
    timeline: {
      7788: [
        taskRecord({ issues: [{ type: 'error', message: 'AssertionError: expected 3 to equal 4' }] }),
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
  const api = azApi({ throwOn: 'timeline' });
  const { system } = await build((errors) => new AzureDevOpsSourceControlIntegration({ api, errors }));

  await system.harness.runCycle('manual');
  const task = ciTask(system);
  assert.ok(task, 'the dispatch still happens — evidence is an enrichment, not a precondition');
  assert.doesNotMatch(task.prompt, /What the failing checks actually reported/);

  const errors = system.store.errors.listErrors();
  assert.ok(
    errors.some((e) => e.source === 'provider' && /could not read CI evidence for "CI" on PR #42/.test(e.message)),
    `expected a recorded provider failure, got: ${errors.map((e) => e.message).join(' | ')}`,
  );
  system.store.close();
});

test('the whole-prompt cap trims the excerpt and says how much it trimmed', () => {
  const long: CiFailureEvidence = {
    check: 'test',
    kind: 'log',
    lines: Array.from({ length: 400 }, (_, i) => `${'x'.repeat(60)} ${i}`),
  };
  const note = ciEvidenceNote([long]);
  assert.ok(note.length < 8000, `the excerpt should be capped, got ${note.length} characters`);
  assert.match(note, /lines were trimmed to fit/);
  assert.match(note, /399/);

  const two = ciEvidenceNote([long, { ...long, check: 'lint' }]);
  assert.ok(two.length < note.length * 1.6, 'a second check splits the budget, it does not double it');

  assert.equal(ciEvidenceNote([]), '');
  assert.equal(ciEvidenceNote([{ check: 'test', kind: 'log', lines: [] }]), '');
});

test('a single line longer than the whole budget is cut mid-line, not admitted whole', () => {
  const stack = Array.from({ length: 400 }, (_, i) => `at Handler${i}(ct) in /src/Service/Handler${i}.cs:line ${i}`)
    .join(' ')
    .concat(' THE-ASSERTION-AT-THE-TAIL');

  const log = ciEvidenceNote([{ check: 'test', kind: 'log', lines: [stack] }]);
  assert.ok(log.length < 8000, `one oversized log line must still be capped, got ${log.length} characters`);
  assert.match(log, /cut mid-line to fit/);
  assert.match(log, /THE-ASSERTION-AT-THE-TAIL/, "a log's tail is the end kept, mid-line as much as line by line");

  const errors = ciEvidenceNote([{ check: 'lint', kind: 'errors', lines: [`FIRST-ERROR ${stack}`] }]);
  assert.ok(errors.length < 8000, `one oversized error line must still be capped, got ${errors.length} characters`);
  assert.match(errors, /cut mid-line to fit/);
  assert.match(errors, /FIRST-ERROR/, "an error's head is the end kept");

  const three = ciEvidenceNote([
    { check: 'a', kind: 'log', lines: [stack] },
    { check: 'b', kind: 'log', lines: [stack] },
    { check: 'c', kind: 'log', lines: [stack] },
  ]);
  assert.ok(three.length < 8000, `the total must not scale with the check count, got ${three.length} characters`);
});
