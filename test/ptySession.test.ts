import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PtySession } from '../src/pty/ptySession.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';

test('emits output deltas as they arrive', () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp' });
  const chunks: string[] = [];
  session.on('output', (d: string) => chunks.push(d));
  session.start();
  backend.last().emit('hello ');
  backend.last().emit('world');
  assert.deepEqual(chunks, ['hello ', 'world']);
});

test('done sentinel is stripped from output but still finishes the session', () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp' });
  const chunks: string[] = [];
  let done = false;
  session.on('output', (d: string) => chunks.push(d));
  session.on('done', () => (done = true));
  session.start();
  backend.last().emit('all finished @@LUBBDUBB_DONE@@');
  assert.equal(done, true);
  assert.equal(session.status, 'done');
  const out = chunks.join('');
  assert.equal(out.includes('@@LUBBDUBB_DONE@@'), false);
  assert.equal(out, 'all finished ');
});

test('waiting sentinel is stripped from output while waiting fires with the reason', () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp' });
  const chunks: string[] = [];
  let reason: string | null = null;
  session.on('output', (d: string) => chunks.push(d));
  session.on('waiting', (r: string) => (reason = r));
  session.start();
  backend.last().emit('working...\n@@LUBBDUBB_WAITING:need a decision@@\n');
  assert.equal(session.status, 'waiting');
  assert.equal(reason, 'need a decision');
  const out = chunks.join('');
  assert.equal(out.includes('@@LUBBDUBB_WAITING:'), false);
  assert.equal(out.includes('need a decision'), false);
  assert.equal(out.includes('@@'), false);
  assert.equal(out, 'working...\n\n');
});

test('a sentinel wait is latched: TUI repaint after the sentinel must not un-park it', () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp', submitDelayMs: 0 });
  const statuses: string[] = [];
  session.on('status', (s: string) => statuses.push(s));
  session.start();

  backend.last().emit('  @@LUBBDUBB_WAITING:need a decision@@  \r\n');
  assert.equal(session.status, 'waiting');

  backend.last().emit('\x1b[2J\x1b[H' + 'x'.repeat(5000) + '\r\n');
  backend.last().emit('\x1b[38;5;8m* idle spinner *\x1b[0m\r\n');
  assert.equal(session.status, 'waiting', 'must remain parked despite TUI repaint noise');

  session.send('go with A');
  assert.equal(session.status, 'running');
  assert.deepEqual(statuses, ['running', 'waiting', 'running']);
});

test('answering a waiting session does not re-park off the stale sentinel left in the tail', () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp', submitDelayMs: 0 });
  const waits: string[] = [];
  session.on('waiting', (r: string) => waits.push(r));
  session.start();

  backend.last().emit('working...\n@@LUBBDUBB_WAITING:need a decision@@\n');
  assert.equal(session.status, 'waiting');
  assert.deepEqual(waits, ['need a decision']);

  session.send('go with A');
  assert.equal(session.status, 'running');

  backend.last().emit('Great, proceeding with A.\r\n');

  assert.equal(session.status, 'running', 'stale waiting sentinel must not re-park after an answer');
  assert.deepEqual(waits, ['need a decision'], 'waiting must fire exactly once, not re-fire off the tail');
});

test('sendRaw writes bytes verbatim with no carriage return appended', () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp' });
  session.start();
  session.sendRaw('\x03');
  assert.equal(backend.last().writes.at(-1), '\x03');
});

test('detects a waiting sentinel and extracts the reason', () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp' });
  let reason: string | null = null;
  session.on('waiting', (r: string) => (reason = r));
  session.start();
  backend.last().emit('working...\n@@LUBBDUBB_WAITING:need a decision@@\n');
  assert.equal(session.status, 'waiting');
  assert.equal(reason, 'need a decision');
});

test('done sentinel hugged by SGR styling (no whitespace either side) still finishes', () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp' });
  let done = false;
  session.on('done', () => (done = true));
  session.start();
  backend.last().emit('\x1b[1m@@LUBBDUBB_DONE@@\x1b[0m\r\n');
  assert.equal(done, true);
  assert.equal(session.status, 'done');
});

test('waiting sentinel hugged by SGR styling still parks with a clean reason', () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp' });
  let reason: string | null = null;
  session.on('waiting', (r: string) => (reason = r));
  session.start();
  backend.last().emit('\x1b[38;5;8m@@LUBBDUBB_WAITING:plan review@@\x1b[0m\r\n');
  assert.equal(session.status, 'waiting');
  assert.equal(reason, 'plan review');
});

test('waiting sentinel split across two chunks still detected', () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp' });
  let reason: string | null = null;
  session.on('waiting', (r: string) => (reason = r));
  session.start();
  backend.last().emit('@@LUBBDUBB_WAI');
  backend.last().emit('TING:split reason@@');
  assert.equal(reason, 'split reason');
});

test('done sentinel finishes the session', () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp' });
  let done = false;
  session.on('done', () => (done = true));
  session.start();
  backend.last().emit('all finished @@LUBBDUBB_DONE@@');
  assert.equal(done, true);
  assert.equal(session.status, 'done');
});

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const pasted = (text: string): string => `${PASTE_START}${text}${PASTE_END}`;

test('send un-parks a waiting session and submits with a separate carriage return', async () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp', submitDelayMs: 5 });
  session.start();
  backend.last().emit('@@LUBBDUBB_WAITING:go?@@');
  assert.equal(session.status, 'waiting');
  session.send('yes');
  assert.equal(session.status, 'running');
  assert.equal(backend.last().writes.at(-1), pasted('yes'));
  await new Promise((r) => setTimeout(r, 15));
  assert.deepEqual(backend.last().writes, [pasted('yes'), '\r']);
});

test('send strips a trailing newline from the payload so the CR alone submits', async () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp', submitDelayMs: 0 });
  session.start();
  session.send('line1\nline2\n');
  assert.deepEqual(backend.last().writes, [pasted('line1\nline2'), '\r']);
});

test('submitDelayMs 0 writes the payload and CR synchronously', () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp', submitDelayMs: 0 });
  session.start();
  session.send('go');
  assert.deepEqual(backend.last().writes, [pasted('go'), '\r']);
});

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('a sentinel wait is latched, so later output does not un-park it', async () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp', submitDelayMs: 0 });
  const reasons: string[] = [];
  session.on('waiting', (r: string) => reasons.push(r));
  session.start();
  backend.last().emit('@@LUBBDUBB_WAITING:need a decision@@');
  assert.equal(session.status, 'waiting');
  backend.last().emit('still here');
  await tick(20);
  assert.equal(session.status, 'waiting');
  assert.deepEqual(reasons, ['need a decision'], 'and it is announced once');
});

test('clean exit with no sentinel still counts as done', () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp' });
  let done = false;
  session.on('done', () => (done = true));
  session.start();
  backend.last().emitExit(0);
  assert.equal(done, true);
});

test('non-zero exit is a failure', () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp' });
  let failed = false;
  session.on('failed', () => (failed = true));
  session.start();
  backend.last().emitExit(1);
  assert.equal(failed, true);
  assert.equal(session.status, 'failed');
});

test('kill marks the session killed even when the exit fires synchronously', () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp' });
  let failed = false;
  session.on('failed', () => (failed = true));
  session.start();
  session.kill();
  assert.equal(session.status, 'killed');
  assert.equal(failed, false, 'kill must not emit a failure');
});
