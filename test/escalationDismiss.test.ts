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
import { parseSessionEntries } from '../src/agents/sessionTranscript.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

/**
 * Two halves of one problem (the "stale alert" issue): an agent parks, the thing
 * is dealt with outside the harness, and the alert has no way to leave the inbox
 * except by typing a message nobody wanted sent.
 *
 * The park is only ever a *request* — the `escalate` tool returns at once — so the
 * harness can often see for itself that the agent carried on. That is `resumedAt`,
 * and it only ever marks the item; clearing it stays the operator's click.
 */

/** Fake claude stream-JSON process (same shape the stream integration tests drive). */
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
    labelPrefix: '',
    dbPath: ':memory:',
    dispatcher: 'rule',
    agentMode: 'stream',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    auth: { enabled: false } as never,
    ...overrides,
  });
}

/** Boot a stream-mode system with one agent parked on a question. */
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

  // Prose after the park is NOT the signal: an agent explaining that it is waiting
  // is still waiting, and reading that as work would clear alerts that need answers.
  child.emitLine({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'I will wait for your answer before continuing.' }] },
  });
  assert.equal(system.store.getAgent(agentId)!.resumedAt, null, 'prose alone must not read as resumed');

  // A tool call is the agent *doing* something.
  child.emitLine({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] },
  });
  const agent = system.store.getAgent(agentId)!;
  assert.ok(agent.resumedAt, 'a tool call after the park stamps resumedAt');

  // Marked, never cleared: only the human knows whether the question still matters.
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

  // A second question is a new question: last park's evidence must not arrive with it
  // already looking stale.
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
  // The whole point: no pointless message.
  assert.equal(child.writes.length, before, 'nothing was typed into the agent');
  // And the reason is recorded rather than lost.
  assert.match(JSON.stringify(cleared.context), /fixed it by hand/);
  assert.ok(
    system.store.listDecisions(20).some((d) => d.detail?.includes('dismissed escalation')),
    'the dismissal is audited like any other outcome',
  );

  // Load-bearing: the park latch is what makes `handleWaiting` a no-op, so an agent
  // whose alert was dismissed must not be left unable to raise another one. Asked
  // through `escalate` (i.e. `agents.ask`) because that is the live path — the agent
  // is mid-turn, which is exactly why its first alert went stale.
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
  // A dropped inbox row with the proposal still pending would hold rule `pr-merge-ready` off that
  // PR for good — the wedge this arm exists to avoid.
  assert.equal(system.store.listProposals().find((p) => p.id === proposal.id)!.status, 'rejected');
  assert.equal(system.store.listOpenEscalations().length, 0);

  await app.close();
  system.store.close();
});

test('the PTY transcript counts tool calls, so a parked session has proof of work the screen cannot give', () => {
  // The PTY runtime must never read `activity` off raw output: the TUI repaints
  // while a session sits parked, which is why the sentinel park is latched there.
  // The session file is the one source that can say the agent *did* something.
  const batch = parseSessionEntries([
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
    }),
  ]);
  assert.equal(batch.toolUses, 1);
  assert.equal(parseSessionEntries([JSON.stringify({ type: 'assistant', message: { content: [] } })]).toolUses, 0);
});
