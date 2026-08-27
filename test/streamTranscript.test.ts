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

test('renderBlocks labels a multi-line result with its line count', () => {
  const out = plain(renderBlocks([{ type: 'tool_result', content: 'a\nb\nc' }]));
  assert.match(out, /↳ result · 3 lines/);
});

test('renderBlocks omits the count for a single-line result', () => {
  const out = plain(renderBlocks([{ type: 'tool_result', content: 'just one' }]));
  assert.match(out, /↳ result\n/);
  assert.ok(!out.includes('· 1 line'), 'no count for a one-line result');
});

test('the result count is the pre-truncation total', () => {
  const body = Array.from({ length: MAX_RESULT_LINES + 14 }, (_, i) => `line-${i}`).join('\n');
  const out = plain(renderBlocks([{ type: 'tool_result', content: body }]));
  assert.match(out, new RegExp(`↳ result · ${MAX_RESULT_LINES + 14} lines`));
  assert.ok(/\+14 more lines/.test(out), 'still reports what was hidden');
});

test('an error result is labelled and counted the same way', () => {
  const out = plain(renderBlocks([{ type: 'tool_result', is_error: true, content: 'boom\ntrace' }]));
  assert.match(out, /↳ error · 2 lines/);
});

// -- timestamps ------------------------------------------------------------

/** What the renderer should print for an instant: local time, seconds included. */
const at = (iso: string): string => `[${new Date(iso).toTimeString().slice(0, 8)}]`;

const T1 = '2026-08-20T09:14:02.000Z';
const T2 = '2026-08-20T09:15:40.000Z';

test('a tool call is stamped with when it was made', () => {
  const out = plain(renderBlocks([{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }], T1));
  assert.ok(out.includes(`${at(T1)} ⚙ Bash npm test`), 'the stamp leads the label');
});

test('a result is stamped after its label, so the fold keeps it', () => {
  const out = plain(renderBlocks([{ type: 'tool_result', content: 'a\nb\nc' }], T2));
  assert.ok(out.includes(`\n  ↳ result ${at(T2)} · 3 lines\n`), 'stamp between the label and the count');
});

test('a single-line result is still stamped, though it has no count', () => {
  const out = plain(renderBlocks([{ type: 'tool_result', content: 'just one' }], T2));
  assert.ok(out.includes(`↳ result ${at(T2)}\n`));
  assert.ok(!out.includes('· 1 line'));
});

test('a sent message is stamped', () => {
  const out = plain(renderBlocks([{ type: 'human', text: 'carry on' }], T1));
  assert.ok(out.includes(`${at(T1)} ▸ sent`));
});

test("a block's own time wins over the batch's", () => {
  // The PTY runtime replays a whole session file in one pass, so the batch time is
  // never the truth there — each record dates itself.
  const out = plain(renderBlocks([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' }, at: T1 }], T2));
  assert.ok(out.includes(at(T1)), 'the record dates the line');
  assert.ok(!out.includes(at(T2)), 'the batch time does not override it');
});

test('an unstamped render is byte-for-byte what it was before stamps', () => {
  const blocks = [
    { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool_result', content: 'a\nb' },
    { type: 'human', text: 'carry on' },
  ];
  // No time is a supported state — an older session file carries no `timestamp` —
  // and it must degrade to the plain line rather than to `[]` or `[Invalid Date]`.
  assert.equal(renderBlocks(blocks), renderBlocks(blocks, undefined));
  assert.equal(renderBlocks(blocks, 'not a date'), renderBlocks(blocks));
});

test('prose is never stamped', () => {
  assert.equal(renderBlocks([{ type: 'text', text: 'Hello there' }], T1), 'Hello there');
});

/**
 * The stripped sentinel used to leave nothing behind, so a turn that announced it
 * had finished and one that simply stopped read identically. These lock the record
 * that replaces it — and, just as importantly, that the harness's *own* messages
 * cannot forge one: `STALL_NUDGE` quotes both sentinels at an agent verbatim.
 */
test('renderBlocks records that a done sentinel was in the text it stripped', () => {
  const out = plain(renderBlocks([{ type: 'text', text: 'Pushed and green. @@LUBBDUBB_DONE@@' }]));
  assert.ok(!out.includes('@@LUBBDUBB_DONE@@'), 'the token still never leaks');
  assert.ok(out.includes('Pushed and green.'));
  assert.ok(out.includes('✓ announced done'), 'but the announcement is on the glass');
});

test('renderBlocks records a waiting sentinel with what the agent asked for', () => {
  const out = plain(renderBlocks([{ type: 'text', text: 'Stuck. @@LUBBDUBB_WAITING:Which auth provider?@@' }]));
  assert.ok(!out.includes('@@LUBBDUBB_WAITING'));
  assert.ok(out.includes('⏸ asked for a person'));
  assert.ok(out.includes('Which auth provider?'));
});

test('a sentinel marker is stamped like every other labelled line', () => {
  const out = plain(renderBlocks([{ type: 'text', text: 'all done @@LUBBDUBB_DONE@@' }], T1));
  assert.match(out, /\[\d{2}:\d{2}:\d{2}\] ✓ announced done/);
});

test('a message sent *to* the agent never marks, however it quotes the protocol', () => {
  // The stall nudge names both sentinels at the agent. Marking that would put an
  // "announced done" in the transcript for the harness asking whether it had.
  const out = plain(
    renderBlocks([{ type: 'human', text: 'print @@LUBBDUBB_DONE@@ if you finished, else @@LUBBDUBB_WAITING:x@@' }]),
  );
  assert.ok(out.includes('▸ sent'));
  assert.ok(!out.includes('announced done'));
  assert.ok(!out.includes('asked for a person'));
});

test('prose carrying no sentinel gets no marker', () => {
  assert.equal(renderBlocks([{ type: 'text', text: 'Still working on it.' }]), 'Still working on it.');
});
