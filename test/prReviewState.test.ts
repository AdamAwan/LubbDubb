import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { prReviewState } from '../src/review/prReviewState.js';
import type { PrReviewReading } from '../src/review/prReview.js';
import { DEFAULT_PR_REVIEW, type PrReviewPolicy } from '../src/review/policy.js';
import type { PrReview, PrReviewRoute } from '../src/types.js';

/**
 * The reading the cockpit's review mark is drawn from
 * (`docs/spec/17-cockpit.md#the-fleet-reviews-mark`).
 *
 * A pure lens, so a unit test rather than the `buildSystem` seam — what is being
 * asserted is which of six answers a set of rows means, and every one of them is
 * a state an operator will meet.
 */
function reading(over: Partial<PrReviewReading> = {}): PrReviewReading {
  return { review: null, route: null, elsewhere: new Set(), ...over };
}

function policy(over: Partial<PrReviewPolicy> = {}): PrReviewPolicy {
  return { ...DEFAULT_PR_REVIEW, enabled: true, modes: { deep: {}, quick: {} }, ...over };
}

const ROUTE: PrReviewRoute = {
  prNumber: 7,
  mode: 'quick',
  skipped: false,
  reason: 'One file, one predicate.',
  agentId: 'agent_route',
  decidedAt: '2026-01-01T00:00:00.000Z',
};

const REVIEW: PrReview = {
  prNumber: 7,
  headSha: 'abc1234def',
  verdict: 'findings',
  summary: 'Trims the list to a budget.',
  findings: ['The budget is read inside the loop.'],
  agentId: 'agent_review',
  reviewedAt: '2026-01-01T01:00:00.000Z',
  publishedThread: null,
};

test('the review off draws no mark at all', () => {
  assert.equal(prReviewState(7, reading(), DEFAULT_PR_REVIEW), null);
});

test('no route, with a triage to take one, reads as deciding', () => {
  assert.equal(prReviewState(7, reading(), policy())?.status, 'deciding');
});

test('one mode is not a decision, so the same rows read as routed to it', () => {
  const state = prReviewState(7, reading(), policy({ modes: { deep: {} } }));
  assert.equal(state?.status, 'routed');
  assert.equal(state?.mode, 'deep');
});

test('a route with no verdict carries the mode and the triage’s own words', () => {
  const state = prReviewState(7, reading({ route: ROUTE }), policy());
  assert.equal(state?.status, 'routed');
  assert.equal(state?.mode, 'quick');
  assert.equal(state?.routeReason, ROUTE.reason);
  assert.equal(state?.reviewedAt, null);
});

test('a verdict wins over the route it was taken under, and carries the findings', () => {
  const state = prReviewState(7, reading({ route: ROUTE, review: REVIEW }), policy());
  assert.equal(state?.status, 'findings');
  assert.equal(state?.mode, 'quick');
  assert.deepEqual(state?.findings, REVIEW.findings);
  assert.equal(state?.summary, REVIEW.summary);
  assert.equal(state?.agentId, 'agent_review');
  assert.equal(state?.routeAgentId, 'agent_route');
});

test('a clear verdict is its own status, not an empty findings list', () => {
  const state = prReviewState(7, reading({ review: { ...REVIEW, verdict: 'clear', findings: [] } }), policy());
  assert.equal(state?.status, 'clear');
});

test('a skip reads as skipped only where the project still allows one', () => {
  const skip = reading({ route: { ...ROUTE, skipped: true, reason: 'A version bump.' } });
  assert.equal(prReviewState(7, skip, policy({ allowSkip: true }))?.status, 'skipped');
  // `allowSkip` back off falls the standing skip back to a review — the same
  // direction `reviewSkipped` takes for the gate, so the mark cannot say the
  // merge is clear while the gate holds it.
  assert.equal(prReviewState(7, skip, policy())?.status, 'routed');
});

test('a review taken outside the harness stands over the missing verdict', () => {
  const state = prReviewState(7, reading({ elsewhere: new Set([7]) }), policy());
  assert.equal(state?.status, 'elsewhere');
  // And says nothing about another pull request's number.
  assert.equal(prReviewState(8, reading({ elsewhere: new Set([7]) }), policy())?.status, 'deciding');
});

/**
 * And that it reaches the cockpit at all: the mark is drawn off the wire, so a
 * lens nothing folds onto the row is a lens no operator ever sees.
 */
test('the snapshot ships the reading on the pull request’s row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    review: policy({ blocking: false }),
  });
  // `worktrees` is injected, or a dispatch cuts a real branch in this checkout.
  const system = buildSystem(config, {
    backend: new FakePtyBackend(),
    sink: undefined,
    worktrees: new FakeWorktreeManager(),
  });
  system.connector.inject({ kind: 'new_pr', number: 7, title: 'A change', branch: 'feature-7' });
  await system.harness.runCycle('manual');
  system.store.recordPrReview({ ...REVIEW, verdict: 'clear', findings: [] });

  const pr = buildStateSnapshot(system).world.pullRequests.find((p) => p.number === 7);
  assert.equal(pr?.review?.status, 'clear');
  assert.equal(pr?.review?.summary, REVIEW.summary);
});
