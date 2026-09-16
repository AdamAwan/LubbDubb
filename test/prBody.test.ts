import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PR_BODY, prBodyRefusal } from '../src/pr/prBody.js';

const good = [
  '- Sync cursors were lost on restart, so the poller refetched every page.',
  '- Adds a table that stores the last cursor per feed.',
  '- Reads it on boot and writes it after each page.',
].join('\n');

test('five plain bullets pass, and no body at all passes', () => {
  assert.equal(prBodyRefusal(good), null);
  assert.equal(prBodyRefusal(''), null);
});

test('a heading or a prose paragraph is refused, and the refusal quotes the line', () => {
  const refusal = prBodyRefusal(`## Summary\n${good}`);
  assert.match(refusal ?? '', /is a bullet and this one is not/);
  assert.match(refusal ?? '', /## Summary/);
  assert.match(prBodyRefusal('This PR adds a table for sync cursors.') ?? '', /not/);
});

test('a sixth bullet is refused, and the limit is what the message says', () => {
  const six = Array.from({ length: PR_BODY.bullets + 1 }, (_, i) => `- Point ${i} about the change.`).join('\n');
  const refusal = prBodyRefusal(six);
  assert.match(refusal ?? '', new RegExp(`the limit is ${PR_BODY.bullets}`));
});

test('a paragraph wearing a dash is refused on length', () => {
  const long = `- ${'the poller refetches every page and '.repeat(5)}stops.`;
  const refusal = prBodyRefusal(long);
  assert.match(refusal ?? '', new RegExp(`the limit is ${PR_BODY.bulletChars}`));
});

test('the plainness rules apply per bullet', () => {
  assert.match(prBodyRefusal('- Adds the table; the poller reads it on boot.') ?? '', /semicolon/);
  assert.match(prBodyRefusal('- Adds the table — the first-bind case.') ?? '', /clause off a dash/);
});

test('bullets that are short and still hard to read are refused as a set', () => {
  const dense = [
    '- Instrumentation facilitates deterministic reconciliation.',
    '- Persistence guarantees idempotent materialization.',
    '- Subsequent invocations utilize authoritative configuration.',
  ].join('\n');
  const refusal = prBodyRefusal(dense);
  assert.match(refusal ?? '', /reading ease/);
  assert.match(refusal ?? '', /read hardest/);
});

test('identifiers in backticks are never counted against the prose', () => {
  assert.equal(prBodyRefusal('- Adds `SyncCursorStore.recordCursor` and calls it after each page.'), null);
});
