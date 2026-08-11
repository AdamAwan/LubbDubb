import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedBlocks, emptyBlockState } from '../web/src/components/transcriptBlocks.js';
import { renderBlocks } from '../src/agents/streamTranscript.js';

/**
 * The parser reads structure out of text the *server* writes, so these tests feed it
 * real `renderBlocks` output rather than hand-written markers. That round trip is what
 * holds the two sides together: the marker shape lives in one place and a change to it
 * fails here, instead of silently leaving the drawer unable to find a tool call.
 */

/** Strip SGR so assertions read against plain text. */
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Feed a whole transcript in one go, with ANSI stripped from every op. */
function all(text: string): { ops: { kind: string; text?: string; error?: boolean }[]; tail: string } {
  const { ops, tail } = feedBlocks(text, emptyBlockState);
  return {
    ops: ops.map((o) => ({ ...o, text: o.text === undefined ? undefined : plain(o.text) })),
    tail: plain(tail),
  };
}

test('prose with no markers is a single text op', () => {
  const { ops } = all('I will look at the config.\n');
  assert.deepEqual(ops, [{ kind: 'text', text: 'I will look at the config.\n' }]);
});

test('a tool call and its result become one collapsed block', () => {
  const rendered =
    renderBlocks([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]) +
    renderBlocks([{ type: 'tool_result', content: 'a\nb\nc' }]);
  const { ops } = all(rendered);
  const open = ops.find((o) => o.kind === 'open');
  assert.ok(open, 'a block opened');
  assert.match(open.text ?? '', /⚙ Bash ls/);
  assert.match(open.text ?? '', /· 3 lines/, 'the result count is folded into the summary');
  assert.equal(open.error, false);
  const body = ops
    .filter((o) => o.kind === 'text')
    .map((o) => o.text)
    .join('');
  assert.ok(body.includes('a') && body.includes('c'), 'the result body is inside the block');
  assert.equal(ops.filter((o) => o.kind === 'open').length, 1, 'the result did not open a second block');
});

test('an error result opens an error block', () => {
  const rendered =
    renderBlocks([{ type: 'tool_use', name: 'Bash', input: { command: 'nope' } }]) +
    renderBlocks([{ type: 'tool_result', is_error: true, content: 'command not found' }]);
  const opens = all(rendered).ops.filter((o) => o.kind === 'open');
  assert.equal(opens.length, 2, 'an error stands on its own rather than folding away');
  assert.equal(opens[1]?.error, true);
});

test('parallel calls yield standalone blocks rather than mispaired ones', () => {
  const rendered =
    renderBlocks([
      { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } },
      { type: 'tool_use', name: 'Read', input: { file_path: 'b.ts' } },
    ]) +
    renderBlocks([
      { type: 'tool_result', content: 'aaa' },
      { type: 'tool_result', content: 'bbb' },
    ]);
  const opens = all(rendered).ops.filter((o) => o.kind === 'open');
  assert.equal(opens.length, 4, 'two calls and two results, each its own block');
  const summaries = opens.map((o) => o.text ?? '');
  assert.match(summaries[0] ?? '', /a\.ts/);
  assert.match(summaries[1] ?? '', /b\.ts/);
  assert.match(summaries[2] ?? '', /↳ result/);
  assert.match(summaries[3] ?? '', /↳ result/);
  assert.ok(!(summaries[1] ?? '').includes('· '), 'a result is never folded into the wrong call');
});

test('prose after a result leaves the block', () => {
  const rendered =
    renderBlocks([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]) +
    renderBlocks([{ type: 'tool_result', content: 'a\nb' }]) +
    renderBlocks([{ type: 'text', text: 'Three files, as expected.\n' }]);
  const { ops } = all(rendered);
  const closeAt = ops.findIndex((o) => o.kind === 'close');
  assert.ok(closeAt >= 0, 'the block closed');
  const after = ops
    .slice(closeAt)
    .map((o) => o.text ?? '')
    .join('');
  assert.ok(after.includes('Three files'), 'the prose is outside the block');
});

test('a chunk boundary mid-marker does not half-parse a block', () => {
  const rendered =
    renderBlocks([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]) +
    renderBlocks([{ type: 'tool_result', content: 'a\nb' }]);
  const cut = rendered.indexOf('Bash') + 2;
  const first = feedBlocks(rendered.slice(0, cut), emptyBlockState);
  const second = feedBlocks(rendered.slice(cut), first.state);
  const opens = [...first.ops, ...second.ops].filter((o) => o.kind === 'open');
  assert.equal(opens.length, 1, 'exactly one block despite the split');
  assert.match(plain(opens[0]?.text ?? ''), /⚙ Bash ls/);
});

test('an unterminated trailing line is reported as tail, not swallowed', () => {
  const { ops, tail } = all('thinking about it');
  assert.deepEqual(ops, []);
  assert.equal(tail, 'thinking about it');
});

test('a settled PTY transcript, which carries no markers, is plain text', () => {
  const { ops } = all('> npm run check\nall six passed\n');
  assert.deepEqual(
    ops.map((o) => o.kind),
    ['text', 'text'],
  );
});
