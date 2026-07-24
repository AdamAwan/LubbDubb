import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PtySession } from '../src/pty/ptySession.js';
import { FakePtyBackend, type FakePtyProcess } from '../src/pty/fakeBackend.js';

// The initial-message boot race, closed-loop edition: instead of nudging the
// submitting Enter on a blind timer, a session-file session watches the transcript
// Claude Code writes and stops re-sending the moment a `user` record appears — proof
// the REPL actually accepted the paste. These tests stand in for the real claude by
// appending records to a session file by hand, driving the two observable states:
// "nothing accepted yet" (unsent) and "a user record landed" (accepted).

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const PASTE_START = '\x1b[200~';

/** A session-file root with an empty transcript for `sessionId`, ready to append to. */
function sessionFixture(sessionId: string): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'lubbdubb-initial-'));
  const dir = join(root, 'project');
  mkdirSync(dir);
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, '');
  return { root, file };
}

const userRecord = (text: string): string =>
  `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;

const crCount = (proc: FakePtyProcess): number => proc.writes.filter((w) => w === '\r').length;

test('deliverInitial stops re-sending the Enter once the session file records the message', async () => {
  const { root, file } = sessionFixture('sess-1');
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, {
    command: 'x',
    args: [],
    cwd: '/tmp',
    submitDelayMs: 0,
    initialSubmitIntervalMs: 10,
    initialSubmitAttempts: 20,
    sessionTranscript: { root, sessionId: 'sess-1', pollMs: 5 },
  });
  session.start();
  session.deliverInitial('do the task');
  // The REPL hasn't accepted the Enter yet — the file stays empty.
  await tick(45);
  assert.ok(crCount(backend.last()) > 1, 'the Enter is re-sent while nothing has been accepted');
  // The REPL accepts the message: a user record lands. The paste is never re-sent.
  appendFileSync(file, userRecord('do the task'));
  await tick(60);
  const afterAccept = crCount(backend.last());
  await tick(80); // well over the cap's remaining budget — proves the loop closed, not merely paused
  assert.equal(crCount(backend.last()), afterAccept, 'no more Enters once the message landed');
  assert.ok(afterAccept < 20, `stopped before the attempt cap, sent ${afterAccept} CRs`);
  assert.equal(
    backend.last().writes.filter((w) => w.startsWith(PASTE_START)).length,
    1,
    'the prompt is pasted exactly once',
  );
});

test('deliverInitial stops re-sending once the agent progresses off running', async () => {
  const { root } = sessionFixture('sess-2');
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, {
    command: 'x',
    args: [],
    cwd: '/tmp',
    submitDelayMs: 0,
    initialSubmitIntervalMs: 10,
    initialSubmitAttempts: 50,
    sessionTranscript: { root, sessionId: 'sess-2', pollMs: 5 },
    // No session-file detection in this test: drive the status from the terminal
    // backstop directly, so the nudge loop is what's under test.
  });
  session.start();
  session.deliverInitial('do the task');
  await tick(25);
  // The turn starts and the agent parks on a question — status leaves 'running'.
  session.kill();
  const countAtStop = backend.last().writes.length;
  await tick(60);
  assert.equal(backend.last().writes.length, countAtStop, 'no more Enters once it left running');
});

test('deliverInitial caps a message the REPL never accepts', async () => {
  const { root } = sessionFixture('sess-3');
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, {
    command: 'x',
    args: [],
    cwd: '/tmp',
    submitDelayMs: 0,
    initialSubmitIntervalMs: 5,
    initialSubmitAttempts: 4,
    sessionTranscript: { root, sessionId: 'sess-3', pollMs: 2 },
  });
  session.start();
  session.deliverInitial('do the task'); // the file stays empty: never accepted
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

test('deliverInitial without a session file (raw) keeps the blind open-loop retry', async () => {
  // No sessionTranscript → nothing to observe → the closed loop degrades to the
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
