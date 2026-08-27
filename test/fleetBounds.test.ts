import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { ENDED_AGENT_TAIL, fleetHistory } from '../src/server/fleetHistory.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { Agent, GoalAgentsPayload, TaskSummary } from '../src/wire.js';

/**
 * What `/api/state` is allowed to *keep* carrying.
 *
 * `agents` and `tasks` were the last two collections on the snapshot with no cap
 * on them: all-time reads over tables nothing deletes from, rebuilt and
 * re-serialised on every `dirty` — which rides every file an agent writes. So
 * what the cockpit paid per action grew for the life of the deployment, and
 * nothing about it was ever red. The bound is here; the history it leaves behind
 * is `GET /api/issues/:number/agents`, and these assertions are the pair.
 *
 * → `docs/spec/16-http-api.md#bulk-collections`
 */

function testSystem(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-fleet-'));
  const config = loadConfig({
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
  });
  // `config.repoRoot` defaults to `process.cwd()`, and the real manager would cut
  // a branch in this checkout on any path that dispatched.
  return buildSystem(config, { worktrees: new FakeWorktreeManager(), errorMirror: () => {} });
}

/** One dispatched agent, ended at `endedAt` when given. */
function run(system: System, originRef: string, endedAt: string | null, title = 'a shift'): Agent {
  const task = system.store.createTask({ kind: 'code', title, prompt: 'x', branch: null, originRef });
  const agent = system.store.createAgent({ taskId: task.id, cwd: '/tmp', pid: null });
  if (endedAt !== null) system.store.updateAgent(agent.id, { status: 'done', endedAt });
  return agent;
}

const at = (day: number): string => `2026-03-${String(day).padStart(2, '0')}T00:00:00.000Z`;

function agent(id: string, endedAt: string | null): Agent {
  return {
    id,
    taskId: `task-${id}`,
    status: endedAt === null ? 'running' : 'done',
    cwd: '/tmp',
    pid: null,
    waitingReason: null,
    sessionId: null,
    startedAt: at(1),
    endedAt,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: null,
    note: null,
    notedAt: null,
    resumedAt: null,
    resumeAttempts: 0,
  };
}

function task(id: string): TaskSummary {
  return {
    id,
    kind: 'code',
    title: id,
    branch: null,
    originRef: null,
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'done',
    agentId: null,
    createdAt: at(1),
    updatedAt: at(1),
  };
}

test('the bound is on history: every live agent survives it, whatever the cap', () => {
  const rows = [...Array.from({ length: 5 }, (_, i) => agent(`live-${i}`, null)), agent('old', at(1))];
  const history = fleetHistory(
    rows,
    rows.map((a) => task(a.taskId)),
    2,
  );

  assert.equal(history.agents.filter((a) => a.endedAt === null).length, 5, 'a running row is never a sample');
  assert.equal(history.ended, 1);
});

test('the tail is the newest *ended*, not the newest started', () => {
  // Started first and ended last: what an operator is looking for after a long
  // run, and exactly the row a started-at cut would drop.
  const long = { ...agent('long', at(9)), startedAt: at(1) };
  const short = { ...agent('short', at(3)), startedAt: at(2) };
  const rows = [short, long];

  const history = fleetHistory(
    rows,
    rows.map((a) => task(a.taskId)),
    1,
  );
  assert.deepEqual(
    history.agents.map((a) => a.id),
    ['long'],
  );
  assert.equal(history.ended, 2, 'the count is all of them either way');
});

test('tasks are narrowed to the agents shipped — a row nothing can reach is not on the wire', () => {
  const kept = agent('kept', null);
  const dropped = agent('dropped', at(1));
  const history = fleetHistory([kept, dropped], [task('task-kept'), task('task-dropped'), task('task-orphan')], 0);

  assert.deepEqual(
    history.tasks.map((t) => t.id),
    ['task-kept'],
    'neither the dropped agent’s task nor one with no agent at all',
  );
});

test('the snapshot ships the fleet tail and says how many shifts there have really been', () => {
  const system = testSystem();
  for (let i = 0; i < ENDED_AGENT_TAIL + 5; i++) run(system, `issue:${i}`, at(1));
  const live = run(system, 'issue:live', null);

  const snapshot = buildStateSnapshot(system);
  assert.equal(snapshot.agents.length, ENDED_AGENT_TAIL + 1, 'the tail, plus the one that is still out');
  assert.equal(snapshot.endedAgents, ENDED_AGENT_TAIL + 5, 'and the count is every shift that has ended');
  assert.ok(
    snapshot.agents.some((a) => a.id === live.id),
    'the live row is on it whatever the history has been',
  );
  assert.equal(snapshot.tasks.length, snapshot.agents.length, 'one task per shipped agent, and no others');

  system.store.close();
});

test('a goal’s whole history is its own route, older than the tail and all', async () => {
  const system = testSystem();
  const old = run(system, 'issue:7', at(1), 'the first attempt');
  const onPart = run(system, 'issue:7:part:signer', at(2), 'the part');
  const onPr = run(system, 'pr:42', at(3), 'the review round');
  const elsewhere = run(system, 'issue:8', at(4), 'another goal');
  // Enough after them that none of the four is in the snapshot's tail.
  for (let i = 0; i < ENDED_AGENT_TAIL; i++) run(system, `issue:${100 + i}`, at(9));

  const snapshot = buildStateSnapshot(system);
  assert.ok(!snapshot.agents.some((a) => a.id === old.id), 'the snapshot has dropped it, which is the point');

  const { app } = await buildApp(system);
  const answer = await app.inject({ method: 'GET', url: '/api/issues/7/agents?prs=42' });
  assert.equal(answer.statusCode, 200);
  const payload = answer.json() as GoalAgentsPayload;
  assert.equal(payload.ref, 'issue:7');
  assert.deepEqual(
    payload.agents.map((a) => a.id).sort(),
    [old.id, onPart.id, onPr.id].sort(),
    'the goal, its parts and the pull request the caller named',
  );
  assert.ok(!payload.agents.some((a) => a.id === elsewhere.id), 'and no other goal’s');
  assert.equal(payload.tasks.length, 3, 'with the tasks, so an old run still has its title');

  // The pull request is the caller's claim, not the route's guess: unnamed, its
  // agent is not this goal's as far as this read is concerned.
  const withoutPr = await app.inject({ method: 'GET', url: '/api/issues/7/agents' });
  assert.ok(!(withoutPr.json() as GoalAgentsPayload).agents.some((a) => a.id === onPr.id));

  // `issue:70` must not be pulled in by a prefix match on `issue:7`.
  const cousin = run(system, 'issue:70', at(1), 'a goal that shares digits');
  const again = await app.inject({ method: 'GET', url: '/api/issues/7/agents' });
  assert.ok(!(again.json() as GoalAgentsPayload).agents.some((a) => a.id === cousin.id));

  const bad = await app.inject({ method: 'GET', url: '/api/issues/7/agents?prs=nine' });
  assert.equal(bad.statusCode, 400);

  system.store.close();
});
