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

test('answering a waiting session does not re-park off the stale sentinel left in the tail', () => {
  // Regression: the consumed waiting sentinel stayed in the retained detection tail
  // (stripFlags removes only flags). The `sentinelWaiting` latch suppresses re-emit
  // only *while parked*; once the human answered (send un-parks → running) the next
  // output chunk re-scanned the tail, re-found the still-present sentinel, and fired a
  // SECOND 'waiting' — which spawned a duplicate, never-cleared escalation and left the
  // ⏳ banner stuck on the finished card. Answering must clear the stale sentinel.
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp', submitDelayMs: 0 });
  const waits: string[] = [];
  session.on('waiting', (r: string) => waits.push(r));
  session.start();

  backend.last().emit('working...\n@@LUBBDUBB_WAITING:need a decision@@\n');
  assert.equal(session.status, 'waiting');
  assert.deepEqual(waits, ['need a decision']);

  // The human answers — the session un-parks.
  session.send('go with A');
  assert.equal(session.status, 'running');

  // The agent continues; a normal echo/repaint chunk arrives carrying NO new sentinel,
  // but the just-answered one is still sitting in the small tail.
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
  // The interactive claude TUI styles the assistant line, so the sentinel arrives
  // flanked by SGR escapes — `…m` right before, ESC right after — not whitespace.
  // The two-sided boundary guard used to reject it (`m`/`\x1b` aren't boundaries),
  // so a real finish was silently never detected even though display-stripping
  // (which has no such guard) still removed the tag. Detection must ignore the
  // escape noise the same way the strip path does.
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
  // Wait out every scheduled attempt plus slack, so the cap below is asserted
  // against a settled write log rather than whatever the timer got through in
  // time (that race made this assertion pass only on a slow enough machine).
  await new Promise((r) => setTimeout(r, 5 * 4 + 60));
  const writes = backend.last().writes;
  assert.equal(writes.filter((w) => w.startsWith(PASTE_START)).length, 1, 'the prompt is pasted exactly once');
  assert.ok(writes.length > 2, 'the Enter is re-sent while the REPL is not yet accepting it');
  assert.ok(
    writes.slice(1).every((w) => w === '\r'),
    'every retry is a bare CR',
  );
  // Bounded: the paste, its submitting CR, then at most `initialSubmitAttempts` re-sends.
  assert.ok(writes.length <= 2 + 4, `retries are capped, got ${writes.length}`);
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

// -- idle safety net ---------------------------------------------------------

const idleOpts = { command: 'x', args: [], cwd: '/tmp', idleWaitMs: 30, submitDelayMs: 0 };
const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('a turn that ends without a sentinel parks the session once the terminal goes quiet', async () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, idleOpts);
  let reason: string | null = null;
  session.on('waiting', (r: string) => (reason = r));
  session.start();
  // The real failure: the agent asks for review in prose and stops.
  backend.last().emit('Please review reports/x.md and confirm it is accurate.\r\n');
  assert.equal(session.status, 'running', 'still running while output is fresh');
  await tick(60);
  assert.equal(session.status, 'waiting');
  assert.match(reason ?? '', /without signalling/);
});

test('ongoing output keeps pushing the idle countdown back', async () => {
  const backend = new FakePtyBackend();
  // A roomier window than the other cases: this one asserts the timer has *not*
  // fired yet, so the gap between chunks must stay clear of it even when the
  // whole suite is competing for the event loop.
  const session = new PtySession(backend, { ...idleOpts, idleWaitMs: 500 });
  session.start();
  for (let i = 0; i < 4; i++) {
    backend.last().emit(`✳ Thinking… (${i}s · esc to interrupt)`);
    await tick(50); // each chunk re-arms well before the window elapses
    assert.equal(session.status, 'running', 'a working agent is never parked');
  }
  await tick(700);
  assert.equal(session.status, 'waiting');
});

test('an idle park is not latched — the agent resuming on its own un-parks it', async () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, idleOpts);
  session.start();
  backend.last().emit('thinking hard');
  await tick(60);
  assert.equal(session.status, 'waiting');
  // Unlike a sentinel wait, this is an inference: fresh output means it was busy.
  backend.last().emit('...and here is the answer');
  assert.equal(session.status, 'running');
});

test('a sentinel wait outranks the idle net (no duplicate park, latch intact)', async () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, idleOpts);
  const reasons: string[] = [];
  session.on('waiting', (r: string) => reasons.push(r));
  session.start();
  backend.last().emit('@@LUBBDUBB_WAITING:need a decision@@');
  await tick(60);
  assert.deepEqual(reasons, ['need a decision'], 'the idle timer must not re-park an already-parked session');
  // The TUI repaints while parked; the latch (not the idle net) holds the wait.
  backend.last().emit('idle repaint');
  assert.equal(session.status, 'waiting');
});

test('a dropped submitting Enter is re-surfaced: an answer that never lands parks again', async () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, idleOpts);
  const reasons: string[] = [];
  session.on('waiting', (r: string) => reasons.push(r));
  session.start();
  backend.last().emit('@@LUBBDUBB_WAITING:need a decision@@');
  session.send('go ahead');
  assert.equal(session.status, 'running', 'the answer un-parks it');
  // The TUI never echoes anything back — the Enter was swallowed, the text is
  // sitting unsent in the input box. Silence must not be mistaken for progress.
  await tick(60);
  assert.equal(session.status, 'waiting');
  assert.equal(reasons.length, 2);
});

test('idleWaitMs 0 disables the net entirely (raw/mock sessions)', async () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp' });
  session.start();
  backend.last().emit('quiet output');
  await tick(60);
  assert.equal(session.status, 'running');
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
