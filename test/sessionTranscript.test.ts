import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SessionTranscriptTail,
  locateSessionFile,
  parseSessionEntries,
  type SessionTranscriptUpdate,
} from '../src/agents/sessionTranscript.js';

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const line = (o: unknown): string => JSON.stringify(o);

const assistant = (...blocks: unknown[]): string =>
  line({ type: 'assistant', message: { role: 'assistant', content: blocks } });
const userText = (text: string): string => line({ type: 'user', message: { role: 'user', content: text } });

// -- parser ----------------------------------------------------------------

test('parses assistant text, tool calls and results into renderable blocks', () => {
  const batch = parseSessionEntries([
    userText('do the thing'),
    assistant({ type: 'text', text: 'On it.' }),
    assistant({ type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: '# Title' }] } }),
  ]);
  assert.deepEqual(
    batch.blocks.map((b) => b.type),
    ['human', 'text', 'tool_use', 'tool_result'],
  );
  assert.equal(batch.assistantText, 'On it.');
  assert.equal(batch.userEntries, 1);
});

test('assistantText excludes human messages so a prompt describing the protocol cannot self-complete', () => {
  // A real task prompt that *documents* the sentinels must never be read as the
  // agent having printed one.
  const batch = parseSessionEntries([
    userText('Print @@LUBBDUBB_DONE@@ when you finish.'),
    assistant({ type: 'text', text: 'Understood.' }),
  ]);
  assert.equal(batch.assistantText, 'Understood.');
  assert.ok(!batch.assistantText.includes('@@LUBBDUBB_DONE@@'));
});

test('drops non-conversation records, meta and sidechain entries', () => {
  const batch = parseSessionEntries([
    line({ type: 'attachment', attachment: {} }),
    line({ type: 'system', content: 'Shell cwd was reset' }),
    line({ type: 'mode', mode: 'default' }),
    line({ type: 'permission-mode', permissionMode: 'plan' }),
    line({ type: 'last-prompt', leafUuid: 'x' }),
    line({ type: 'ai-title', title: 'x' }),
    line({ type: 'file-history-snapshot' }),
    line({ type: 'file-history-delta' }),
    line({ type: 'queue-operation' }),
    line({ type: 'assistant', isMeta: true, message: { content: [{ type: 'text', text: 'meta' }] } }),
    line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent' }] } }),
    assistant({ type: 'text', text: 'kept' }),
  ]);
  assert.equal(batch.blocks.length, 1);
  assert.equal(batch.assistantText, 'kept');
});

test('drops local-command envelopes so the /exit teardown does not leak into the transcript', () => {
  // exitOnDone writes `/exit`; Claude Code records it as this trio. Unfiltered it
  // reproduces exactly the terminal noise this module exists to remove.
  const batch = parseSessionEntries([
    userText('<local-command-caveat>Caveat: The messages below were generated…</local-command-caveat>'),
    userText('<command-name>/exit</command-name>\n<command-message>exit</command-message>'),
    userText('<local-command-stdout>Bye!</local-command-stdout>'),
    userText('a real message'),
  ]);
  assert.equal(batch.blocks.length, 1);
  assert.equal(batch.userEntries, 1, 'envelopes are not counted as accepted messages either');
});

test('a torn or unparsable record is skipped, never fatal', () => {
  const batch = parseSessionEntries([
    '{"type":"assistant","message":{"content":[{"type":"te',
    '',
    assistant({ type: 'text', text: 'ok' }),
  ]);
  assert.equal(batch.assistantText, 'ok');
});

// -- locating --------------------------------------------------------------

test('locates a session file by id under any project directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'lubbdubb-locate-'));
  mkdirSync(join(root, 'some-other-project'));
  mkdirSync(join(root, 'C--Users-x-Code-thing'));
  const target = join(root, 'C--Users-x-Code-thing', 'abc-123.jsonl');
  writeFileSync(target, '');
  assert.equal(locateSessionFile(root, 'abc-123'), target);
  assert.equal(locateSessionFile(root, 'nope'), null);
  assert.equal(locateSessionFile(join(root, 'missing'), 'abc-123'), null);
});

// -- tail ------------------------------------------------------------------

function fixture(sessionId: string): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'lubbdubb-tail-'));
  const dir = join(root, 'project');
  mkdirSync(dir);
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, '');
  return { root, file };
}

test('tail emits rendered transcript as records are appended', async () => {
  const { root, file } = fixture('s1');
  const updates: SessionTranscriptUpdate[] = [];
  const tail = new SessionTranscriptTail({ root, sessionId: 's1', pollMs: 5, onUpdate: (u) => updates.push(u) });
  tail.start();
  appendFileSync(file, `${assistant({ type: 'text', text: 'hello there' })}\n`);
  await tick(40);
  tail.stop();
  assert.equal(updates.length, 1);
  assert.match(updates[0]!.display, /hello there/);
  assert.equal(updates[0]!.assistantText, 'hello there');
});

test('tail holds a half-written record until its newline arrives', async () => {
  const { root, file } = fixture('s2');
  const updates: SessionTranscriptUpdate[] = [];
  const tail = new SessionTranscriptTail({ root, sessionId: 's2', pollMs: 5, onUpdate: (u) => updates.push(u) });
  tail.start();
  const whole = assistant({ type: 'text', text: 'complete message' });
  appendFileSync(file, whole.slice(0, 30)); // torn mid-record
  await tick(30);
  assert.equal(updates.length, 0, 'nothing is emitted from a partial record');
  appendFileSync(file, `${whole.slice(30)}\n`);
  await tick(30);
  tail.stop();
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.assistantText, 'complete message');
});

test('startAtEof skips turns a resumed session already persisted', async () => {
  const { root, file } = fixture('s3');
  writeFileSync(file, `${assistant({ type: 'text', text: 'before the restart' })}\n`);
  const updates: SessionTranscriptUpdate[] = [];
  const tail = new SessionTranscriptTail({
    root,
    sessionId: 's3',
    pollMs: 5,
    startAtEof: true,
    onUpdate: (u) => updates.push(u),
  });
  tail.start();
  await tick(30);
  assert.equal(updates.length, 0, 'pre-restart turns are not replayed as duplicates');
  appendFileSync(file, `${assistant({ type: 'text', text: 'after the restart' })}\n`);
  await tick(30);
  tail.stop();
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.assistantText, 'after the restart');
});

test('tail waits for a session file that does not exist yet', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lubbdubb-late-'));
  const dir = join(root, 'project');
  mkdirSync(dir);
  const updates: SessionTranscriptUpdate[] = [];
  const tail = new SessionTranscriptTail({ root, sessionId: 's4', pollMs: 5, onUpdate: (u) => updates.push(u) });
  tail.start();
  await tick(20); // file appears a beat after the process spawns
  writeFileSync(join(dir, 's4.jsonl'), `${assistant({ type: 'text', text: 'late start' })}\n`);
  await tick(30);
  tail.stop();
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.assistantText, 'late start');
});
