import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prHealth, isConflicted, needsBaseUpdate } from '../src/prHealth.js';
import type { PullRequest } from '../src/types.js';

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return { id: 'p', number: 1, title: 'X', branch: 'feat', ciStatus: 'passing', unresolvedComments: [], ...over };
}

test('a clean, green, comment-free PR is healthy', () => {
  const h = prHealth(pr({ mergeableState: 'clean', mergeable: true }));
  assert.equal(h.blocked, false);
  assert.deepEqual(h.reasons, []);
});

test('a dirty PR is conflicted, blocked, and needs a base update', () => {
  const p = pr({ mergeableState: 'dirty', mergeable: false });
  assert.equal(isConflicted(p), true);
  assert.equal(needsBaseUpdate(p), true);
  assert.deepEqual(prHealth(p).reasons, ['merge conflicts']);
});

test('unknown state + mergeable:false falls back to conflicted', () => {
  const p = pr({ mergeableState: 'unknown', mergeable: false });
  assert.equal(isConflicted(p), true);
  assert.equal(needsBaseUpdate(p), true);
});

test('behind base is a clean update, not a conflict', () => {
  const p = pr({ mergeableState: 'behind', mergeable: true });
  assert.equal(isConflicted(p), false);
  assert.equal(needsBaseUpdate(p), true);
  assert.deepEqual(prHealth(p).reasons, ['behind base branch']);
});

test('blocked is surfaced but never auto-acted', () => {
  const p = pr({ mergeableState: 'blocked', mergeable: true });
  assert.equal(needsBaseUpdate(p), false);
  assert.deepEqual(prHealth(p).reasons, ['merge blocked (required checks/reviews)']);
});

test('health folds CI, conflicts and comments together', () => {
  const p = pr({
    ciStatus: 'failing',
    mergeableState: 'dirty',
    mergeable: false,
    unresolvedComments: [{ id: 'c1', author: 'bob', body: 'x', handled: false }],
  });
  assert.deepEqual(prHealth(p).reasons, ['CI failing', 'merge conflicts', '1 unresolved comment']);
  assert.equal(prHealth(p).blocked, true);
});

test('a merged PR is done, never blocked, never needs an update', () => {
  const p = pr({ merged: true, mergeableState: 'dirty', mergeable: false });
  assert.equal(prHealth(p).blocked, false);
  assert.equal(needsBaseUpdate(p), false);
  assert.equal(isConflicted(p), false);
});
