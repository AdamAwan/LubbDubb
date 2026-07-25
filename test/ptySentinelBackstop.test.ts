import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PtySession } from '../src/pty/ptySession.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';

// PTY detection has two sources: the session file (primary — clean text) and the
// raw terminal scan (backstop). A terminal sighting is deferred so the file can
// claim it first, and the backstop *reports* when it fires so drift can't rot
// silently. These cover the arbitration, not the parsing.

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function fixture(sessionId: string): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'lubbdubb-backstop-'));
  const dir = join(root, 'project');
  mkdirSync(dir);
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, '');
  return { root, file };
}

const assistantText = (text: string): string =>
  `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })}\n`;

test('the session file claiming a sentinel cancels the terminal backstop, even when the screen wrapped the reason', async () => {
  // The regression: the terminal reads the reason as *rendered* — hard-wrapped at
  // the screen width — while the file has it intact. Keying the arbitration on the
  // payload made these look like two different sentinels, so the file never
  // cancelled the terminal's timer and the backstop cried wolf on every wrap.
  const { root, file } = fixture('bs-1');
  const warnings: string[] = [];
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, {
    command: 'x',
    args: [],
    cwd: '/tmp',
    submitDelayMs: 0,
    sessionTranscript: { root, sessionId: 'bs-1', pollMs: 5 },
    onWarning: (m) => warnings.push(m),
  });
  session.start();
  // Let the tail find the file, so the deferral is actually in play.
  appendFileSync(file, assistantText('starting'));
  await tick(40);

  // Terminal sees the sentinel with a screen-inserted line break inside the reason.
  backend.last().emit('@@LUBBDUBB_WAITING:Does the version look\r\nright to you?@@');
  // The file reports the same event, unwrapped.
  appendFileSync(file, assistantText('@@LUBBDUBB_WAITING:Does the version look right to you?@@'));
  await tick(60);

  assert.equal(session.status, 'waiting', 'the session file drove the transition');
  assert.deepEqual(warnings, [], 'no drift is reported when the file did claim the sentinel');
});

test('the backstop applies a sentinel the session file never reports, and says so', async () => {
  const { root, file } = fixture('bs-2');
  const warnings: string[] = [];
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, {
    command: 'x',
    args: [],
    cwd: '/tmp',
    submitDelayMs: 0,
    sessionTranscript: { root, sessionId: 'bs-2', pollMs: 5 },
    onWarning: (m) => warnings.push(m),
  });
  session.start();
  appendFileSync(file, assistantText('working'));
  await tick(40);

  // Only the terminal ever sees it — the file stays silent on this turn.
  backend.last().emit('@@LUBBDUBB_WAITING:need a decision@@');
  assert.equal(session.status, 'running', 'the terminal sighting is deferred, not applied immediately');

  await tick(5_200); // past SENTINEL_BACKSTOP_MS
  assert.equal(session.status, 'waiting', 'the backstop still drives the transition');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /missed a waiting sentinel/);
});

test('with no session file located, terminal detection applies immediately', async () => {
  // Nothing to defer to: waiting on a source that may never speak would delay every
  // transition by the full backstop window.
  const root = mkdtempSync(join(tmpdir(), 'lubbdubb-backstop-none-'));
  const backend = new FakePtyBackend();
  const session = new PtySession(backend, {
    command: 'x',
    args: [],
    cwd: '/tmp',
    submitDelayMs: 0,
    sessionTranscript: { root, sessionId: 'never-appears', pollMs: 5 },
  });
  session.start();
  backend.last().emit('@@LUBBDUBB_WAITING:need a decision@@');
  assert.equal(session.status, 'waiting');
});
