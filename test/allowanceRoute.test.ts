import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { AllowancePayload } from '../src/wire.js';

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-allowance-'));
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
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
}

test('the allowance route ships a tracker url for every goal it names', async () => {
  const system = build();
  Object.assign(system.connector, {
    resolveRefUrl: (ref: string) => (ref === 'issue:412' ? 'https://tracker/412' : null),
  });

  const { store } = system;
  const now = Date.now();
  const at = (minsAgo: number): string => new Date(now - minsAgo * 60_000).toISOString();
  const reading = (used: number, minsAgo: number) => ({
    fiveHour: { usedPercentage: used, resetsAt: null },
    sevenDay: { usedPercentage: used / 2, resetsAt: null },
    capturedAt: at(minsAgo),
  });
  store.rateLimits.recordRateLimits(reading(20, 10));
  const task = store.tasks.createTask({
    kind: 'code',
    title: 'a',
    prompt: 'p',
    branch: 'issue/412',
    originRef: 'issue:412',
  });
  const agent = store.agents.createAgent({ taskId: task.id, cwd: '/wt/a', pid: null });
  store.agents.recordAgentUsage(agent.id, {
    costUsd: 3,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: 2,
  });
  store.rateLimits.recordRateLimits({ ...reading(40, 0), capturedAt: new Date().toISOString() });

  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'GET', url: '/api/allowance?window=session' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as AllowancePayload;

  const goals = body.allowance.apportionment.goals;
  assert.ok(
    goals.some((goal) => goal.originRef === 'issue:412'),
    'the goal that spent inside the window is in the apportionment',
  );
  for (const goal of goals) assert.ok(goal.originRef in body.refUrls, `${goal.originRef} has somewhere to go`);
  assert.equal(body.refUrls['issue:412'], 'https://tracker/412');

  await app.close();
  store.close();
});
