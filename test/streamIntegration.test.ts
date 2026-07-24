import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import type { Spawner, StreamChild } from '../src/agents/streamJsonSession.js';

/** Fake claude stream-JSON process, shared across the harness wiring. */
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

function streamConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-stream-int-'));
  return loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    dispatcher: 'rule',
    agentMode: 'stream',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
  });
}

test('stream-mode: persisted transcript is clean and structured (no leaked sentinels, tools labelled)', async () => {
  const children: FakeChild[] = [];
  const spawner: Spawner = () => {
    const c = new FakeChild();
    children.push(c);
    return c;
  };
  const system = buildSystem(streamConfig(), { streamSpawner: spawner });

  system.connector.inject({ kind: 'new_story', title: 'Add login', wafPillars: ['Reliability'] });
  await system.harness.runCycle('manual');
  const child = children[0]!;
  const agentId = system.store.listAgentsByStatus('starting', 'running')[0]!.id;

  child.emitLine({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Listing the files.' },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls src' } },
      ],
    },
  });
  child.emitLine({ type: 'user', message: { content: [{ type: 'tool_result', content: 'config.ts\nsystem.ts' }] } });
  child.emitLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'All done.\n@@LUBBDUBB_DONE@@' }] } });
  child.emitLine({ type: 'result', subtype: 'success' });

  assert.equal(system.store.getAgent(agentId)!.status, 'done');
  const transcript = system.store.getTranscript(agentId);
  assert.ok(!transcript.includes('@@LUBBDUBB_DONE@@'), 'no leaked sentinel in the persisted transcript');
  assert.ok(transcript.includes('Listing the files.'), 'assistant prose present');
  assert.ok(transcript.includes('Bash') && transcript.includes('ls src'), 'tool call labelled');
  assert.ok(transcript.includes('config.ts'), 'tool result shown');
  assert.ok(transcript.includes('All done.'), 'closing prose present');

  system.store.close();
});

test('stream-mode: task typed in, WAITING escalates, answer continues, DONE completes', async () => {
  const children: FakeChild[] = [];
  const spawner: Spawner = () => {
    const c = new FakeChild();
    children.push(c);
    return c;
  };
  const system = buildSystem(streamConfig(), { streamSpawner: spawner });

  system.connector.inject({ kind: 'new_story', title: 'Add login', wafPillars: ['Reliability'] });
  await system.harness.runCycle('manual');

  // One agent launched; the task was sent to it as a JSON user message.
  assert.equal(children.length, 1);
  const child = children[0]!;
  const firstMsg = JSON.parse(child.writes[0]!.trim());
  assert.equal(firstMsg.type, 'user');
  assert.match(firstMsg.message.content, /missing/);

  const agentId = system.store.listAgentsByStatus('starting', 'running')[0]!.id;

  // Agent asks for a decision and ends its turn -> escalation.
  child.emitLine({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '@@LUBBDUBB_WAITING:Which auth provider?@@' }] },
  });
  child.emitLine({ type: 'result', subtype: 'success' });
  assert.equal(system.store.getAgent(agentId)!.status, 'waiting');
  const esc = system.store.listOpenEscalations()[0]!;
  assert.equal(esc.agentId, agentId);

  // Human answers -> delivered as the next user message.
  const res = system.escalations.answer(esc.id, 'Azure AD');
  assert.equal(res.routing, 'typed_into_agent');
  assert.match(child.writes.at(-1)!, /Azure AD/);

  // Agent finishes.
  child.emitLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'done @@LUBBDUBB_DONE@@' }] } });
  child.emitLine({ type: 'result', subtype: 'success' });
  assert.equal(system.store.getAgent(agentId)!.status, 'done');
  assert.equal(system.store.getTask(system.store.getAgent(agentId)!.taskId)!.status, 'done');

  system.store.close();
});
