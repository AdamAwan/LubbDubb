import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalTranscript, isTuiChromeLine, type TranscriptUpdate } from '../src/pty/terminalTranscript.js';

function collect(): { updates: TranscriptUpdate[]; onUpdate: (u: TranscriptUpdate) => void } {
  const updates: TranscriptUpdate[] = [];
  return { updates, onUpdate: (u) => updates.push(u) };
}

test('plain line output settles verbatim as an append', async () => {
  const { updates, onUpdate } = collect();
  const t = new TerminalTranscript({ debounceMs: 5, onUpdate });
  t.write('hello\r\n');
  t.write('world\r\n');
  await t.settle();
  assert.equal(t.snapshot(), 'hello\nworld');
  assert.deepEqual(updates, [{ kind: 'append', delta: 'hello\nworld' }]);
  t.dispose();
});

test('in-place cursor redraws collapse to the settled screen text', async () => {
  const { onUpdate } = collect();
  const t = new TerminalTranscript({ debounceMs: 5, onUpdate });
  t.write('step one\r\n');
  // Three spinner frames repainted in place on the same row, then real output.
  t.write('✻ Unravelling… (esc to interrupt)');
  t.write('\r\x1b[2K✶ Pondering… (esc to interrupt)');
  t.write('\r\x1b[2K✽ Cogitating… (esc to interrupt)');
  t.write('\r\x1b[2Kthe actual answer\r\n');
  await t.settle();
  // No jammed-together frame text, and the spinner never reaches the transcript.
  assert.equal(t.snapshot(), 'step one\nthe actual answer');
  t.dispose();
});

test('TUI chrome (spinner, input box, hints) is excluded from the snapshot', async () => {
  const { onUpdate } = collect();
  const t = new TerminalTranscript({ debounceMs: 5, onUpdate });
  t.write('real content\r\n');
  t.write('✶ thinking with medium effort… (esc to interrupt)\r\n');
  t.write('╭──────────────╮\r\n');
  t.write('│ > try "help" │\r\n');
  t.write('╰──────────────╯\r\n');
  t.write('? for shortcuts\r\n');
  await t.settle();
  assert.equal(t.snapshot(), 'real content');
  t.dispose();
});

test('appends stream as deltas; rewriting settled content becomes a replace', async () => {
  const { updates, onUpdate } = collect();
  const t = new TerminalTranscript({ debounceMs: 5, onUpdate });
  t.write('one\r\n');
  await t.settle();
  t.write('two\r\n');
  await t.settle();
  assert.deepEqual(updates, [
    { kind: 'append', delta: 'one' },
    { kind: 'append', delta: '\ntwo' },
  ]);
  // Cursor-up and overwrite an already-emitted line: no longer an extension.
  t.write('\x1b[2A\x1b[2KONE REWRITTEN\r\n\r\n');
  await t.settle();
  const last = updates[updates.length - 1];
  assert.deepEqual(last, { kind: 'replace', text: 'ONE REWRITTEN\ntwo' });
  t.dispose();
});

test('no update is emitted when nothing settled changes', async () => {
  const { updates, onUpdate } = collect();
  const t = new TerminalTranscript({ debounceMs: 5, onUpdate });
  t.write('stable\r\n');
  await t.settle();
  const count = updates.length;
  // A spinner frame is chrome, so the settled text is unchanged.
  t.write('✻ Working… (esc to interrupt)');
  await t.settle();
  assert.equal(updates.length, count);
  t.dispose();
});

test('isTuiChromeLine recognises chrome and leaves content alone', () => {
  assert.equal(isTuiChromeLine('✻ Unravelling… (esc to interrupt)'), true);
  assert.equal(isTuiChromeLine('✶ thinking with medium effort…'), true);
  assert.equal(isTuiChromeLine('· Flibbertigibbeting… (esc to interrupt · 32s)'), true);
  assert.equal(isTuiChromeLine('╭──────────────────╮'), true);
  assert.equal(isTuiChromeLine('│ > '), true);
  assert.equal(isTuiChromeLine('╰──────────────────╯'), true);
  assert.equal(isTuiChromeLine('? for shortcuts'), true);
  assert.equal(isTuiChromeLine('⏵⏵ accept edits on (shift+tab to cycle)'), true);

  assert.equal(isTuiChromeLine('Show dispatcher rule identity in decision log'), false);
  assert.equal(isTuiChromeLine('● I ran the tests and they pass.'), false);
  assert.equal(isTuiChromeLine('  ⎿ 12 lines of tool output'), false);
  assert.equal(isTuiChromeLine('const x = a | b;'), false);
  assert.equal(isTuiChromeLine(''), false);
});
