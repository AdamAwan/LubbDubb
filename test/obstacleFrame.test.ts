import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripOwnFrame } from '../src/knowledge/frame.js';
import { claimKey, claimsMatch } from '../src/claims.js';

test('the caller’s own ref comes out, in every spelling an agent types', () => {
  for (const spelling of ['PR 512', 'pr:512', 'PR#512', '#512', 'pull request 512', 'pull-request 512']) {
    const framed = stripOwnFrame(`test X is flaky and nothing to do with ${spelling}`, 'pr:512');
    assert.equal(framed.removed, 'pr:512', `${spelling} was not recognised`);
    assert.equal(framed.claim, 'test X is flaky', `${spelling} left ${framed.claim}`);
  }
  assert.equal(stripOwnFrame('flaky on pr:512', 'pr:512:ci').removed, 'pr:512');
  assert.equal(stripOwnFrame('the seed fails, see issue 41', 'issue:41').removed, 'issue:41');
  assert.equal(stripOwnFrame('the pool holds 41 connections', 'issue:41').removed, null);
  assert.equal(stripOwnFrame('flaky on pr:5120', 'pr:512').removed, null);
});

test('nothing is judged, ranked or rewritten — only a ref the harness holds', () => {
  const other = 'The Azure suite shares one work-item pool, which is what pr:۹ trips over';
  assert.deepEqual(stripOwnFrame(other, 'issue:41'), { claim: other, removed: null });
  const kept = stripOwnFrame('the retry loop is wrong in pr:512, and the backoff too', 'pr:512');
  assert.ok(kept.claim.includes('the backoff too'), `a real clause was deleted: ${kept.claim}`);
  assert.deepEqual(stripOwnFrame('pr:512', 'pr:512'), { claim: 'pr:512', removed: null });
});

test('the strip is what lets two agents on two goals agree at all', () => {
  const first = 'test X is flaky and nothing to do with PR 512';
  const second = 'test X is flaky and nothing to do with PR 733';
  assert.ok(!claimsMatch(claimKey(first), claimKey(second)), 'the framed pair must be what fails to match');
  assert.ok(
    claimsMatch(claimKey(stripOwnFrame(first, 'pr:512').claim), claimKey(stripOwnFrame(second, 'pr:733').claim)),
    'and the unframed pair must be one claim',
  );
});
