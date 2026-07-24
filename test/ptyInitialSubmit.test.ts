import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PtySession } from '../src/pty/ptySession.js';
import { FakePtyBackend, type FakePtyProcess } from '../src/pty/fakeBackend.js';

// The initial-message boot race, closed-loop edition: instead of nudging the
// submitting Enter on a blind timer, a legible-mode session reads its headless
// emulator's input box and stops re-sending the moment the box clears (the REPL
// accepted the paste). The FakePtyBackend doesn't emulate a TUI, so these tests
// render an input box *by hand* — box-drawing rows through the mirror — to drive
// the two observable states: "box still holds the pasted prompt" (unsent) and
// "box empty" (accepted).

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const PASTE_START = '\x1b[200~';

/** Render the REPL's input box holding `content` (empty string = the cleared, accepted state). */
const emitBox = (proc: FakePtyProcess, content: string): void => {
  proc.emit(`\r\n╭────────────────────────╮\r\n│ > ${content}\r\n╰────────────────────────╯\r\n`);
};

const crCount = (proc: FakePtyProcess): number => proc.writes.filter((w) => w === '\r').length;

test('deliverInitial stops re-sending the Enter once the input box clears', async () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, {
    command: 'x',
    args: [],
    cwd: '/tmp',
    submitDelayMs: 0,
    initialSubmitIntervalMs: 10,
    initialSubmitAttempts: 20,
    legibleTranscript: true,
    transcriptDebounceMs: 5,
  });
  session.start();
  session.deliverInitial('do the task');
  // The REPL echoes the paste into its input box but hasn't accepted the Enter yet.
  emitBox(backend.last(), 'do the task');
  // Nudges fire while the box still holds the prompt.
  await tick(45);
  const midCrs = crCount(backend.last());
  assert.ok(midCrs > 1, 'the Enter is re-sent while the box still holds the prompt');
  // The REPL accepts the message: the box empties. The paste is never re-sent.
  emitBox(backend.last(), '');
  await tick(60);
  const afterClear = crCount(backend.last());
  await tick(80); // well over the cap's remaining budget — proves the loop closed, not merely paused
  assert.equal(crCount(backend.last()), afterClear, 'no more Enters once the box cleared');
  assert.ok(afterClear < 20, `stopped before the attempt cap, sent ${afterClear} CRs`);
  assert.equal(
    backend.last().writes.filter((w) => w.startsWith(PASTE_START)).length,
    1,
    'the prompt is pasted exactly once',
  );
});

test('deliverInitial (legible) stops re-sending once the agent progresses off running', async () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, {
    command: 'x',
    args: [],
    cwd: '/tmp',
    submitDelayMs: 0,
    initialSubmitIntervalMs: 10,
    initialSubmitAttempts: 50,
    legibleTranscript: true,
    transcriptDebounceMs: 5,
  });
  session.start();
  session.deliverInitial('do the task');
  emitBox(backend.last(), 'do the task'); // box never clears in this test
  await tick(25);
  // The turn starts and the agent parks on a question — status leaves 'running'.
  backend.last().emit('@@LUBBDUBB_WAITING:need a decision@@');
  assert.equal(session.status, 'waiting');
  const countAtWait = backend.last().writes.length;
  await tick(60);
  assert.equal(backend.last().writes.length, countAtWait, 'no more Enters once it left running');
});

test('deliverInitial (legible) caps a box that never clears', async () => {
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, {
    command: 'x',
    args: [],
    cwd: '/tmp',
    submitDelayMs: 0,
    initialSubmitIntervalMs: 5,
    initialSubmitAttempts: 4,
    legibleTranscript: true,
    transcriptDebounceMs: 5,
  });
  session.start();
  session.deliverInitial('do the task');
  emitBox(backend.last(), 'do the task'); // stays full: the REPL never accepts it
  await tick(5 * 6 + 60); // wait out the whole capped sequence plus slack
  const writes = backend.last().writes;
  // The paste, its submitting CR, then at most `initialSubmitAttempts` re-sends.
  assert.ok(writes.length <= 2 + 4, `retries are capped, got ${writes.length}`);
  assert.equal(writes.filter((w) => w.startsWith(PASTE_START)).length, 1, 'pasted exactly once');
  assert.ok(
    writes.slice(1).every((w) => w === '\r'),
    'every retry after the paste is a bare CR',
  );
});

test('deliverInitial without a mirror (raw) keeps the blind open-loop retry', async () => {
  // No legibleTranscript → no emulator to read → the closed loop degrades to the
  // original timing-only nudge: re-send until the status leaves running or the cap.
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
  await tick(5 * 6 + 60);
  const writes = backend.last().writes;
  assert.ok(writes.length > 2, 'the Enter is re-sent while the REPL is not yet accepting it');
  assert.ok(writes.length <= 2 + 4, `retries are capped, got ${writes.length}`);
  assert.equal(writes.filter((w) => w.startsWith(PASTE_START)).length, 1, 'pasted exactly once');
});
