import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBlocks, assistantText, MAX_RESULT_LINES } from '../src/agents/streamTranscript.js';

/** Strip our own SGR colour codes so assertions read against plain text. */
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

test('assistantText concatenates raw text blocks including sentinels (for detection)', () => {
  const blocks = [
    { type: 'text', text: 'hello ' },
    { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    { type: 'text', text: 'bye @@LUBBDUBB_DONE@@' },
  ];
  assert.equal(assistantText(blocks), 'hello bye @@LUBBDUBB_DONE@@');
});

test('renderBlocks passes plain assistant text through unchanged', () => {
  assert.equal(renderBlocks([{ type: 'text', text: 'Hello there' }]), 'Hello there');
});

test('renderBlocks strips sentinels from assistant text', () => {
  const out = renderBlocks([{ type: 'text', text: 'done now @@LUBBDUBB_DONE@@' }]);
  assert.ok(!out.includes('@@LUBBDUBB_DONE@@'));
  assert.ok(out.includes('done now'));
});

test('renderBlocks labels a tool call with a concise input summary', () => {
  const out = plain(renderBlocks([{ type: 'tool_use', name: 'Bash', input: { command: 'npm run check' } }]));
  assert.ok(out.includes('Bash'), 'shows tool name');
  assert.ok(out.includes('npm run check'), 'shows the command');
  assert.ok(!out.includes('{'), 'does not dump raw JSON for a known tool');
});

test('renderBlocks summarises a file tool by its path, not raw JSON', () => {
  const out = plain(renderBlocks([{ type: 'tool_use', name: 'Read', input: { file_path: 'src/config.ts' } }]));
  assert.ok(out.includes('Read'));
  assert.ok(out.includes('src/config.ts'));
});

test('renderBlocks labels a tool result and shows its body', () => {
  const out = plain(renderBlocks([{ type: 'tool_result', content: 'total 8\nfile-a\nfile-b' }]));
  assert.ok(out.includes('file-a'));
  assert.ok(out.includes('file-b'));
});

test('renderBlocks marks an error tool result', () => {
  const out = plain(renderBlocks([{ type: 'tool_result', is_error: true, content: 'command not found' }]));
  assert.ok(/error/i.test(out));
  assert.ok(out.includes('command not found'));
});

test('renderBlocks strips ANSI/control noise from tool result output', () => {
  const noisy = 'clean\x1b[7mINVERSE\x1b[0m line\x07';
  const out = renderBlocks([{ type: 'tool_result', content: noisy }]);
  assert.ok(!out.includes('\x1b[7m'), 'no injected ANSI');
  assert.ok(!out.includes('\x07'), 'no bell control char');
  assert.ok(out.includes('INVERSE'), 'keeps the visible text');
});

test('renderBlocks truncates long tool results with a remaining-lines marker', () => {
  const body = Array.from({ length: MAX_RESULT_LINES + 20 }, (_, i) => `line-${i}`).join('\n');
  const out = plain(renderBlocks([{ type: 'tool_result', content: body }]));
  assert.ok(out.includes('line-0'), 'keeps the first line');
  assert.ok(!out.includes(`line-${MAX_RESULT_LINES + 19}`), 'drops the last line');
  assert.ok(/\+20 more lines/.test(out), 'shows how many lines were hidden');
});

test('renderBlocks renders assistant text and a tool call together, visually separated', () => {
  const out = plain(
    renderBlocks([
      { type: 'text', text: 'Let me list the files.' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    ]),
  );
  assert.ok(out.includes('Let me list the files.'));
  assert.ok(out.includes('Bash'));
  // A newline boundary separates prose from the tool line.
  assert.ok(out.indexOf('Bash') > out.indexOf('\n'), 'tool label sits on its own line');
});
