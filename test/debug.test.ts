import { test } from 'node:test';
import assert from 'node:assert/strict';
import { debugEnabled, debugLog } from '../src/debug.js';

// Capture console.error around a body, restoring it after. Returns what was logged.
function captureStderr(body: () => void): string[] {
  const orig = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    body();
  } finally {
    console.error = orig;
  }
  return lines;
}

test('debugEnabled / debugLog gate on LUBBDUBB_DEBUG', () => {
  const prev = process.env.LUBBDUBB_DEBUG;
  try {
    delete process.env.LUBBDUBB_DEBUG;
    assert.equal(debugEnabled(), false);
    assert.deepEqual(
      captureStderr(() => debugLog('agent', 'hello')),
      [],
      'silent when off',
    );

    process.env.LUBBDUBB_DEBUG = '1';
    assert.equal(debugEnabled(), true);
    // The message is JSON-encoded (hence quoted) so control chars are escaped.
    assert.deepEqual(
      captureStderr(() => debugLog('agent', 'hello')),
      ['[lubbdubb:debug:agent] "hello"'],
    );
  } finally {
    if (prev === undefined) delete process.env.LUBBDUBB_DEBUG;
    else process.env.LUBBDUBB_DEBUG = prev;
  }
});

test('debugLog escapes control chars so an agent-influenced value cannot forge a log line', () => {
  const prev = process.env.LUBBDUBB_DEBUG;
  try {
    process.env.LUBBDUBB_DEBUG = '1';
    // A path carrying a newline + a fake "second entry" must stay a single line.
    const lines = captureStderr(() => debugLog('fileEvents', 'path=a.md\ninjected tool=Write\r\ttab'));
    assert.equal(lines.length, 1, 'exactly one log line');
    assert.match(lines[0]!, /^\[lubbdubb:debug:fileEvents] /);
    assert.doesNotMatch(lines[0]!, /\n/); // no real newline survives
    assert.match(lines[0]!, /\\n/); // newline escaped to backslash-n
    assert.match(lines[0]!, /\\r/); // carriage return escaped
    assert.match(lines[0]!, /\\t/); // tab escaped
  } finally {
    if (prev === undefined) delete process.env.LUBBDUBB_DEBUG;
    else process.env.LUBBDUBB_DEBUG = prev;
  }
});
