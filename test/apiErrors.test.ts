import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import type { Spawner, StreamChild } from '../src/agents/streamJsonSession.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { ApiErrorsPayload } from '../src/wire.js';
import { failPlanningOpen } from './support/plans.js';

class FakeChild extends EventEmitter implements StreamChild {
  pid = 777;
  private out = new EventEmitter();
  stdout = { on: (ev: string, cb: (d: string) => void) => this.out.on(ev, cb) } as unknown as NodeJS.ReadableStream;
  stderr = null;
  stdin = { write: () => true, end: () => {} } as unknown as NodeJS.WritableStream;
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

const REFUSAL =
  "API Error: Opus 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup). " +
  "This sometimes happens with safe, normal conversations. Claude Code can't respond to this message with Opus 5.5.\n\n" +
  'Details: `[reasoning_extraction]`';

test('a refused turn on the stream is recorded and counted by /api/api-errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-api-errors-'));
  const children: FakeChild[] = [];
  const spawner: Spawner = () => {
    const c = new FakeChild();
    children.push(c);
    return c;
  };
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'stream',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
    }),
    { worktrees: new FakeWorktreeManager(), streamSpawner: spawner, errorMirror: () => {} },
  );
  system.connector.inject({ kind: 'new_issue', number: 902, title: 'Add logout' });
  failPlanningOpen(system.store, 902);
  await system.harness.runCycle('manual');
  const child = children[0]!;
  const agentId = system.store.agents.listAgentsByStatus('starting', 'running')[0]!.id;

  child.emitLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fine turn.' }] } });
  child.emitLine({ type: 'result', subtype: 'success', result: 'Fine turn.' });
  child.emitLine({ type: 'assistant', message: { content: [{ type: 'text', text: REFUSAL }] } });
  child.emitLine({ type: 'result', subtype: 'success', is_error: true, result: REFUSAL });

  const rows = system.store.apiErrors.listApiErrorsSince(new Date(0).toISOString());
  assert.equal(rows.length, 1, 'only the refused turn is recorded');
  assert.equal(rows[0]!.agentId, agentId);
  assert.equal(rows[0]!.kind, 'safeguards');
  assert.equal(rows[0]!.code, 'reasoning_extraction');
  assert.equal(rows[0]!.originRef, 'issue:902');

  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'GET', url: '/api/api-errors?window=all' });
  assert.equal(res.statusCode, 200);
  const { insights } = res.json() as ApiErrorsPayload;
  assert.equal(insights.total, 1);
  assert.equal(insights.agentsAffected, 1);
  assert.equal(insights.agentsStarted, 1);
  assert.equal(insights.affectedRate, 1);
  assert.deepEqual(insights.byCode, [{ key: 'reasoning_extraction', count: 1 }]);
  assert.deepEqual(insights.byKind, [{ key: 'safeguards', count: 1 }]);
  assert.equal(
    insights.byDay.reduce((n, d) => n + d.errors, 0),
    1,
  );
  await app.close();
});
