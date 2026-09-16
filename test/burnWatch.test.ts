import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system.js';
import type { Spawner, StreamChild } from '../src/agents/streamJsonSession.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { failPlanningOpen } from './support/plans.js';

// → docs/spec/18-observability.md#the-burn-watch

const PROFILES = {
  fast: { model: 'haiku', rank: 1, description: 'mechanical work' },
  deep: { model: 'opus', rank: 2, description: 'work nobody can see' },
} as const;

class FakeChild extends EventEmitter implements StreamChild {
  pid = 4242;
  private stdoutEmitter = new EventEmitter();
  stdout = {
    on: (ev: string, cb: (d: string) => void) => this.stdoutEmitter.on(ev, cb),
  } as unknown as NodeJS.ReadableStream;
  stderr = null;
  stdin = { write: () => {}, end: () => {} } as unknown as NodeJS.WritableStream;
  emitLine(obj: unknown): void {
    this.stdoutEmitter.emit('data', JSON.stringify(obj) + '\n');
  }
  override on(event: 'exit', cb: (code: number | null) => void): this {
    return super.on(event, cb);
  }
  kill(): void {
    this.emit('exit', 143);
  }
}

function burnConfig(spendBurn: Partial<Config['spendBurn']>): Config {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-burn-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'stream',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    auth: { enabled: false } as never,
    agentModels: { profiles: PROFILES, default: 'fast' },
    spendBurn: { ...spendBurn } as Config['spendBurn'],
  });
}

async function onFast(spendBurn: Partial<Config['spendBurn']>): Promise<{ system: System; child: FakeChild }> {
  const child = new FakeChild();
  const spawner: Spawner = () => child;
  const system = buildSystem(burnConfig(spendBurn), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: spawner,
    errorMirror: () => {},
  });
  system.connector.inject({ kind: 'new_issue', number: 7, title: 'Add login' });
  failPlanningOpen(system.store, 7);
  await system.harness.runCycle('manual');
  return { system, child };
}

function liveAgent(system: System) {
  const agent = system.store.agents.listAgentsByStatus('starting', 'running')[0];
  assert.ok(agent, 'a stream agent should be live');
  return agent!;
}

function toolUse(child: FakeChild, name: string): void {
  child.emitLine({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, input: {} }] },
  });
}

test('a step is counted as it happens, with no turn having ended', async () => {
  const { system, child } = await onFast({ ceilingSteps: 500 });
  const agent = liveAgent(system);
  assert.equal(system.store.agents.getAgent(agent.id)!.steps, null, 'a run that has done nothing has no reading');

  toolUse(child, 'Bash');
  toolUse(child, 'Edit');
  toolUse(child, 'Bash');

  const after = system.store.agents.getAgent(agent.id)!;
  assert.equal(after.steps, 3, 'three tool calls, counted without waiting for the turn to close');
  assert.equal(after.costUsd, null, 'and no `result` event has landed, so spend still says nothing at all');
  system.store.close();
});

test('a run going round in circles inside one turn is flagged, and the notice offers the rung above it', async () => {
  const { system, child } = await onFast({ ceilingSteps: 3, ceilingMinutes: null });
  const agent = liveAgent(system);
  for (let i = 0; i < 4; i += 1) toolUse(child, 'Bash');

  await system.harness.runCycle('manual');

  const filed = system.store.humanTasks.listHumanTasksOfKind('burn');
  assert.equal(filed.length, 1, 'one notice, about one agent');
  const notice = filed[0]!;
  assert.equal(notice.agentId, agent.id);
  assert.equal(notice.status, 'open');
  assert.doesNotMatch(notice.title, /\d/, 'the title is the dedup key and carries no figure');
  assert.match(notice.detail ?? '', /4 steps/);
  assert.match(notice.detail ?? '', /per-run step ceiling/);
  assert.match(notice.detail ?? '', /\*\*deep\*\* sits above it/, 'the operator is told what to lift it to');
  system.store.close();
});

test('the notice refreshes in place rather than filing a second row every pulse', async () => {
  const { system, child } = await onFast({ ceilingSteps: 3, ceilingMinutes: null });
  for (let i = 0; i < 4; i += 1) toolUse(child, 'Bash');
  await system.harness.runCycle('manual');

  toolUse(child, 'Bash');
  await system.harness.runCycle('manual');

  const filed = system.store.humanTasks.listHumanTasksOfKind('burn');
  assert.equal(filed.length, 1, 'still one row');
  assert.match(filed[0]!.detail ?? '', /5 steps/, 'carrying the figure that is true now');
  system.store.close();
});
