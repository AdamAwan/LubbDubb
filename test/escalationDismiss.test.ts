import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import type { Spawner, StreamChild } from '../src/agents/streamJsonSession.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

class FakeChild extends EventEmitter implements StreamChild {
  pid = 555;
  writes: string[] = [];
  private out = new EventEmitter();
  stdout = { on: (ev: string, cb: (d: string) => void) => this.out.on(ev, cb) } as unknown as NodeJS.ReadableStream;
  stderr = null;
  stdin = { write: (d: string) => this.writes.push(d), end: () => {} } as unknown as NodeJS.WritableStream;
  emitLine(obj: unknown): void {
    this.out.emit('data', JSON.stringify(obj) + '\n');
  }
  override on(event: 'exit', cb: (code: number | null) => void): this {
    return super.on(event, cb);
  }
  kill(): void {
    this.emit('exit', 143);
  }
}

function streamConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-dismiss-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'stream',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    auth: { enabled: false } as never,
    ...overrides,
  });
}

async function parkedAgent() {
  const children: FakeChild[] = [];
  const spawner: Spawner = () => {
    const c = new FakeChild();
    children.push(c);
    return c;
  };
  const system = buildSystem(streamConfig(), {
    worktrees: new FakeWorktreeManager(),
    streamSpawner: spawner,
    errorMirror: () => {},
  });
  system.connector.inject({ kind: 'new_issue', number: 901, title: 'Add login' });
  await system.harness.runCycle('manual');
  const child = children[0]!;
  const agentId = system.store.listAgentsByStatus('starting', 'running')[0]!.id;

  child.emitLine({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '@@LUBBDUBB_WAITING:Which auth provider?@@' }] },
  });
  child.emitLine({ type: 'result', subtype: 'success' });
  assert.equal(system.store.getAgent(agentId)!.status, 'waiting');
  const escalation = system.store.listOpenEscalations()[0]!;
  return { system, child, agentId, escalation };
}

test('a parked agent that keeps calling tools is marked resumed — but stays parked, alert intact', async () => {
  const { system, child, agentId, escalation } = await parkedAgent();
  assert.equal(system.store.getAgent(agentId)!.resumedAt, null);

  child.emitLine({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'I will wait for your answer before continuing.' }] },
  });
  assert.equal(system.store.getAgent(agentId)!.resumedAt, null, 'prose alone must not read as resumed');

  child.emitLine({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] },
  });
  const agent = system.store.getAgent(agentId)!;
  assert.ok(agent.resumedAt, 'a tool call after the park stamps resumedAt');

  assert.equal(agent.status, 'waiting', 'the park is not lifted by the observation');
  assert.equal(system.store.listOpenEscalations().length, 1, 'the alert is left standing');
  assert.equal(system.store.getEscalation(escalation.id)!.status, 'open');

  system.store.close();
});

test('answering a question spends the resumed mark, and a fresh park does not inherit it', async () => {
  const { system, child, agentId, escalation } = await parkedAgent();
  child.emitLine({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }] },
  });
  assert.ok(system.store.getAgent(agentId)!.resumedAt);

  system.escalations.answer(escalation.id, 'Azure AD');
  assert.equal(system.store.getAgent(agentId)!.resumedAt, null, 'answered, so the mark is spent');

  child.emitLine({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '@@LUBBDUBB_WAITING:Which tenant?@@' }] },
  });
  child.emitLine({ type: 'result', subtype: 'success' });
  assert.equal(system.store.getAgent(agentId)!.resumedAt, null, 'a fresh park starts unmarked');

  system.store.close();
});

test('dismiss clears the alert, sends the agent nothing, and leaves it able to ask again', async () => {
  const { system, child, agentId, escalation } = await parkedAgent();
  const { app } = await buildApp(system);
  const before = child.writes.length;

  const res = await app.inject({
    method: 'POST',
    url: `/api/escalations/${escalation.id}/dismiss`,
    payload: { note: 'fixed it by hand' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().dismissedAs, 'cleared');

  const cleared = system.store.getEscalation(escalation.id)!;
  assert.equal(cleared.status, 'dismissed');
  assert.equal(system.store.listOpenEscalations().length, 0, 'inbox is empty');
  assert.equal(child.writes.length, before, 'nothing was typed into the agent');
  assert.match(JSON.stringify(cleared.context), /fixed it by hand/);
  assert.ok(
    system.store.listDecisions(20).some((d) => d.detail?.includes('dismissed escalation')),
    'the dismissal is audited like any other outcome',
  );

  const asked = system.agents.ask(agentId, { question: 'Actually, which tenant?' });
  assert.ok(asked.ok && asked.escalationId, 'a later question still reaches you');
  assert.equal(system.store.listOpenEscalations().length, 1);

  await app.close();
  system.store.close();
});

test('dismissing a proposal rejects it rather than leaving a pending verdict behind', async () => {
  const { system, escalation } = await parkedAgent();
  const { app } = await buildApp(system);
  const proposal = system.store.createProposal({
    kind: 'merge',
    ref: 'pr:42:merge',
    action: { type: 'merge_pr', prNumber: 42, method: 'squash', confidence: 0.9, reason: 'green' },
    escalationId: escalation.id,
  });

  const res = await app.inject({ method: 'POST', url: `/api/escalations/${escalation.id}/dismiss` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().dismissedAs, 'proposal_rejected');
  assert.equal(system.store.listProposals().find((p) => p.id === proposal.id)!.status, 'rejected');
  assert.equal(system.store.listOpenEscalations().length, 0);

  await app.close();
  system.store.close();
});
