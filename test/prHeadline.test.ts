import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prHeadline } from '../web/src/view/prHeadline.js';

test('prHeadline takes the goal, stack and commit-type prefixes off a title', () => {
  assert.equal(
    prHeadline('#390 [2/3] feat(checkout): take card payment through the new provider'),
    'Take card payment through the new provider',
  );
  assert.equal(prHeadline('fix: retry on a 429'), 'Retry on a 429');
  assert.equal(prHeadline('Update dependency dotenv to v17'), 'Update dependency dotenv to v17');
});

test('prHeadline leaves a title that is nothing but a prefix whole', () => {
  assert.equal(prHeadline('#390 [1/2]'), '#390 [1/2]');
});
