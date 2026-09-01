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

/**
 * The Allowance tab's links.
 *
 * The fold is `test/allowance.test.ts`'s subject; what is asserted here is the
 * one thing it cannot see — that the route resolves a **tracker URL per goal it
 * names**. `/api/state`'s `refUrls` is built from the world, and a goal that
 * spent inside a five-hour window has very often closed since, so the map the
 * shell provides does not carry it. Without the route's own the tab draws that
 * goal's number as plain text: a row that reads correctly, renders correctly and
 * is a dead end, which is the cockpit's most repeated bug and the reason
 * `<Ref>` exists at all.
 */

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
  // The fake connector resolves nothing — an all-fake world has no pages behind
  // it — so the resolver stands in for a real provider's.
  Object.assign(system.connector, {
    resolveRefUrl: (ref: string) => (ref === 'issue:412' ? 'https://tracker/412' : null),
  });

  const { store } = system;
  const now = Date.now();
  const at = (minsAgo: number): string => new Date(now - minsAgo * 60_000).toISOString();
  // Two readings make a change, and the rise across them is what there is to
  // apportion; one agent's cost inside that interval is what claims a share.
  const reading = (used: number, minsAgo: number) => ({
    fiveHour: { usedPercentage: used, resetsAt: null },
    sevenDay: { usedPercentage: used / 2, resetsAt: null },
    capturedAt: at(minsAgo),
  });
  store.recordRateLimits(reading(20, 10));
  const task = store.createTask({ kind: 'code', title: 'a', prompt: 'p', branch: 'issue/412', originRef: 'issue:412' });
  const agent = store.createAgent({ taskId: task.id, cwd: '/wt/a', pid: null });
  store.recordAgentUsage(agent.id, {
    costUsd: 3,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: 2,
  });
  // Recorded last, so the agent's cost delta falls *inside* the interval the two
  // readings bound — which is what gives the goal a share to be charged.
  store.recordRateLimits({ ...reading(40, 0), capturedAt: new Date().toISOString() });

  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'GET', url: '/api/allowance?window=session' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as AllowancePayload;

  const goals = body.allowance.apportionment.goals;
  assert.ok(
    goals.some((goal) => goal.originRef === 'issue:412'),
    'the goal that spent inside the window is in the apportionment',
  );
  // Every goal the payload names, or the tab has a row it cannot link.
  for (const goal of goals) assert.ok(goal.originRef in body.refUrls, `${goal.originRef} has somewhere to go`);
  assert.equal(body.refUrls['issue:412'], 'https://tracker/412');

  await app.close();
  store.close();
});
