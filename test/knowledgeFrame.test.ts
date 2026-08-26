import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripOwnFrame } from '../src/knowledge/frame.js';
import { validateRaise } from '../src/knowledge/knowledge.js';
import { claimKey, claimsMatch } from '../src/claims.js';

/**
 * Taking the caller's own task out of the claim it raised
 * (`docs/spec/27-knowledge.md#the-frame-is-not-the-claim`).
 *
 * The expensive half is not the wording — it is that the ref sits **inside the
 * claim key**, so no other agent's sentence can equal it or contain it, and the
 * claim most in need of being found again is the one `claimsMatch` can never find.
 * What is asserted here is that half: two agents who hit one wall on two goals
 * come out matching, where before they came out as two singletons.
 *
 * And the other invariant, which has no test that could catch it later: the edit
 * is **mechanical**. Nothing here judges prose, so a claim that names no ref of
 * the caller's comes back byte for byte.
 */

test('the caller’s own ref comes out, in every spelling an agent types', () => {
  for (const spelling of ['PR 512', 'pr:512', 'PR#512', '#512', 'pull request 512', 'pull-request 512']) {
    const framed = stripOwnFrame(`test X is flaky and nothing to do with ${spelling}`, 'pr:512');
    assert.equal(framed.removed, 'pr:512', `${spelling} was not recognised`);
    assert.equal(framed.claim, 'test X is flaky', `${spelling} left ${framed.claim}`);
  }
  // The dispatch origin's suffix is the same pull request: `pr:512:ci` and
  // `pr:512` are one world item, as they are everywhere else here.
  assert.equal(stripOwnFrame('flaky on pr:512', 'pr:512:ci').removed, 'pr:512');
  // An issue reads its own vocabulary, and a bare number is deliberately not one
  // of the spellings: on its own it is as likely to be a port or a status code.
  assert.equal(stripOwnFrame('the seed fails, see issue 41', 'issue:41').removed, 'issue:41');
  assert.equal(stripOwnFrame('the pool holds 41 connections', 'issue:41').removed, null);
  // Anchored on the number, so one ref never swallows another's.
  assert.equal(stripOwnFrame('flaky on pr:5120', 'pr:512').removed, null);
});

test('nothing is judged, ranked or rewritten — only a ref the harness holds', () => {
  // A claim naming somebody else's work is about the repository as much as any
  // other claim, and it is left exactly as written.
  const other = 'The Azure suite shares one work-item pool, which is what pr:۹ trips over';
  assert.deepEqual(stripOwnFrame(other, 'issue:41'), { claim: other, removed: null });
  // A tail carrying a word that is not a function word carries an assertion, and
  // it stays where the agent put it — dangling or not. Deleting it would be the
  // classifier this refuses to be.
  const kept = stripOwnFrame('the retry loop is wrong in pr:512, and the backoff too', 'pr:512');
  assert.ok(kept.claim.includes('the backoff too'), `a real clause was deleted: ${kept.claim}`);
  // A claim that was only its own ref is one the harness cannot improve, so it is
  // filed as written: a refusal an agent cannot satisfy is a claim lost, and a
  // lost claim is the one outcome this store cannot recover from.
  assert.deepEqual(stripOwnFrame('pr:512', 'pr:512'), { claim: 'pr:512', removed: null });
});

test('the strip is what lets two agents on two goals agree at all', () => {
  // The whole cost, in one assertion. Two agents hit one wall, each frames it for
  // whoever is reading their own task, and `claimsMatch` answers no — so the
  // second files a copy, the gate never fires, and both sit at proposal reaching
  // nobody.
  const first = 'test X is flaky and nothing to do with PR 512';
  const second = 'test X is flaky and nothing to do with PR 733';
  assert.ok(!claimsMatch(claimKey(first), claimKey(second)), 'the framed pair must be what fails to match');
  assert.ok(
    claimsMatch(claimKey(stripOwnFrame(first, 'pr:512').claim), claimKey(stripOwnFrame(second, 'pr:733').claim)),
    'and the unframed pair must be one claim',
  );
});

test('raise keeps the agent’s own sentence verbatim, and never refuses over framing', () => {
  const parsed = validateRaise(
    { claim: 'test X is flaky and nothing to do with PR 512', evidence: 'Re-ran it on a clean tree: green.' },
    'pr:512',
  );
  assert.ok(parsed.ok);
  assert.equal(parsed.proposal.claim, 'test X is flaky');
  assert.equal(parsed.framing.removed, 'pr:512');
  // The agent's original wording, first and verbatim — where the task context has
  // always belonged, and what an operator reads to decide whether the fleet should
  // be told this.
  assert.ok(parsed.proposal.evidence.startsWith('As raised: test X is flaky and nothing to do with PR 512'));
  assert.ok(parsed.proposal.evidence.includes('Re-ran it on a clean tree: green.'));

  // `aboutRef` is never `originRef`, arriving at the same rule from the other end:
  // a claim filed as being *about* its own goal would carry the ref straight back
  // into the row the strip took it out of.
  const own = validateRaise(
    { claim: 'The seed script runs before the migrations.', evidence: 'saw it', ref: 'pr:512' },
    'pr:512',
  );
  assert.ok(own.ok);
  assert.equal(own.proposal.aboutRef, null);
  // Somebody else's work is exactly what the field is for, and is kept.
  const theirs = validateRaise(
    { claim: 'The seed script runs before the migrations.', evidence: 'saw it', ref: 'pr:733' },
    'pr:512',
  );
  assert.ok(theirs.ok);
  assert.equal(theirs.proposal.aboutRef, 'pr:733');

  // Nothing added when nothing was removed: an evidence field that quietly gained
  // a copy of the claim on every call would be a second copy of it on every row.
  const clean = validateRaise({ claim: 'knip runs every rule at error.', evidence: 'check went red' }, 'pr:512');
  assert.ok(clean.ok);
  assert.equal(clean.framing.removed, null);
  assert.equal(clean.proposal.evidence, 'check went red');
});
