import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { StreamJsonSession, type Spawner, type StreamChild } from '../src/agents/streamJsonSession.js';

/** A controllable fake claude process speaking stream-JSON. */
class FakeChild extends EventEmitter implements StreamChild {
  pid = 4242;
  writes: string[] = [];
  killed = false;
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
    this.killed = true;
    this.emit('exit', 143);
  }
}

function fakeSpawner(): { spawner: Spawner; child: FakeChild } {
  const child = new FakeChild();
  const spawner: Spawner = () => child;
  return { spawner, child };
}

function assistant(text: string) {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}
const result = { type: 'result', subtype: 'success' };

test('emits assistant text as output', () => {
  const { spawner, child } = fakeSpawner();
  const s = new StreamJsonSession({ command: 'claude', args: [], cwd: '/tmp' }, spawner);
  const out: string[] = [];
  s.on('output', (d: string) => out.push(d));
  s.start();
  child.emitLine(assistant('Hello there'));
  assert.deepEqual(out, ['Hello there']);
});

test('DONE sentinel at turn end finishes the session', () => {
  const { spawner, child } = fakeSpawner();
  const s = new StreamJsonSession({ command: 'claude', args: [], cwd: '/tmp' }, spawner);
  let done = false;
  s.on('done', () => (done = true));
  s.start();
  child.emitLine(assistant('all set @@LUBBDUBB_DONE@@'));
  child.emitLine(result);
  assert.equal(done, true);
  assert.equal(s.status, 'done');
});

test('WAITING sentinel at turn end parks the session with the reason', () => {
  const { spawner, child } = fakeSpawner();
  const s = new StreamJsonSession({ command: 'claude', args: [], cwd: '/tmp' }, spawner);
  let reason: string | null = null;
  s.on('waiting', (r: string) => (reason = r));
  s.start();
  child.emitLine(assistant('Which DB? @@LUBBDUBB_WAITING:Postgres or MySQL?@@'));
  child.emitLine(result);
  assert.equal(s.status, 'waiting');
  assert.equal(reason, 'Postgres or MySQL?');
});

test('a turn ending with no sentinel is treated as waiting', () => {
  const { spawner, child } = fakeSpawner();
  const s = new StreamJsonSession({ command: 'claude', args: [], cwd: '/tmp' }, spawner);
  let waited = false;
  s.on('waiting', () => (waited = true));
  s.start();
  child.emitLine(assistant('I did some stuff.'));
  child.emitLine(result);
  assert.equal(waited, true);
});

test('send writes a JSON user message and un-parks', () => {
  const { spawner, child } = fakeSpawner();
  const s = new StreamJsonSession({ command: 'claude', args: [], cwd: '/tmp' }, spawner);
  s.start();
  child.emitLine(assistant('@@LUBBDUBB_WAITING:go?@@'));
  child.emitLine(result);
  assert.equal(s.status, 'waiting');
  s.send('yes, proceed');
  assert.equal(s.status, 'running');
  const sent = JSON.parse(child.writes.at(-1)!.trim());
  assert.equal(sent.type, 'user');
  assert.equal(sent.message.content, 'yes, proceed');
});

test('multi-turn: WAITING then answer then DONE', () => {
  const { spawner, child } = fakeSpawner();
  const s = new StreamJsonSession({ command: 'claude', args: [], cwd: '/tmp' }, spawner);
  const statuses: string[] = [];
  s.on('status', (st: string) => statuses.push(st));
  s.start();
  child.emitLine(assistant('@@LUBBDUBB_WAITING:lang?@@'));
  child.emitLine(result);
  s.send('typescript');
  child.emitLine(assistant('done now @@LUBBDUBB_DONE@@'));
  child.emitLine(result);
  assert.equal(s.status, 'done');
  assert.deepEqual(statuses, ['running', 'waiting', 'running', 'done']);
});

test('non-zero exit without done is a failure', () => {
  const { spawner, child } = fakeSpawner();
  const s = new StreamJsonSession({ command: 'claude', args: [], cwd: '/tmp' }, spawner);
  let failed = false;
  s.on('failed', () => (failed = true));
  s.start();
  child.emit('exit', 1);
  assert.equal(failed, true);
  assert.equal(s.status, 'failed');
});
