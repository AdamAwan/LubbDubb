import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import type { Spawner, StreamChild } from '../src/agents/streamJsonSession.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { failPlanningOpen } from './support/plans.js';

const PROFILES = {
  fast: { model: 'haiku', rank: 1, description: 'mechanical work' },
  deep: { model: 'opus', effort: 'high', permissionMode: 'acceptEdits', rank: 2, description: 'work nobody can see' },
} as const;

class FakeChild extends EventEmitter implements StreamChild {
  pid = 555;
  private out = new EventEmitter();
  stdout = { on: (ev: string, cb: (d: string) => void) => this.out.on(ev, cb) } as unknown as NodeJS.ReadableStream;
  stderr = null;
  stdin = { write: () => {}, end: () => {} } as unknown as NodeJS.WritableStream;
  override on(event: 'exit', cb: (code: number | null) => void): this {
    return super.on(event, cb);
  }
  kill(): void {
    this.emit('exit', 143);
  }
}

function streamConfig(agentModels: Config['agentModels']): Config {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-lift-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'stream',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    auth: { enabled: false } as never,
    agentModels,
  });
}

interface Bench {
  system: System;
  worktrees: FakeWorktreeManager;
  launches: string[][];
}

async function onFast(n = 7): Promise<Bench> {
  const launches: string[][] = [];
  const spawner: Spawner = (_command, args) => {
    launches.push(args);
    return new FakeChild();
  };
  const worktrees = new FakeWorktreeManager();
  const system = buildSystem(streamConfig({ profiles: PROFILES, default: 'fast' }), {
    worktrees,
    streamSpawner: spawner,
    errorMirror: () => {},
  });
  system.connector.inject({ kind: 'new_issue', number: n, title: 'Add login' });
  failPlanningOpen(system.store, n);
  await system.harness.runCycle('manual');
  return { system, worktrees, launches };
}

function liveAgent(system: System) {
  const agent = system.store.agents.listAgentsByStatus('starting', 'running')[0];
  assert.ok(agent, 'a stream agent should be live');
  return agent!;
}

const flag = (args: string[], name: string): string | undefined => args[args.indexOf(name) + 1];

test('lifting a live run re-opens its conversation on the deeper profile', async () => {
  const { system, launches } = await onFast();
  const before = liveAgent(system);
  const task = system.store.tasks.getTask(before.taskId)!;
  assert.equal(task.profile, 'fast');
  assert.equal(flag(launches[0]!, '--model'), 'haiku');

  const result = system.agents.lift(before.id, {
    name: 'deep',
    model: 'opus',
    effort: 'high',
    permissionMode: 'acceptEdits',
    autoApprove: false,
  });
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.agentId !== before.id, 'a lift writes a new agent row, it does not edit the old one');

  const after = system.store.agents.getAgent((result as { agentId: string }).agentId)!;
  assert.equal(after.sessionId, before.sessionId, 'the conversation is the same one, carried on');
  assert.equal(after.cwd, before.cwd, 'and it is carried on in the same worktree');
  assert.equal(system.store.agents.getAgent(before.id)!.status, 'killed');
  assert.equal(system.store.tasks.getTask(task.id)!.status, 'interrupted');

  const next = system.store.tasks.getTask(after.taskId)!;
  assert.equal(next.status, 'running');
  assert.equal(next.profile, 'deep');
  assert.equal(next.profileSource, 'pin');
  assert.equal(next.model, 'opus');
  assert.equal(next.effort, 'high');
  assert.equal(next.branch, task.branch, 'the work is the same work, on the same branch');
  assert.equal(next.rule, task.rule);

  // A stream session launches a process per turn, so the lift's launch is the last one,
  // not the second: what matters is that it is the first to carry the deeper model.
  const lift = launches.at(-1)!;
  assert.equal(flag(lift, '--model'), 'opus');
  assert.equal(flag(lift, '--effort'), 'high');
  assert.equal(
    launches.filter((a) => flag(a, '--model') === 'opus').length,
    1,
    'exactly one launch is lifted; the run before it stays on what it was priced at',
  );
  assert.equal(lift.includes('--resume'), true, 'the lifted launch resumes rather than minting a session');
  assert.equal(lift.includes('--session-id'), false, 'never both');
  system.store.close();
});

test('the lifted agent is told the conversation above is not its own and did not work', async () => {
  const { system } = await onFast(8);
  const before = liveAgent(system);
  const task = system.store.tasks.getTask(before.taskId)!;

  const result = system.agents.lift(before.id, {
    name: 'deep',
    model: 'opus',
    effort: null,
    permissionMode: null,
    autoApprove: false,
  });
  assert.ok(result.ok);
  const prompt = system.store.tasks.getTask((result as { taskId: string }).taskId)!.prompt;

  assert.match(prompt, /did not work/i, 'the note must say the earlier run failed, not merely that it happened');
  assert.match(prompt, /\*\*fast\*\*/, 'it names the profile that could not get it done');
  assert.match(prompt, /\*\*deep\*\*/, 'and the one it has been lifted to');
  assert.match(prompt, /unverified/i, 'every conclusion in the transcript is to be re-derived');
  assert.match(prompt, /Do not resume it by default/, 'the approach in flight is the one that was not working');
  assert.ok(prompt.endsWith(task.prompt), 'the note is prepended; the concern itself is carried verbatim');
  system.store.close();
});

test('a lift keeps the worktree slot, which the kill would otherwise release', async () => {
  const { system, worktrees } = await onFast(9);
  const before = liveAgent(system);
  const branch = system.store.tasks.getTask(before.taskId)!.branch;

  system.agents.lift(before.id, {
    name: 'deep',
    model: 'opus',
    effort: null,
    permissionMode: null,
    autoApprove: false,
  });
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(
    worktrees.removed.includes(branch!),
    false,
    'the successor task is written before the kill precisely so the reap finds the branch still held',
  );
  system.store.close();
});

test('a lift is audited as the operator’s own act', async () => {
  const { system } = await onFast(10);
  const before = liveAgent(system);

  system.agents.lift(before.id, {
    name: 'deep',
    model: 'opus',
    effort: null,
    permissionMode: null,
    autoApprove: false,
  });
  const row = system.store.decisions.listDecisions(50).find((d) => d.cycleId === `human:${before.id}`);
  assert.ok(row, 'a decision must be recorded under the human: cycle id the cockpit badges');
  assert.match(row!.detail, /"deep"/);
  system.store.close();
});

test('the route refuses an unknown profile, the standing one, and an agent that is not live', async () => {
  const { system } = await onFast(11);
  const before = liveAgent(system);
  const { app } = await buildApp(system);

  const unknown = await app.inject({
    method: 'POST',
    url: `/api/agents/${before.id}/profile`,
    payload: { profile: 'deeper' },
  });
  assert.equal(unknown.statusCode, 400);
  assert.match(unknown.json().error, /not one of this deployment's profiles: fast, deep/);

  const standing = await app.inject({
    method: 'POST',
    url: `/api/agents/${before.id}/profile`,
    payload: { profile: 'fast' },
  });
  assert.equal(standing.statusCode, 409, 'lifting to the profile it is already on is a no-op, and says so');

  const lifted = await app.inject({
    method: 'POST',
    url: `/api/agents/${before.id}/profile`,
    payload: { profile: 'deep' },
  });
  assert.equal(lifted.statusCode, 200);

  const again = await app.inject({
    method: 'POST',
    url: `/api/agents/${before.id}/profile`,
    payload: { profile: 'deep' },
  });
  assert.equal(again.statusCode, 409, 'the agent it named is gone; the lift is not silently applied to its successor');

  const missing = await app.inject({ method: 'POST', url: `/api/agents/nope/profile`, payload: { profile: 'deep' } });
  assert.equal(missing.statusCode, 404);

  await app.close();
  system.store.close();
});
