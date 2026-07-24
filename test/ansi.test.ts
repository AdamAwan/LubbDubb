import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnsi, ansiClass } from '../web/src/components/ansi.js';

const CYAN = '\x1b[36m';
const GRAY = '\x1b[90m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

test('plain text is one unstyled segment', () => {
  const { segments, end } = parseAnsi('just words');
  assert.deepEqual(segments, [{ text: 'just words', style: {} }]);
  assert.deepEqual(end, {});
});

test('a colour run yields a styled segment and resets after', () => {
  const { segments } = parseAnsi(`${CYAN}⚙ Bash${RESET} done`);
  assert.deepEqual(segments, [
    { text: '⚙ Bash', style: { color: 'cyan' } },
    { text: ' done', style: {} },
  ]);
});

test('dim combines with colour (renderBlocks tool summary)', () => {
  const { segments } = parseAnsi(`${GRAY}  ↳ result${RESET}\n${DIM}… (+3 more lines)${RESET}`);
  assert.deepEqual(segments, [
    { text: '  ↳ result', style: { color: 'gray' } },
    { text: '\n', style: {} },
    { text: '… (+3 more lines)', style: { dim: true } },
  ]);
});

test('the end style threads across a delta that splits a colour run', () => {
  const first = parseAnsi(`before ${RED}mid`); // opened red, not yet reset
  assert.equal(first.end.color, 'red');
  const second = parseAnsi(`still-red${RESET} after`, first.end);
  assert.deepEqual(second.segments, [
    { text: 'still-red', style: { color: 'red' } },
    { text: ' after', style: {} },
  ]);
});

test('reset in the middle of a multi-code run clears then re-applies', () => {
  // \x1b[0;36m — reset, then cyan
  const { segments } = parseAnsi(`\x1b[0;36mcyan${RESET}`);
  assert.deepEqual(segments, [{ text: 'cyan', style: { color: 'cyan' } }]);
});

test('non-SGR escapes are swallowed, leaving no segment', () => {
  const { segments } = parseAnsi('a\x1b[2Kb\x1b[1Gc'); // erase-line, cursor-column
  assert.deepEqual(segments, [
    { text: 'a', style: {} },
    { text: 'b', style: {} },
    { text: 'c', style: {} },
  ]);
});

test('ansiClass renders the CSS class list', () => {
  assert.equal(ansiClass({}), '');
  assert.equal(ansiClass({ color: 'cyan' }), 'ansi-cyan');
  assert.equal(ansiClass({ color: 'gray', dim: true }), 'ansi-gray ansi-dim');
  assert.equal(ansiClass({ dim: true }), 'ansi-dim');
});
