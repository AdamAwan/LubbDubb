import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseByteRange } from '../src/server/byteRange.js';

// → docs/spec/16-http-api.md#byte-ranges

test('a single byte range is read, clamped to the file, and anything else serves the whole file', () => {
  assert.deepEqual(parseByteRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange('bytes=500-', 1000), { start: 500, end: 999 });
  assert.deepEqual(parseByteRange('bytes=-100', 1000), { start: 900, end: 999 }, 'a suffix is the last n bytes');
  assert.deepEqual(parseByteRange('bytes=900-5000', 1000), { start: 900, end: 999 }, 'an end past the file is clamped');
  assert.equal(parseByteRange(undefined, 1000), null);
  assert.equal(parseByteRange('bytes=0-1,5-9', 1000), null, 'several ranges get the whole file');
  assert.equal(parseByteRange('items=0-1', 1000), null);
  assert.equal(parseByteRange('bytes=-', 1000), null);
});

test('a range that starts past the end, or runs backwards, cannot be satisfied', () => {
  assert.equal(parseByteRange('bytes=1000-', 1000), 'unsatisfiable');
  assert.equal(parseByteRange('bytes=9-3', 1000), 'unsatisfiable');
  assert.equal(parseByteRange('bytes=-0', 1000), 'unsatisfiable');
  assert.equal(parseByteRange('bytes=-10', 0), 'unsatisfiable');
});
