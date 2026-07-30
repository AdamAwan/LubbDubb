import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ciNeedsAttention, isStackedPr, prHealth, isConflicted, needsBaseUpdate } from '../src/prHealth.js';
import type { PullRequest } from '../src/types.js';

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return { id: 'p', number: 1, title: 'X', branch: 'feat', ciStatus: 'passing', unresolvedComments: [], ...over };
}

test('a clean, green, comment-free PR is healthy', () => {
  const h = prHealth(pr({ mergeableState: 'clean', mergeable: true }));
  assert.equal(h.blocked, false);
  assert.deepEqual(h.reasons, []);
});

test('ciNeedsAttention: true for a PR failing only on a check outside the aggregate', () => {
  // An Azure "Optional" branch policy: it really failed, and an agent really can
  // fix it, but the provider will complete the PR with it red.
  const p = pr({
    ciStatus: 'passing',
    ciChecks: [{ name: 'Dotnet Code Format Validation', status: 'failing', blocking: false }],
  });
  assert.equal(ciNeedsAttention(p), true);
});

test('ciNeedsAttention: false when the only failing check is advisory', () => {
  const p = pr({
    ciStatus: 'passing',
    ciChecks: [{ name: 'Comment requirements', status: 'failing', blocking: true, advisory: true }],
  });
  assert.equal(ciNeedsAttention(p), false);
});

test('ciNeedsAttention: true off the aggregate alone, for a provider reporting no per-check detail', () => {
  assert.equal(ciNeedsAttention(pr({ ciStatus: 'failing' })), true);
  assert.equal(ciNeedsAttention(pr({ ciStatus: 'passing' })), false);
});

test('prHealth: an Optional failure alone leaves the PR unblocked', () => {
  // `prHealth` answers "can this merge", and the provider would complete this PR.
  // Dispatching a fix and reporting the PR unmergeable are different claims.
  const p = pr({
    ciStatus: 'passing',
    ciChecks: [{ name: 'Dotnet Code Format Validation', status: 'failing', blocking: false }],
  });
  assert.deepEqual(prHealth(p), { blocked: false, reasons: [] });
});

test('prHealth: the failing-check suffix names only checks that hold the merge', () => {
  const p = pr({
    ciStatus: 'failing',
    ciChecks: [
      { name: 'Build-dotnet', status: 'failing', blocking: true },
      { name: 'Dotnet Code Format Validation', status: 'failing', blocking: false },
      { name: 'Comment requirements', status: 'failing', blocking: true, advisory: true },
    ],
  });
  assert.deepEqual(prHealth(p).reasons, ['CI failing: Build-dotnet']);
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

test('a PR targeting anything but the integration branch is stacked', () => {
  // The merge rule fires on green + approved, which on a stack would merge part 2
  // into part 1's branch mid-flight rather than into the default branch.
  assert.equal(isStackedPr(pr({ baseBranch: 'issue/12/schema' }), 'main'), true);
  assert.equal(isStackedPr(pr({ baseBranch: 'main' }), 'main'), false);
  // Unknown must not silently stop merging PRs that merged fine before.
  assert.equal(isStackedPr(pr({}), 'main'), false);
});
