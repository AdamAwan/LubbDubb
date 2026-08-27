import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import {
  charterNote,
  defaultReviewMode,
  needsFleetReview,
  resolvedReviewMode,
  reviewSatisfied,
  routesBetweenModes,
} from '../src/review/prReview.js';
import { DEFAULT_PR_REVIEW } from '../src/review/policy.js';
import type { PrReview, PrReviewRoute, PullRequest } from '../src/types.js';
import { findTask } from './support/tasks.js';

/**
 * The fleet review (rule `pr-review`): the harness reads a pull request of its
 * own before a person is asked to. → `docs/spec/07-pull-requests.md#the-fleet-review`
 */
function build(review: Partial<typeof DEFAULT_PR_REVIEW> = {}, repoRoot?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    review: { ...DEFAULT_PR_REVIEW, ...review },
    ...(repoRoot === undefined ? {} : { repoRoot }),
  });
  // `worktrees` is injected, or the dispatch cuts a real branch in whatever
  // checkout the suite is running in (CLAUDE.md).
  const worktrees = new FakeWorktreeManager();
  const system = buildSystem(config, { backend: new FakePtyBackend(), sink: undefined, worktrees });
  return { system, worktrees };
}

test('off by default: an open pull request is not reviewed', async () => {
  const { system } = build();
  system.connector.inject({ kind: 'new_pr', number: 7, title: 'A change', branch: 'feature-7' });
  await system.harness.runCycle('manual');

  assert.equal(
    findTask(system.store, (t) => t.originRef === 'pr:7:review'),
    undefined,
  );
  system.store.close();
});

test('on: the review is dispatched the pulse the pull request appears, read-only, on its own origin', async () => {
  const { system, worktrees } = build({ enabled: true });
  system.connector.inject({ kind: 'new_pr', number: 7, title: 'A change', branch: 'feature-7' });
  await system.harness.runCycle('manual');

  const task = findTask(system.store, (t) => t.originRef === 'pr:7:review');
  assert.ok(task, 'the review leads the PR concerns, so it takes the first free slot');
  assert.equal(task!.rule, 'pr-review');
  // A read-only checkout *of* the branch, never the branch itself: the reviewer
  // must not be able to commit what it found, and must not hold the lease a CI
  // fix needs.
  assert.equal(task!.branch, 'review/pr-7');
  assert.deepEqual(
    worktrees.ensured.filter((e) => e.branch === 'review/pr-7'),
    [{ branch: 'review/pr-7', base: 'feature-7', readOnly: true }],
  );
  system.store.close();
});

test('one round: a recorded verdict ends the concern, and no push brings it back', async () => {
  const { system } = build({ enabled: true });
  system.connector.inject({ kind: 'new_pr', number: 8, title: 'A change', branch: 'feature-8' });
  await system.harness.runCycle('manual');
  assert.ok(findTask(system.store, (t) => t.originRef === 'pr:8:review'));

  system.store.recordPrReview({
    prNumber: 8,
    headSha: 'abc123',
    verdict: 'findings',
    summary: 'Adds a cache with no eviction.',
    findings: ['src/cache.ts grows without bound'],
    agentId: null,
  });
  // The world moves the way a fix moves it — a new commit, and with it a head the
  // review never read. Keyed on the SHA this would re-review forever; keyed on
  // the pull request it is done.
  system.connector.inject({ kind: 'ci_passed', prNumber: 8 });
  await system.harness.runCycle('manual');

  const tasks = system.store.listTasks().filter((t) => t.originRef === 'pr:8:review');
  assert.equal(tasks.length, 1, 'nothing re-reviews a pull request the fleet has already read');
  system.store.close();
});

test('the merge gate holds an unreviewed pull request, and releases it on any verdict', async () => {
  const { system } = build({ enabled: true });
  system.connector.inject({ kind: 'new_pr', number: 9, title: 'A change', branch: 'feature-9' });
  system.connector.inject({ kind: 'ci_passed', prNumber: 9 });
  system.connector.inject({ kind: 'pr_approved', prNumber: 9 });
  system.connector.inject({ kind: 'pr_mergeable', prNumber: 9, mergeable: true, mergeableState: 'clean' });
  await system.harness.runCycle('manual');

  const merges = () => system.store.listDecisions().filter((d) => d.action.type === 'merge_pr');
  assert.equal(merges().length, 0, 'green, approved and mergeable is not enough while nobody has read it');

  system.store.recordPrReview({
    prNumber: 9,
    headSha: null,
    // A `findings` verdict releases the gate too: with one round nothing could
    // ever clear it, so gating on `clear` would wedge the pull request. What the
    // findings do is reach the person whose approval the merge still needs.
    verdict: 'findings',
    summary: 'Renames a field used in two places.',
    findings: ['web/src/types.ts still names the old field'],
    agentId: null,
  });
  await system.harness.runCycle('manual');
  assert.equal(merges().length, 1);
  system.store.close();
});

test('it stands down while a human reviewer has unhandled threads open', async () => {
  const { system } = build({ enabled: true });
  system.connector.inject({ kind: 'new_pr', number: 10, title: 'A change', branch: 'feature-10' });
  system.connector.inject({ kind: 'pr_comment', prNumber: 10, author: 'alice', body: 'try another approach' });
  await system.harness.runCycle('manual');

  assert.equal(
    findTask(system.store, (t) => t.originRef === 'pr:10:review'),
    undefined,
    'the diff is about to be rewritten, so a reading of the old one is spent for nothing',
  );
  // The comment concern is what the branch gets instead.
  assert.ok(findTask(system.store, (t) => t.originRef === 'pr:10:comments'));
  system.store.close();
});

test("the project's charter reaches the reviewer's prompt, from the checkout", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'lubbdubb-repo-'));
  writeFileSync(join(repoRoot, 'review-charter.md'), 'Every colour is a token. Never a hex.');
  const { system } = build({ enabled: true, modes: { deep: { charterFile: 'review-charter.md' } } }, repoRoot);
  system.connector.inject({ kind: 'new_pr', number: 11, title: 'A change', branch: 'feature-11' });
  await system.harness.runCycle('manual');

  const task = findTask(system.store, (t) => t.originRef === 'pr:11:review');
  assert.ok(task);
  const prompt = system.store.getTask(task!.id)!.prompt;
  assert.match(prompt, /Every colour is a token\. Never a hex\./);
  // Appended under a heading that says whose words they are, so a reviewer can
  // weigh them against what it is actually reading.
  assert.match(prompt, /What this project asks a "deep" review to look at/);
  system.store.close();
});

test('the predicates are one reading: unknown is never clear, and off gates nothing', () => {
  const pr = { number: 3, merged: false, unresolvedComments: [] } as unknown as PullRequest;
  const on = { ...DEFAULT_PR_REVIEW, enabled: true };
  const review: PrReview = {
    prNumber: 3,
    headSha: null,
    verdict: 'clear',
    summary: 'ok',
    findings: [],
    agentId: null,
    reviewedAt: '2026-01-01T00:00:00.000Z',
  };

  assert.equal(needsFleetReview(pr, null, on), true);
  assert.equal(needsFleetReview(pr, review, on), false);
  assert.equal(needsFleetReview(pr, null, DEFAULT_PR_REVIEW), false, 'off proposes nothing');

  assert.equal(reviewSatisfied(null, on), false, 'a pull request nobody read is held');
  assert.equal(reviewSatisfied(review, on), true);
  assert.equal(reviewSatisfied(null, { ...on, blocking: false }), true, 'record-only gates nothing');
  assert.equal(reviewSatisfied(null, DEFAULT_PR_REVIEW), true, 'off is the build without the feature');

  assert.equal(charterNote(null, 'Heading'), '');
  assert.equal(charterNote('   ', 'Heading'), '', 'an empty file is no charter, not an empty heading');
});

test('with two modes declared, the triage runs first and the review waits for it', async () => {
  const { system } = build({
    enabled: true,
    modes: { deep: { charterFile: null, profile: null }, quick: { charterFile: null, profile: null } },
  });
  system.connector.inject({ kind: 'new_pr', number: 12, title: 'A change', branch: 'feature-12' });
  await system.harness.runCycle('manual');

  const triage = findTask(system.store, (t) => t.originRef === 'pr:12:review-triage');
  assert.ok(triage, 'the routing is decided before anything reads the diff');
  assert.equal(triage!.rule, 'pr-review-triage');
  assert.equal(triage!.branch, null, 'a desk agent: no worktree, no pool slot, no repository read');
  assert.equal(
    findTask(system.store, (t) => t.originRef === 'pr:12:review'),
    undefined,
    'dispatching now would price the review on a mode nothing has chosen yet',
  );

  system.store.recordPrReviewRoute({ prNumber: 12, mode: 'quick', reason: 'A copy change.', agentId: null });
  await system.harness.runCycle('manual');

  const review = findTask(system.store, (t) => t.originRef === 'pr:12:review');
  assert.ok(review);
  assert.match(review!.title, /\(quick\)$/, 'the row says which mode ran, so a misroute is visible');
  system.store.close();
});

test('one declared mode is not a decision: no triage, and the review runs it', async () => {
  const { system } = build({ enabled: true, modes: { deep: { charterFile: null, profile: null } } });
  system.connector.inject({ kind: 'new_pr', number: 13, title: 'A change', branch: 'feature-13' });
  await system.harness.runCycle('manual');

  assert.equal(
    findTask(system.store, (t) => t.originRef === 'pr:13:review-triage'),
    undefined,
  );
  const review = findTask(system.store, (t) => t.originRef === 'pr:13:review');
  assert.ok(review, 'nothing is spent choosing between one thing');
  assert.match(review!.title, /\(deep\)$/);
  system.store.close();
});

test('the mode carries its profile onto the dispatch', async () => {
  const { system } = build({
    enabled: true,
    modes: { deep: { charterFile: null, profile: 'heavy' }, quick: { charterFile: null, profile: 'light' } },
  });
  system.connector.inject({ kind: 'new_pr', number: 14, title: 'A change', branch: 'feature-14' });
  system.store.recordPrReviewRoute({ prNumber: 14, mode: 'quick', reason: 'A copy change.', agentId: null });
  await system.harness.runCycle('manual');

  const review = findTask(system.store, (t) => t.originRef === 'pr:14:review');
  assert.ok(review);
  const dispatched = system.store
    .listDecisions()
    .find((d) => d.action.type === 'dispatch_code_agent' && d.action.originRef === 'pr:14:review');
  assert.equal(
    (dispatched?.action as { profile?: string } | undefined)?.profile,
    'light',
    'the routing decision is about money as well as attention',
  );
  system.store.close();
});

test('routing predicates: one mode is no choice, and an unknown route reads as the default', () => {
  const modes = {
    deep: { charterFile: null, profile: null },
    quick: { charterFile: null, profile: null },
  };
  const one = { ...DEFAULT_PR_REVIEW, enabled: true, modes: { deep: modes.deep } };
  const two = { ...DEFAULT_PR_REVIEW, enabled: true, modes };
  const route = (mode: string): PrReviewRoute => ({
    prNumber: 1,
    mode,
    reason: 'because',
    agentId: null,
    decidedAt: '2026-01-01T00:00:00.000Z',
  });

  assert.equal(routesBetweenModes(one), false, 'a decision with one option is not a decision');
  assert.equal(routesBetweenModes(two), true);
  assert.equal(routesBetweenModes(DEFAULT_PR_REVIEW), false);

  // Fail open onto the thorough mode: null default takes the first declared, which
  // is why the spec tells a project to declare that one first.
  assert.equal(defaultReviewMode(two), 'deep');
  assert.equal(defaultReviewMode({ ...two, defaultMode: 'quick' }), 'quick');
  assert.equal(defaultReviewMode(DEFAULT_PR_REVIEW), null, 'no modes is no mode, not an invented one');

  assert.equal(resolvedReviewMode(route('quick'), two), 'quick');
  assert.equal(resolvedReviewMode(null, two), 'deep', 'a triage that never answered still gets a review');
  assert.equal(
    resolvedReviewMode(route('gone'), two),
    'deep',
    'a mode the project has removed has no charter or profile behind it, so it is not honoured',
  );
});

test('a triage that spent its attempts fails open: the review runs the default mode', async () => {
  const { system } = build({
    enabled: true,
    defaultMode: 'deep',
    modes: { quick: { charterFile: null, profile: null }, deep: { charterFile: null, profile: null } },
  });
  system.connector.inject({ kind: 'new_pr', number: 15, title: 'A change', branch: 'feature-15' });
  // The attempt ledger the rule and the lens both read: three executed dispatches
  // on the triage origin that never produced a route. Written directly because the
  // point under test is what the *review* does once the routing has given up, and
  // the cap is the only way it ever does.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    system.store.recordDecision({
      cycleId: `spent-${attempt}`,
      action: {
        type: 'dispatch_desk_agent',
        originRef: 'pr:15:review-triage',
        title: 'Choose how to review PR #15',
        reason: 'spent',
      },
      outcome: 'executed',
      detail: 'spent',
    });
  }
  await system.harness.runCycle('manual');

  const review = findTask(system.store, (t) => t.originRef === 'pr:15:review');
  assert.ok(review, 'a routing that never answered must not park the pull request');
  // Onto the thorough mode, not the cheap one: over-reading a small change costs
  // minutes, under-reading a dangerous one costs the defect nobody caught.
  assert.match(review!.title, /\(deep\)$/);
  system.store.close();
});
