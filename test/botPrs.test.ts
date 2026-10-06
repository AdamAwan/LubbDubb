import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system/system.js';
import { loadConfig, type Config } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { readDependencyUpdate } from '../src/botPrs/dependencyUpdate.js';
import { BotPrReader } from '../src/botPrs/reader.js';
import type { ErrorRecorder } from '../src/errorLog.js';
import { FAKE_VIEWER } from '../src/integrations/fake/fakeGitHub.js';
import { AzureDevOpsSourceControlIntegration } from '../src/integrations/azure/sourceControl.js';
import { GitHubSourceControlIntegration } from '../src/integrations/github/sourceControl.js';
import type { AzureDevOpsApi, AzPull } from '../src/integrations/azure/azureDevOpsApi.js';
import type { GitHubApi, GhPullSummary } from '../src/integrations/github/githubApi.js';
import type { BotPullRequest } from '../src/types.js';
import type { BotPrsPayload, CockpitState } from '../src/wire.js';

function build(overrides: Partial<Config> = {}): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-botprs-'));
  return buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 3,
      ...overrides,
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
}

const RENOVATE_BODY = [
  'This PR contains the following updates:',
  '',
  '| Package | Change | Age | Confidence |',
  '|---|---|---|---|',
  '| [dotenv](https://github.com/motdotla/dotenv) | [`16.4.5` -> `17.0.1`](https://renovatebot.com/diffs/npm/dotenv/16.4.5/17.0.1) | age | confidence |',
].join('\n');

test('a Renovate body names the versions, and the jump between them is the kind', () => {
  assert.deepEqual(readDependencyUpdate('Update dependency dotenv to v17', RENOVATE_BODY), {
    kind: 'major',
    packageName: 'dotenv',
    from: '16.4.5',
    to: '17.0.1',
  });
  const minor = readDependencyUpdate('Update dependency @types/node to v22.9.0', '| `22.7.4` → `22.9.0` |');
  assert.equal(minor.kind, 'minor');
  assert.equal(minor.packageName, '@types/node');
  assert.equal(readDependencyUpdate('Update axios to v1.7.4', '`v1.7.3` -> `v1.7.4`').kind, 'patch');
});

test('with no body, a title naming only a major is major and anything finer is unknown', () => {
  assert.equal(readDependencyUpdate('Update dependency eslint to v9').kind, 'major');
  assert.equal(readDependencyUpdate('chore(deps): update dependency eslint to v9').packageName, 'eslint');
  assert.equal(readDependencyUpdate('Update dependency axios to v1.7.4').kind, 'unknown');
  assert.equal(readDependencyUpdate('Update dependency axios to v1.7.4 (patch)').kind, 'patch');
});

test('a grouped or unfamiliar title is unknown, never guessed', () => {
  assert.deepEqual(readDependencyUpdate('Update all non-major dependencies'), {
    kind: 'unknown',
    packageName: null,
    from: null,
    to: null,
  });
  assert.equal(readDependencyUpdate('Lock file maintenance', '').kind, 'unknown');
});

test('the route lists only the named authors, past the fleet’s own filter, with the update read', async () => {
  const system = build({ botPrs: { authors: ['^renovate\\[bot\\]$'], riskSchedule: '' } });
  system.connector.inject({
    kind: 'new_pr',
    number: 7,
    title: 'Update dependency dotenv to v17',
    branch: 'renovate/dotenv-17.x',
    author: 'renovate[bot]',
  });
  system.connector.inject({ kind: 'pr_body_edited', prNumber: 7, body: RENOVATE_BODY });
  system.connector.inject({ kind: 'ci_failed', prNumber: 7 });
  system.connector.inject({ kind: 'new_pr', number: 8, title: 'Fix the thing', branch: 'issue/8', author: 'someone' });
  const { app } = await buildApp(system);
  try {
    const res = await app.inject({ method: 'GET', url: '/api/bot-prs' });
    assert.equal(res.statusCode, 200);
    const body = res.json<BotPrsPayload>();
    assert.equal(body.configured, true);
    assert.equal(body.error, null);
    assert.deepEqual(
      body.pullRequests.map((pr) => [pr.number, pr.author, pr.ciStatus, pr.update.kind, pr.update.from]),
      [[7, 'renovate[bot]', 'failing', 'major', '16.4.5']],
    );

    const state = (await app.inject({ method: 'GET', url: '/api/state' })).json<CockpitState>();
    assert.equal(state.config.botPrs, true, 'the tab is offered once a bot is named');
  } finally {
    await app.close();
    system.store.close();
  }
});

test('claiming adds you as a reviewer, shows on the next read, and is refused twice or off the list', async () => {
  const system = build({ botPrs: { authors: ['^renovate\\[bot\\]$'], riskSchedule: '' } });
  system.connector.inject({
    kind: 'new_pr',
    number: 7,
    title: 'Update dependency x to v2',
    branch: 'renovate/x',
    author: 'renovate[bot]',
  });
  system.connector.inject({ kind: 'new_pr', number: 8, title: 'Fix the thing', branch: 'issue/8', author: 'someone' });
  const { app } = await buildApp(system);
  try {
    const before = (await app.inject({ method: 'GET', url: '/api/bot-prs' })).json<BotPrsPayload>();
    assert.deepEqual(before.pullRequests[0]!.reviewers, []);
    assert.equal(before.pullRequests[0]!.viewerReviewing, false);

    const claimed = await app.inject({ method: 'POST', url: '/api/bot-prs/7/claim' });
    assert.equal(claimed.statusCode, 200);

    const after = (await app.inject({ method: 'GET', url: '/api/bot-prs' })).json<BotPrsPayload>();
    assert.deepEqual(after.pullRequests[0]!.reviewers, [{ id: FAKE_VIEWER, name: FAKE_VIEWER }]);
    assert.equal(after.pullRequests[0]!.viewerReviewing, true, 'the claim is not served from the cached reading');

    assert.equal((await app.inject({ method: 'POST', url: '/api/bot-prs/7/claim' })).statusCode, 409);
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/bot-prs/8/claim' })).statusCode,
      404,
      'a pull request no named bot raised cannot be claimed here',
    );
  } finally {
    await app.close();
    system.store.close();
  }
});

test('azure claims by the viewer’s identity id, and lists only optional reviewers', async () => {
  const added: [number, string][] = [];
  const api = {
    viewerUniqueName: async () => 'me@acme.com',
    viewerId: async () => 'guid-me',
    listActivePullRequests: async (): Promise<AzPull[]> => [
      {
        pullRequestId: 5,
        title: 'Update dependency x to v2',
        branch: 'renovate/x',
        baseBranch: 'main',
        lastMergeSourceCommit: 'abc',
        authorUniqueName: 'build\\Renovate',
        authorDisplayName: 'Renovate Bot',
        url: 'u',
        isDraft: false,
        mergeStatus: 'succeeded',
        reviewers: [
          {
            id: 'guid-lead',
            displayName: 'Team Lead',
            uniqueName: 'lead@acme.com',
            vote: 0,
            isRequired: true,
            isContainer: false,
          },
          {
            id: 'guid-me',
            displayName: 'Me',
            uniqueName: 'me@acme.com',
            vote: 0,
            isRequired: false,
            isContainer: false,
          },
        ],
      },
    ],
    listPolicyEvaluations: async () => [],
    addPullReviewer: async (id: number, reviewer: string) => void added.push([id, reviewer]),
  } as unknown as AzureDevOpsApi;
  const sc = new AzureDevOpsSourceControlIntegration({ api });

  const [pr] = await sc.listBotPullRequests([/Renovate/]);
  assert.deepEqual(pr!.reviewers, [{ id: 'guid-me', name: 'Me' }], 'a required reviewer is not someone taking it on');
  assert.equal(pr!.viewerReviewing, true);

  assert.deepEqual(await sc.claimBotPr(5), { ok: true, ref: 'guid-me' });
  assert.deepEqual(added, [[5, 'guid-me']]);
});

test('with no author named, the route reads nothing and says so', async () => {
  const system = build();
  const { app } = await buildApp(system);
  try {
    const body = (await app.inject({ method: 'GET', url: '/api/bot-prs' })).json<BotPrsPayload>();
    assert.deepEqual(body, {
      configured: false,
      readAt: null,
      pullRequests: [],
      error: null,
      risk: { schedule: null, nextRunAt: null, run: null },
    });
  } finally {
    await app.close();
    system.store.close();
  }
});

test('the reader reuses a fresh reading, and a failed read keeps the last good rows and is recorded', async () => {
  let calls = 0;
  let fail = false;
  let now = 1_000_000;
  const recorded: string[] = [];
  const errors: ErrorRecorder = {
    record: (input) => {
      recorded.push(input.message);
      return { id: recorded.length, at: '', ...input } as unknown as ReturnType<ErrorRecorder['record']>;
    },
  };
  const reader = new BotPrReader({
    source: {
      listBotPullRequests: async (): Promise<BotPullRequest[]> => {
        calls += 1;
        if (fail) throw new Error('provider down');
        return [
          {
            number: 1,
            title: 'Update dependency x to v2',
            author: 'bot',
            ciStatus: 'passing',
            reviewers: [],
            viewerReviewing: false,
          },
        ];
      },
      claimBotPr: async () => ({ ok: true }),
      closePr: async () => ({ ok: true }),
    },
    authors: () => ['bot', '(unclosed'],
    errors,
    now: () => now,
    maxAgeMs: 60_000,
  });

  assert.equal((await reader.read()).pullRequests.length, 1);
  await reader.read();
  assert.equal(calls, 1, 'a reading inside its shelf life is reused');

  now += 61_000;
  fail = true;
  const stale = await reader.read();
  assert.equal(calls, 2);
  assert.equal(stale.error, 'provider down');
  assert.equal(stale.pullRequests.length, 1, 'the last good rows survive a failed read');
  assert.deepEqual(recorded, ['Bot PR read failed: provider down']);
});

test('azure matches the author by unique or display name, and reads CI from policy', async () => {
  const pull = (id: number, uniqueName: string, displayName: string): AzPull => ({
    pullRequestId: id,
    title: 'Update dependency dotenv to v17',
    branch: 'renovate/dotenv',
    baseBranch: 'main',
    lastMergeSourceCommit: 'abc',
    authorUniqueName: uniqueName,
    authorDisplayName: displayName,
    url: `https://dev.azure.com/o/p/_git/r/pullrequest/${id}`,
    isDraft: false,
    mergeStatus: 'succeeded',
    reviewers: [],
    description: RENOVATE_BODY,
    createdAt: '2026-09-27T09:00:00Z',
  });
  const api = {
    viewerUniqueName: async () => 'me@acme.com',
    listActivePullRequests: async () => [
      pull(33473, 'build\\Renovate', 'Renovate Bot'),
      pull(33474, 'someone@acme.com', 'Some One'),
    ],
    listPolicyEvaluations: async () => [],
  } as unknown as AzureDevOpsApi;

  const prs = await new AzureDevOpsSourceControlIntegration({ api }).listBotPullRequests([/^Renovate Bot$/]);
  assert.deepEqual(
    prs.map((pr) => [pr.number, pr.author, pr.createdAt]),
    [[33473, 'Renovate Bot', '2026-09-27T09:00:00Z']],
  );
  assert.equal(prs[0]!.body, RENOVATE_BODY);
});

test('github matches the login and reads CI from the head commit', async () => {
  const summary = (number: number, authorLogin: string): GhPullSummary => ({
    number,
    title: 'Update dependency axios to v1.7.4',
    branch: 'renovate/axios',
    baseBranch: 'main',
    headSha: `sha${number}`,
    authorLogin,
    url: `https://github.com/o/r/pull/${number}`,
    labels: [],
    assigneeLogins: [],
    body: '`1.7.3` -> `1.7.4`',
  });
  const api = {
    viewerLogin: async () => 'me',
    listOpenPulls: async () => [summary(1, 'renovate[bot]'), summary(2, 'someone')],
    getCombinedStatus: async () => ({
      state: 'success',
      totalCount: 1,
      statuses: [{ context: 'ci', state: 'success' }],
    }),
    listCheckRuns: async () => [],
  } as unknown as GitHubApi;

  const prs = await new GitHubSourceControlIntegration({ api }).listBotPullRequests([/\[bot\]$/]);
  assert.deepEqual(
    prs.map((pr) => [pr.number, pr.author]),
    [[1, 'renovate[bot]']],
  );
});
