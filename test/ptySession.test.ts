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
  // Regression: the interactive claude TUI keeps repainting after a turn. That
  // post-sentinel output eventually scrolls the waiting sentinel out of the 4096-
  // byte detection tail; the next chunk then finds no sentinel and the "any output
  // while parked → running" reset used to silently un-park a real human wait, so
  // the agent reverted to 'running' and no escalation stuck. It must stay waiting.
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp', submitDelayMs: 0 });
  const statuses: string[] = [];
  session.on('status', (s: string) => statuses.push(s));
  session.start();

  backend.last().emit('  @@LUBBDUBB_WAITING:need a decision@@  \r\n');
  assert.equal(session.status, 'waiting');

  // A full repaint larger than TAIL_WINDOW (4096) evicts the sentinel from the tail…
  backend.last().emit('\x1b[2J\x1b[H' + 'x'.repeat(5000) + '\r\n');
  // …and a following idle frame carries no sentinel — this is where it used to flip.
  backend.last().emit('\x1b[38;5;8m* idle spinner *\x1b[0m\r\n');
  assert.equal(session.status, 'waiting', 'must remain parked despite TUI repaint noise');

  // The human answering is what releases the latch and resumes the agent.
  session.send('go with A');
  assert.equal(session.status, 'running');
  assert.deepEqual(statuses, ['running', 'waiting', 'running']);
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

// A payload is framed as an explicit bracketed paste (ESC[200~ … ESC[201~) so the
// claude TUI closes the paste at the end marker and the submitting CR that follows
// can never be folded into it as a literal newline (the "text sits unsubmitted" bug).
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
  // The bracketed-paste payload is written on its own; the submitting CR follows
  // separately once the paste is closed, so the TUI never folds it into the paste.
  assert.equal(backend.last().writes.at(-1), pasted('yes'));
  await new Promise((r) => setTimeout(r, 15));
  assert.deepEqual(backend.last().writes, [pasted('yes'), '\r']);
});

test('send strips a trailing newline from the payload so the CR alone submits', async () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp', submitDelayMs: 0 });
  session.start();
  session.send('line1\nline2\n');
  // Internal newlines are preserved inside the paste; only the trailing one is dropped.
  assert.deepEqual(backend.last().writes, [pasted('line1\nline2'), '\r']);
});

test('submitDelayMs 0 writes the payload and CR synchronously', () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp', submitDelayMs: 0 });
  session.start();
  session.send('go');
  assert.deepEqual(backend.last().writes, [pasted('go'), '\r']);
});

test('deliverInitial pastes once, then re-sends only the Enter while the REPL boots', async () => {
  // The initial-message boot race: a freshly-spawned claude REPL echoes the pasted
  // prompt into its input box but drops the submitting Enter for ~1-2s while it
  // finishes initialising. deliverInitial pastes ONCE (so the prompt can't be
  // duplicated in the box) and re-sends the bare Enter until the turn starts.
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, {
    command: 'x',
    args: [],
    cwd: '/tmp',
    submitDelayMs: 0,
    initialSubmitIntervalMs: 5,
    initialSubmitAttempts: 4,
  });
  session.start();
  session.deliverInitial('do the task');
  // The message is delivered as one bracketed paste plus its submitting CR.
  assert.deepEqual(backend.last().writes, [pasted('do the task'), '\r']);
  // While the REPL stays silently 'running', the Enter is re-sent — as bare CRs,
  // never another paste (a re-paste would accumulate the prompt in the box).
  await new Promise((r) => setTimeout(r, 40));
  const writes = backend.last().writes;
  assert.equal(writes.filter((w) => w.startsWith(PASTE_START)).length, 1, 'the prompt is pasted exactly once');
  assert.ok(writes.length > 2, 'the Enter is re-sent while the REPL is not yet accepting it');
  assert.ok(
    writes.slice(1).every((w) => w === '\r'),
    'every retry is a bare CR',
  );
  // Bounded: the paste, its submitting CR, and at most `initialSubmitAttempts` re-sends.
  assert.ok(writes.length <= 1 + 1 + 4, 'retries are capped');
});

test('deliverInitial stops re-sending the Enter once the agent progresses', async () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, {
    command: 'x',
    args: [],
    cwd: '/tmp',
    submitDelayMs: 0,
    initialSubmitIntervalMs: 5,
    initialSubmitAttempts: 50,
  });
  session.start();
  session.deliverInitial('do the task');
  // The turn starts and the agent parks on a question: status leaves 'running'.
  backend.last().emit('@@LUBBDUBB_WAITING:need a decision@@');
  assert.equal(session.status, 'waiting');
  const countAtWait = backend.last().writes.length;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(backend.last().writes.length, countAtWait, 'no more Enters are sent once it left running');
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
  // FakePtyProcess.kill() emits a non-zero exit synchronously; the session must
  // recognise it as a kill, not misfire a spurious 'failed'.
  session.kill();
  assert.equal(session.status, 'killed');
  assert.equal(failed, false, 'kill must not emit a failure');
});
