import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recentOutputExcerpt } from '../src/escalation/context.js';

test('recentOutputExcerpt keeps the last non-empty lines', () => {
  const transcript = ['line 1', 'line 2', '', '   ', 'line 3', 'line 4'].join('\n');
  const out = recentOutputExcerpt(transcript, 2);
  assert.equal(out, 'line 3\nline 4');
});

test('recentOutputExcerpt strips control sentinels', () => {
  const transcript = 'Working on it…\nStuck here @@LUBBDUBB_WAITING:should I proceed?@@\n';
  const out = recentOutputExcerpt(transcript);
  assert.doesNotMatch(out, /LUBBDUBB/);
  assert.match(out, /Stuck here/);
});

test('recentOutputExcerpt bounds the total length', () => {
  const transcript = Array.from({ length: 500 }, (_, i) => `x`.repeat(50) + i).join('\n');
  const out = recentOutputExcerpt(transcript, 100, 300);
  assert.ok(out.length <= 300, `expected <=300 chars, got ${out.length}`);
});

test('recentOutputExcerpt returns empty string for whitespace-only transcript', () => {
  assert.equal(recentOutputExcerpt('\n\n   \n'), '');
});
