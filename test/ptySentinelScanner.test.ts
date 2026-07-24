import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PtySession } from '../src/pty/ptySession.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { excise, holdFrom, scanSentinels, type SentinelSpec } from '../src/pty/sentinelScanner.js';

const SPEC: SentinelSpec = {
  done: '@@LUBBDUBB_DONE@@',
  waitPrefix: '@@LUBBDUBB_WAITING:',
  waitSuffix: '@@',
  flagPrefix: '@@LUBBDUBB_FLAG:',
  flagSuffix: '@@',
};

function session(opts: Record<string, unknown> = {}): {
  backend: FakePtyBackend;
  s: PtySession;
  out: () => string;
  flags: unknown[];
} {
  const backend = new FakePtyBackend();
  const s = new PtySession(backend, { command: 'x', args: [], cwd: '/tmp', submitDelayMs: 0, ...opts });
  const chunks: string[] = [];
  const flags: unknown[] = [];
  s.on('output', (d: string) => chunks.push(d));
  s.on('flag', (f: unknown) => flags.push(f));
  s.start();
  return { backend, s, out: () => chunks.join(''), flags };
}

// -- the scanner itself ------------------------------------------------------

test('scanSentinels matches a token whose characters are split by SGR escapes', () => {
  // The TUI styles the assistant line, so escapes land *inside* the token — not
  // just around it. Detection used to work on an ANSI-stripped copy while the
  // display path stripped raw bytes, so only one of them matched.
  const hits = scanSentinels('done \x1b[1m@@LUBBDUBB\x1b[0m_DONE@@\r\n', SPEC);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.kind, 'done');
});

test('scanSentinels returns raw spans, so excise removes interleaved escapes too', () => {
  const raw = 'a @@LUBBDUBB_FLAG:\x1b[1mreport.md\x1b[0m@@ b';
  const hits = scanSentinels(raw, SPEC);
  assert.equal(hits[0]?.payload, 'report.md', 'payload comes back escape-free');
  assert.equal(excise(raw, hits), 'a  b');
});

test('scanSentinels keeps the boundary guard so an echoed sentinel mid-token is ignored', () => {
  assert.deepEqual(scanSentinels('x@@LUBBDUBB_DONE@@', SPEC), []);
  assert.deepEqual(scanSentinels('x@@LUBBDUBB_WAITING:r@@', SPEC), []);
});

test('scanSentinels does not let an unterminated prefix swallow a following done token', () => {
  // Waiting and flag both close on a bare `@@`, which is also the done token's
  // opening pair — so an unclosed prefix could otherwise claim it.
  const hits = scanSentinels('@@LUBBDUBB_WAITING:oops @@LUBBDUBB_DONE@@\r\n', SPEC);
  assert.ok(
    hits.some((h) => h.kind === 'done'),
    'the done sentinel must still be found',
  );
});

test('holdFrom releases an unterminated prefix once it exceeds the bound', () => {
  const short = 'text @@LUBBDUBB_WAITING:still arriving';
  assert.equal(holdFrom(short, SPEC, 512), 5, 'a fresh prefix is held for its suffix');
  const long = 'text @@LUBBDUBB_WAITING:' + 'x'.repeat(900);
  assert.equal(holdFrom(long, SPEC, 512), long.length, 'past the bound it is literal text');
});

// -- through the session -----------------------------------------------------

test('a sentinel split by TUI styling is stripped from the transcript, not just detected', () => {
  // Regression: detection fired (status went done) while the display path missed
  // the same token, so the raw sentinel leaked into the user-visible transcript.
  const { backend, s, out } = session();
  backend.last().emit('done now \x1b[1m@@LUBBDUBB\x1b[0m_DONE@@\r\n');
  assert.equal(s.status, 'done');
  assert.equal(out().includes('LUBBDUBB'), false, 'the sentinel must not leak into the transcript');
});

test('a styled waiting sentinel parks with a clean reason and is stripped', () => {
  const { backend, s, out } = session();
  let reason: string | null = null;
  s.on('waiting', (r: string) => (reason = r));
  backend.last().emit('\x1b[1m@@LUBBDUBB_WAITING:\x1b[0mpick a name@@\r\n');
  assert.equal(s.status, 'waiting');
  assert.equal(reason, 'pick a name');
  assert.equal(out().includes('LUBBDUBB'), false);
  assert.equal(out().includes('pick a name'), false);
});

test('an unterminated prefix no longer blacks out the rest of the run', () => {
  // Regression: the hold started at the earliest unterminated waiting/flag prefix
  // and had no bound, so an agent that merely *mentioned* the protocol without
  // closing the token withheld every subsequent byte forever — a total transcript
  // blackout for the rest of the session.
  const { backend, out } = session();
  backend.last().emit('I will print @@LUBBDUBB_WAITING: when I need you.\r\n');
  for (let i = 0; i < 20; i++) backend.last().emit(`step ${i}: ${'work '.repeat(12)}\r\n`);
  const text = out();
  assert.ok(text.includes('step 19'), 'later output must still reach the transcript');
  assert.ok(text.includes('step 0'), 'the withheld backlog is released, not dropped');
});

test('the stream keeps working after a released prefix: a real sentinel still finishes', () => {
  const { backend, s, out } = session();
  backend.last().emit('mentioning @@LUBBDUBB_WAITING: without closing it\r\n');
  for (let i = 0; i < 20; i++) backend.last().emit(`filler ${i} ${'y'.repeat(40)}\r\n`);
  backend.last().emit('all done @@LUBBDUBB_DONE@@\r\n');
  assert.equal(s.status, 'done', 'detection still works after the hold was released');
  assert.equal(out().includes('@@LUBBDUBB_DONE@@'), false, 'the real sentinel is still stripped');
});

test('a flag is emitted once, not re-fired as the tail window slides', () => {
  const { backend, flags } = session();
  backend.last().emit('@@LUBBDUBB_FLAG:report.md@@\r\n');
  backend.last().emit('more output\r\n');
  backend.last().emit('even more output\r\n');
  assert.equal(flags.length, 1);
});
