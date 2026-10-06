import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { AzureDevOpsSourceControlIntegration } from '../src/integrations/azure/sourceControl.js';
import { GitHubSourceControlIntegration } from '../src/integrations/github/sourceControl.js';
import type { AzureDevOpsApi } from '../src/integrations/azure/azureDevOpsApi.js';
import type { GitHubApi } from '../src/integrations/github/githubApi.js';
import type { BotPrsPayload, CockpitState } from '../src/wire.js';

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-botprask-'));
  return buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: 'lubbdubb',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 3,
      botPrs: { authors: ['^renovate\\[bot\\]$'], riskSchedule: '' },
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
}

function botPr(system: System, number: number, opts: { failing?: boolean; assigned?: boolean } = {}): void {
  system.connector.inject({
    kind: 'new_pr',
    number,
    title: `Update dependency dep${number} to v2`,
    branch: `renovate/dep${number}`,
    author: 'renovate[bot]',
    botAuthored: true,
    ...(opts.assigned === false ? {} : { viewerAssignment: 'assignee' as const }),
  });
  system.connector.inject({ kind: opts.failing === false ? 'ci_passed' : 'ci_failed', prNumber: number });
}

async function asks(app: Awaited<ReturnType<typeof buildApp>>['app']): Promise<Map<string, string>> {
  const state = (await app.inject({ method: 'GET', url: '/api/state' })).json<CockpitState>();
  return new Map(state.asks.map((a) => [a.id, `${a.kind}/${a.urgency}`]));
}

test('a failing bot pull request on you asks to be watched, abandoned or stepped off; a green one stays a review', async () => {
  const system = build();
  botPr(system, 7);
  botPr(system, 9, { failing: false });
  botPr(system, 10, { assigned: false });
  const { app } = await buildApp(system);
  try {
    await system.harness.runCycle('manual');
    const rows = await asks(app);
    assert.equal(rows.get('bot_pr:pr:7'), 'bot_pr/next');
    assert.equal(rows.has('assigned:pr:7'), false, 'the same pull request is not asked about twice');
    assert.equal(rows.get('assigned:pr:9'), 'assigned/later', 'awaiting a review is the ordinary assigned row');
    assert.equal(rows.has('bot_pr:pr:9'), false);
    assert.equal(rows.has('bot_pr:pr:10'), false, 'one nobody put on you is not yours to answer');
  } finally {
    await app.close();
    system.store.close();
  }
});

test('watching it hands it to the fleet, and the ask goes', async () => {
  const system = build();
  botPr(system, 7);
  const { app } = await buildApp(system);
  try {
    await system.harness.runCycle('manual');
    assert.equal((await asks(app)).has('bot_pr:pr:7'), true);
    const res = await app.inject({ method: 'POST', url: '/api/prs/7/watch', payload: { watched: true } });
    assert.equal(res.statusCode, 200);
    const rows = await asks(app);
    assert.equal(rows.has('bot_pr:pr:7'), false);
    assert.equal(rows.has('assigned:pr:7'), false, 'watched, the court is the fleet’s');
  } finally {
    await app.close();
    system.store.close();
  }
});

test('stepping off takes you off it on the provider and the ask goes; a pull request no bot raised is refused', async () => {
  const system = build();
  botPr(system, 7);
  system.connector.inject({ kind: 'new_pr', number: 8, title: 'Fix the thing', branch: 'issue/8', author: 'someone' });
  const { app } = await buildApp(system);
  try {
    await system.harness.runCycle('manual');
    assert.equal((await asks(app)).has('bot_pr:pr:7'), true);
    assert.equal((await app.inject({ method: 'POST', url: '/api/bot-prs/7/unclaim' })).statusCode, 200);
    assert.equal((await asks(app)).has('bot_pr:pr:7'), false);
    const reading = (await app.inject({ method: 'GET', url: '/api/bot-prs' })).json<BotPrsPayload>();
    assert.equal(reading.pullRequests.find((p) => p.number === 7)?.viewerReviewing, false);
    assert.equal((await app.inject({ method: 'POST', url: '/api/bot-prs/8/unclaim' })).statusCode, 404);
  } finally {
    await app.close();
    system.store.close();
  }
});

test('abandoning it closes it and the ask goes', async () => {
  const system = build();
  botPr(system, 7);
  const { app } = await buildApp(system);
  try {
    await system.harness.runCycle('manual');
    assert.equal((await asks(app)).has('bot_pr:pr:7'), true);
    assert.equal((await app.inject({ method: 'POST', url: '/api/bot-prs/7/close' })).statusCode, 200);
    assert.equal((await asks(app)).has('bot_pr:pr:7'), false);
  } finally {
    await app.close();
    system.store.close();
  }
});

test('github steps off by removing the viewer’s login; azure by removing the viewer’s identity as a reviewer', async () => {
  const removed: [number, string][] = [];
  const gh = new GitHubSourceControlIntegration({
    api: {
      viewerLogin: async () => 'me',
      removePullAssignee: async (n: number, login: string) => void removed.push([n, login]),
    } as unknown as GitHubApi,
  });
  assert.deepEqual(await gh.claimBotPr(3, false), { ok: true, ref: 'me' });

  const az = new AzureDevOpsSourceControlIntegration({
    api: {
      viewerId: async () => 'guid-me',
      removePullReviewer: async (n: number, id: string) => void removed.push([n, id]),
    } as unknown as AzureDevOpsApi,
  });
  assert.deepEqual(await az.claimBotPr(5, false), { ok: true, ref: 'guid-me' });
  assert.deepEqual(removed, [
    [3, 'me'],
    [5, 'guid-me'],
  ]);

  const nobody = new GitHubSourceControlIntegration({
    api: { viewerLogin: async () => '' } as unknown as GitHubApi,
  });
  assert.deepEqual(await nobody.claimBotPr(3, false), { ok: false }, 'a provider that cannot name you removes nobody');
});
