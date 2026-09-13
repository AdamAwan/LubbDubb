import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstLine, median, prNumberOf } from '../src/primitives.js';

test('firstLine takes the first non-blank line, trimmed and capped at 200 characters', () => {
  assert.equal(firstLine('\n  \n  the query failed  \nmore\n'), 'the query failed');
  assert.equal(firstLine(''), null);
  assert.equal(firstLine('  \n\t\n'), null);
  assert.equal(firstLine('x'.repeat(250)), 'x'.repeat(200));
});

test('median is the upper middle sample, and null for no samples', () => {
  assert.equal(median([]), null);
  assert.equal(median([7]), 7);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 3);
});

test('median leaves its input untouched', () => {
  const samples = [3, 1, 2];
  median(samples);
  assert.deepEqual(samples, [3, 1, 2]);
});

test('prNumberOf reads only a bare pr ref', () => {
  assert.equal(prNumberOf('pr:12'), 12);
  assert.equal(prNumberOf('pr:12:ci'), null);
  assert.equal(prNumberOf('issue:12'), null);
  assert.equal(prNumberOf('pr:'), null);
});
