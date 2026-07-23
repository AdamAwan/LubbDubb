import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFlag, extractFlags, stripSentinels, stripFlags } from '../src/agents/sentinels.js';
import { PtySession } from '../src/pty/ptySession.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { StreamJsonSession, type Spawner, type StreamChild } from '../src/agents/streamJsonSession.js';
import { Store } from '../src/store/store.js';
import { buildApp } from '../src/server/app.js';
import { buildSystem } from '../src/system.js';
import { loadConfig } from '../src/config.js';

// -- pure protocol helpers ---------------------------------------------------

test('parseFlag accepts a bare ref and infers kind/label', () => {
  assert.deepEqual(parseFlag('./design.html'), { kind: 'artifact', label: 'design.html', ref: './design.html' });
});

test('parseFlag infers the "link" kind for an http(s) ref', () => {
  assert.deepEqual(parseFlag('https://example.test/r'), {
    kind: 'link',
    label: 'r',
    ref: 'https://example.test/r',
  });
});

test('parseFlag reads kind/label/ref out of a JSON payload', () => {
  assert.deepEqual(parseFlag('{"kind":"report","label":"Cost model","ref":"out/r.html"}'), {
    kind: 'report',
    label: 'Cost model',
    ref: 'out/r.html',
  });
});

test('parseFlag rejects empty, refless, and malformed-JSON payloads', () => {
  assert.equal(parseFlag('   '), null);
  assert.equal(parseFlag('{"kind":"report"}'), null);
  assert.equal(parseFlag('{not json'), null);
});

test('extractFlags returns every complete, boundary-guarded flag', () => {
  const flags = extractFlags('see @@LUBBDUBB_FLAG:./a.html@@ and @@LUBBDUBB_FLAG:{"ref":"b.md","kind":"doc"}@@');
  assert.deepEqual(flags, [
    { kind: 'artifact', label: 'a.html', ref: './a.html' },
    { kind: 'doc', label: 'b.md', ref: 'b.md' },
  ]);
});

test('extractFlags ignores an echoed prefix mid-token and an unterminated trailing fragment', () => {
  assert.deepEqual(extractFlags('x@@LUBBDUBB_FLAG:./a.html@@'), []); // no boundary before the prefix
  assert.deepEqual(extractFlags('@@LUBBDUBB_FLAG:./a.html'), []); // no closing suffix yet
});

test('stripSentinels removes a complete flag sentinel; stripFlags leaves a partial for the next chunk', () => {
  assert.equal(stripSentinels('here @@LUBBDUBB_FLAG:./a.html@@ done'), 'here  done');
  assert.equal(stripFlags('tail @@LUBBDUBB_FLAG:./a.h'), 'tail @@LUBBDUBB_FLAG:./a.h');
});

// -- PTY runtime -------------------------------------------------------------

test('PtySession emits a flag and strips the sentinel from output', () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp' });
  const out: string[] = [];
  const flags: unknown[] = [];
  session.on('output', (d: string) => out.push(d));
  session.on('flag', (f: unknown) => flags.push(f));
  session.start();
  backend.last().emit('drafted the design @@LUBBDUBB_FLAG:./design.html@@\n');
  assert.deepEqual(flags, [{ kind: 'artifact', label: 'design.html', ref: './design.html' }]);
  const joined = out.join('');
  assert.equal(joined.includes('@@LUBBDUBB_FLAG'), false);
  assert.equal(joined.includes('design.html'), false);
});

test('PtySession detects a flag split across two data chunks and emits it once', () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp' });
  const flags: unknown[] = [];
  session.on('flag', (f: unknown) => flags.push(f));
  session.start();
  backend.last().emit('see @@LUBBDUBB_FLAG:./de');
  backend.last().emit('sign.html@@\n');
  assert.deepEqual(flags, [{ kind: 'artifact', label: 'design.html', ref: './design.html' }]);
});

test('PtySession does not re-emit a flag as the tail window slides', () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp' });
  const flags: unknown[] = [];
  session.on('flag', (f: unknown) => flags.push(f));
  session.start();
  backend.last().emit('@@LUBBDUBB_FLAG:./a.html@@\n');
  backend.last().emit('more work happening here\n');
  backend.last().emit('and still more\n');
  assert.equal(flags.length, 1);
});

test('PtySession still finishes on a done sentinel arriving with a flag in the same chunk', () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp' });
  const flags: unknown[] = [];
  let done = false;
  session.on('flag', (f: unknown) => flags.push(f));
  session.on('done', () => (done = true));
  session.start();
  backend.last().emit('@@LUBBDUBB_FLAG:./out.html@@ all set @@LUBBDUBB_DONE@@');
  assert.equal(flags.length, 1);
  assert.equal(done, true);
});

// -- stream runtime ----------------------------------------------------------

class FakeChild extends EventEmitter implements StreamChild {
  pid = 4242;
  writes: string[] = [];
  private stdoutEmitter = new EventEmitter();
  stdout = {
    on: (ev: string, cb: (d: string) => void) => this.stdoutEmitter.on(ev, cb),
  } as unknown as NodeJS.ReadableStream;
  stderr = null;
  stdin = { write: (d: string) => this.writes.push(d), end: () => {} } as unknown as NodeJS.WritableStream;
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

test('StreamJsonSession emits a flag from an assistant event and strips it from output', () => {
  const child = new FakeChild();
  const spawner: Spawner = () => child;
  const s = new StreamJsonSession({ command: 'claude', args: [], cwd: '/tmp' }, spawner);
  const out: string[] = [];
  const flags: unknown[] = [];
  s.on('output', (d: string) => out.push(d));
  s.on('flag', (f: unknown) => flags.push(f));
  s.start();
  child.emitLine({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'design ready @@LUBBDUBB_FLAG:{"kind":"design","ref":"d.html"}@@' }] },
  });
  assert.deepEqual(flags, [{ kind: 'design', label: 'd.html', ref: 'd.html' }]);
  assert.equal(out.join('').includes('@@LUBBDUBB_FLAG'), false);
});

// -- store -------------------------------------------------------------------

test('Store.recordFlag dedupes by (agent, ref) and lists newest-first across agents', () => {
  const store = new Store(':memory:');
  const task = store.createTask({ kind: 'code', title: 't', prompt: 'p', branch: null, originRef: null });
  const a = store.createAgent({ taskId: task.id, cwd: '/tmp', pid: null });
  const b = store.createAgent({ taskId: task.id, cwd: '/tmp', pid: null });

  const first = store.recordFlag(a.id, { kind: 'artifact', label: 'design.html', ref: './design.html' });
  const refreshed = store.recordFlag(a.id, { kind: 'design', label: 'Design', ref: './design.html' });
  store.recordFlag(b.id, { kind: 'report', label: 'Report', ref: 'r.html' });

  // Same ref → same row id, updated fields; not a duplicate.
  assert.equal(refreshed.id, first.id);
  const aFlags = store.listFlags(a.id);
  assert.equal(aFlags.length, 1);
  assert.equal(aFlags[0]?.kind, 'design');
  assert.equal(aFlags[0]?.label, 'Design');

  assert.equal(store.listAllFlags().length, 2);
  store.close();
});

// -- server route + snapshot -------------------------------------------------

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    dbPath: ':memory:',
    dispatcher: 'rule',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
}

test('GET /api/agents/:id/artifact serves a confined file and refuses traversal', async () => {
  const system = buildSystem(testConfig(), { backend: new FakePtyBackend() });
  const { app } = await buildApp(system);
  const wt = mkdtempSync(join(tmpdir(), 'lubbdubb-wt-'));
  writeFileSync(join(wt, 'design.html'), '<h1>Design</h1>');

  const task = system.store.createTask({ kind: 'code', title: 't', prompt: 'p', branch: null, originRef: null });
  const agent = system.store.createAgent({ taskId: task.id, cwd: wt, pid: null });
  system.store.recordFlag(agent.id, { kind: 'design', label: 'design.html', ref: 'design.html' });

  const ok = await app.inject({ method: 'GET', url: `/api/agents/${agent.id}/artifact?ref=design.html` });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(ok.headers['content-security-policy'] as string, /sandbox/);
  assert.equal(ok.body, '<h1>Design</h1>');

  const escaped = await app.inject({ method: 'GET', url: `/api/agents/${agent.id}/artifact?ref=../../etc/passwd` });
  assert.equal(escaped.statusCode, 404);

  const url = await app.inject({ method: 'GET', url: `/api/agents/${agent.id}/artifact?ref=https://x.test/a` });
  assert.equal(url.statusCode, 400);

  // The snapshot carries the flag so the cockpit can render it.
  const snap = await (await app.inject({ method: 'GET', url: '/api/state' })).json();
  assert.equal(snap.flags.length, 1);
  assert.equal(snap.flags[0].ref, 'design.html');

  await app.close();
  system.store.close();
});
