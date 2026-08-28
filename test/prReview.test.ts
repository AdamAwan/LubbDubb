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
  reviewSkipped,
  routesBetweenModes,
  triageRuns,
} from '../src/review/prReview.js';
import { prsToStampReviewIntake, withinReviewIntake } from '../src/review/intake.js';
import { FakeReviewProber } from '../src/review/fakeReviewProber.js';
import type { PrReviewReading } from '../src/review/prReview.js';

/** A reading with only what a case is about set; every other arm reads as "no row". */
function reading(over: Partial<PrReviewReading> = {}): PrReviewReading {
  return { review: null, route: null, intake: new Map(), elsewhere: new Set(), ...over };
}
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

  // Within the intake: the harness watched this pull request appear, so the review
  // is for it. The guard's own arm is exercised in the backfill test below.
  const intake = new Map([[3, true]]);

  assert.equal(needsFleetReview(pr, reading({ intake }), on), true);
  assert.equal(needsFleetReview(pr, reading({ intake, review }), on), false);
  assert.equal(needsFleetReview(pr, reading({ intake }), DEFAULT_PR_REVIEW), false, 'off proposes nothing');

  assert.equal(reviewSatisfied(pr, reading({ intake }), on), false, 'a pull request nobody read is held');
  assert.equal(reviewSatisfied(pr, reading({ intake, review }), on), true);
  assert.equal(reviewSatisfied(pr, reading({ intake }), { ...on, blocking: false }), true, 'record-only gates nothing');
  assert.equal(
    reviewSatisfied(pr, reading({ intake }), DEFAULT_PR_REVIEW),
    true,
    'off is the build without the feature',
  );

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

  system.store.recordPrReviewRoute({
    prNumber: 12,
    mode: 'quick',
    skipped: false,
    reason: 'A copy change.',
    agentId: null,
  });
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
  system.store.recordPrReviewRoute({
    prNumber: 14,
    mode: 'quick',
    skipped: false,
    reason: 'A copy change.',
    agentId: null,
  });
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
    skipped: false,
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

// --------------------------------------------------------------------------
// The backfill guard
// --------------------------------------------------------------------------

/** Long enough ago to be outside two pulses of the window the intake reads. */
const LAST_MONTH = '2026-07-01T00:00:00.000Z';

test('the backlog is not reviewed: switching the review on catches the open set up silently', async () => {
  const { system } = build({ enabled: true });
  // Three pull requests already open on the pulse the review is switched on, and
  // green, approved and mergeable — the exact shape a team adopting this has.
  for (const n of [20, 21, 22]) {
    system.connector.inject({
      kind: 'new_pr',
      number: n,
      title: `Change ${n}`,
      branch: `feature-${n}`,
      openedAt: LAST_MONTH,
    });
    system.connector.inject({ kind: 'ci_passed', prNumber: n });
    system.connector.inject({ kind: 'pr_approved', prNumber: n });
    system.connector.inject({ kind: 'pr_mergeable', prNumber: n, mergeable: true, mergeableState: 'clean' });
  }
  await system.harness.runCycle('manual');

  assert.deepEqual(
    system.store
      .listTasks()
      .filter((t) => (t.originRef ?? '').endsWith(':review'))
      .map((t) => t.originRef),
    [],
    'twenty open pull requests would be twenty agents on one pulse — the guard is that none of them is',
  );
  // The sharp half. A pull request nothing will ever review must not be a pull
  // request nothing can merge, or the guard trades wasted reviews for wedged
  // branches — the same harm, wearing the fix.
  assert.equal(
    system.store.listDecisions().filter((d) => d.action.type === 'merge_pr').length,
    3,
    'the merge gate holds only where a review is genuinely still coming',
  );

  // And the stamp is what makes it silent rather than one pulse late: the ledger
  // has judged all three, so the next pulse re-judges none of them.
  await system.harness.runCycle('manual');
  assert.equal(
    system.store.listTasks().filter((t) => (t.originRef ?? '').endsWith(':review')).length,
    0,
    'a guard that re-derived its answer from the world would hand the backlog over on the next pulse',
  );
  system.store.close();
});

test('and the next pull request is: the review speaks for what the harness watched appear', async () => {
  const { system } = build({ enabled: true });
  system.connector.inject({
    kind: 'new_pr',
    number: 23,
    title: 'Old work',
    branch: 'feature-23',
    openedAt: LAST_MONTH,
  });
  await system.harness.runCycle('manual');
  assert.equal(
    findTask(system.store, (t) => t.originRef === 'pr:23:review'),
    undefined,
  );

  system.connector.inject({ kind: 'new_pr', number: 24, title: 'New work', branch: 'feature-24' });
  await system.harness.runCycle('manual');

  assert.ok(
    findTask(system.store, (t) => t.originRef === 'pr:24:review'),
    'the pull request opened while the review was watching is the one it is for',
  );
  assert.equal(
    findTask(system.store, (t) => t.originRef === 'pr:23:review'),
    undefined,
    'and the backlog stays out of it — the stamp was taken once',
  );
  system.store.close();
});

test('review.backfill reads the backlog on purpose, and reaches pull requests already stamped', async () => {
  const { system } = build({ enabled: true });
  system.connector.inject({
    kind: 'new_pr',
    number: 25,
    title: 'Old work',
    branch: 'feature-25',
    openedAt: LAST_MONTH,
  });
  await system.harness.runCycle('manual');
  assert.equal(
    findTask(system.store, (t) => t.originRef === 'pr:25:review'),
    undefined,
    'stamped as backlog first, which is the case the live read has to survive',
  );

  // Turned on after the stamp went down. Read live rather than baked into the row,
  // or the switch would be inert on exactly the pull requests it was reached for.
  const on = build({ enabled: true, backfill: true });
  on.system.connector.inject({
    kind: 'new_pr',
    number: 25,
    title: 'Old work',
    branch: 'feature-25',
    openedAt: LAST_MONTH,
  });
  await on.system.harness.runCycle('manual');
  assert.ok(
    findTask(on.system.store, (t) => t.originRef === 'pr:25:review'),
    'a team that wants its backlog read asks for it, and gets it',
  );
  on.system.store.close();
  system.store.close();
});

test('the intake predicates: absent is outside, and backfill is a live read', () => {
  const pr = { number: 4, merged: false, unresolvedComments: [] } as unknown as PullRequest;
  const on = { ...DEFAULT_PR_REVIEW, enabled: true };

  assert.equal(withinReviewIntake(pr, new Map(), on), false, 'unstamped is not the review’s');
  assert.equal(withinReviewIntake(pr, new Map([[4, false]]), on), false, 'stamped as backlog stays backlog');
  assert.equal(withinReviewIntake(pr, new Map([[4, true]]), on), true);
  assert.equal(
    withinReviewIntake(pr, new Map([[4, false]]), { ...on, backfill: true }),
    true,
    'the operator’s switch is read at the point of asking, so it reaches a stamped row',
  );

  // Both halves, so a pull request nothing will review is not one nothing can merge.
  assert.equal(needsFleetReview(pr, reading(), on), false);
  assert.equal(reviewSatisfied(pr, reading(), on), true);
});

test('stamping: the pulse that first sees a pull request judges it, and never re-judges it', () => {
  const now = '2026-08-01T12:00:00.000Z';
  const on = { enabled: true, now, windowMs: 60_000 };
  const fresh = { number: 1, openedAt: '2026-08-01T11:59:30.000Z', unresolvedComments: [] } as unknown as PullRequest;
  const old = { number: 2, openedAt: LAST_MONTH, unresolvedComments: [] } as unknown as PullRequest;
  const undated = { number: 3, unresolvedComments: [] } as unknown as PullRequest;

  // An empty ledger is the first pulse with the review on, so `openedAt` is the
  // only thing separating the two — which is why the field exists.
  assert.deepEqual(prsToStampReviewIntake([fresh, old, undated], { ...on, stamped: new Map() }), [
    { prNumber: 1, watchedOpen: true },
    { prNumber: 2, watchedOpen: false },
    // Cannot say, read as backlog on the first pulse: the safe direction, and the
    // only thing a provider that does not report the field costs.
    { prNumber: 3, watchedOpen: false },
  ]);

  // Once the ledger is asking, every pull request new to it is one of a series —
  // including an undated one, which is what carries a provider that cannot answer.
  assert.deepEqual(
    prsToStampReviewIntake([old, undated], { ...on, stamped: new Map([[9, false]]) }),
    [
      { prNumber: 2, watchedOpen: true },
      { prNumber: 3, watchedOpen: true },
    ],
    'the ledger was already asking before these appeared',
  );

  assert.deepEqual(
    prsToStampReviewIntake([fresh], { ...on, stamped: new Map([[1, false]]) }),
    [],
    // First write wins, and that is what makes eligibility survive a wait: a pull
    // request stood down for unhandled human threads, or held behind a saturated
    // cap, keeps the verdict its first pulse gave it rather than being re-judged
    // against a clock that has since moved past its opening.
    'a stamped pull request is never stamped again',
  );
  assert.deepEqual(prsToStampReviewIntake([fresh], { ...on, enabled: false, stamped: new Map() }), []);
});

// --------------------------------------------------------------------------
// Skipping a review altogether
// --------------------------------------------------------------------------

test('allowSkip turns the triage on by itself: one mode plus a skip is two answers', async () => {
  const { system } = build({
    enabled: true,
    allowSkip: true,
    modes: { deep: { charterFile: null, profile: null } },
  });
  system.connector.inject({ kind: 'new_pr', number: 30, title: 'A change', branch: 'feature-30' });
  await system.harness.runCycle('manual');

  const triage = findTask(system.store, (t) => t.originRef === 'pr:30:review-triage');
  assert.ok(triage, '"read it that way" and "do not read it" is a decision, however many modes there are');
  // Appended, never interpolated: an override that never learned about the option
  // would drop every word of it silently.
  assert.match(triage!.prompt, /needs \*\*no review at all\*\*/);
  assert.match(triage!.prompt, /`skip: true`/);
  assert.equal(
    findTask(system.store, (t) => t.originRef === 'pr:30:review'),
    undefined,
    'dispatching now would spend a review the triage was about to waive',
  );
  system.store.close();
});

test('a skipped pull request is not reviewed, and not held out of the merge gate either', async () => {
  const { system } = build({
    enabled: true,
    allowSkip: true,
    modes: { deep: { charterFile: null, profile: null } },
  });
  system.connector.inject({ kind: 'new_pr', number: 31, title: 'Bump the version', branch: 'feature-31' });
  system.connector.inject({ kind: 'ci_passed', prNumber: 31 });
  system.connector.inject({ kind: 'pr_approved', prNumber: 31 });
  system.connector.inject({ kind: 'pr_mergeable', prNumber: 31, mergeable: true, mergeableState: 'clean' });
  await system.harness.runCycle('manual');
  assert.equal(
    system.store.listDecisions().filter((d) => d.action.type === 'merge_pr').length,
    0,
    'held while the triage is still deciding',
  );

  system.store.recordPrReviewRoute({
    prNumber: 31,
    mode: '',
    skipped: true,
    reason: 'A version bump in package.json and its lockfile; reading the diff cannot change anything.',
    agentId: null,
  });
  await system.harness.runCycle('manual');

  assert.equal(
    findTask(system.store, (t) => t.originRef === 'pr:31:review'),
    undefined,
    'the triage said nothing needs to read this one',
  );
  assert.equal(
    system.store.listDecisions().filter((d) => d.action.type === 'merge_pr').length,
    1,
    'a skip is a decision, so it releases the gate — otherwise the cheapest answer wedges the branch',
  );
  system.store.close();
});

test('the skip predicates: off is not on offer, and silence is never a skip', () => {
  const pr = { number: 5, merged: false, unresolvedComments: [] } as unknown as PullRequest;
  const intake = new Map([[5, true]]);
  const one = { deep: { charterFile: null, profile: null } };
  const off = { ...DEFAULT_PR_REVIEW, enabled: true, modes: one };
  const on = { ...off, allowSkip: true };
  const skip: PrReviewRoute = {
    prNumber: 5,
    mode: '',
    skipped: true,
    reason: 'A lockfile regeneration.',
    agentId: null,
    decidedAt: '2026-01-01T00:00:00.000Z',
  };

  assert.equal(triageRuns(off), false, 'one mode and no skip is nothing to decide');
  assert.equal(triageRuns(on), true);
  assert.equal(triageRuns({ ...off, modes: { ...one, quick: { charterFile: null, profile: null } } }), true);

  assert.equal(reviewSkipped(null, on), false, 'the fail-open direction is a review, never a skip');
  assert.equal(reviewSkipped(skip, on), true);
  assert.equal(
    reviewSkipped(skip, off),
    false,
    'an operator who turns allowSkip back off has every standing skip fall back to a review',
  );

  assert.equal(needsFleetReview(pr, reading({ intake, route: skip }), on), false);
  assert.equal(reviewSatisfied(pr, reading({ intake, route: skip }), on), true);
  assert.equal(needsFleetReview(pr, reading({ intake, route: skip }), off), true, 'and the review comes back with it');
  assert.equal(reviewSatisfied(pr, reading({ intake, route: skip }), off), false);
});

// --------------------------------------------------------------------------
// A review that happened somewhere else
// --------------------------------------------------------------------------

/** The build above, plus the operator's external check and a scripted prober. */
function buildWithProber(verdicts: Record<number, 'reviewed' | 'not-reviewed' | 'unknown'>) {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const prober = new FakeReviewProber(verdicts);
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    // Never run: `reviewProber` is injected, which is the whole point of the seam —
    // the real one would spawn a shell on whoever is running the suite.
    review: { ...DEFAULT_PR_REVIEW, enabled: true, reviewedElsewhere: 'exit 0' },
  });
  const system = buildSystem(config, {
    backend: new FakePtyBackend(),
    sink: undefined,
    worktrees: new FakeWorktreeManager(),
    reviewProber: prober,
  });
  return { system, prober };
}

test('a pull request reviewed elsewhere is not reviewed again, and not held either', async () => {
  const { system, prober } = buildWithProber({ 40: 'reviewed' });
  system.connector.inject({ kind: 'new_pr', number: 40, title: 'A change', branch: 'feature-40' });
  system.connector.inject({ kind: 'ci_passed', prNumber: 40 });
  system.connector.inject({ kind: 'pr_approved', prNumber: 40 });
  system.connector.inject({ kind: 'pr_mergeable', prNumber: 40, mergeable: true, mergeableState: 'clean' });
  await system.harness.runCycle('manual');

  assert.deepEqual(prober.asked, [40]);
  assert.equal(
    findTask(system.store, (t) => t.originRef === 'pr:40:review'),
    undefined,
    'somebody has read this diff; a second opinion is one nobody asked for',
  );
  // The same sharp half the intake and the skip have: a pull request nothing will
  // review must not be one nothing can merge.
  assert.equal(system.store.listDecisions().filter((d) => d.action.type === 'merge_pr').length, 1);

  // Recorded, so the command is not spawned for it again.
  await system.harness.runCycle('manual');
  assert.deepEqual(prober.asked, [40], 'the answer is stored, so the shell-out happens once');
  system.store.close();
});

test('a check that says no is asked again, and one that says nothing leaves the fleet reviewing', async () => {
  // 'not-reviewed' is a real answer; 'unknown' is a command that broke. Both must
  // leave the review to the fleet — folding either into "already reviewed" would
  // switch the whole feature off on the deployments whose gate broke.
  const { system, prober } = buildWithProber({ 41: 'not-reviewed', 42: 'unknown' });
  system.connector.inject({ kind: 'new_pr', number: 41, title: 'A change', branch: 'feature-41' });
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'Another', branch: 'feature-42' });
  await system.harness.runCycle('manual');

  assert.ok(findTask(system.store, (t) => t.originRef === 'pr:41:review'));
  assert.ok(findTask(system.store, (t) => t.originRef === 'pr:42:review'));
  assert.deepEqual(prober.asked, [41, 42]);
  // A check failing since the day it was configured is otherwise indistinguishable
  // from one that keeps answering "no" — the feature quietly doing nothing.
  assert.ok(
    system.store.listErrors(10).some((e) => /reviewedElsewhere check for PR 42 said nothing/.test(e.message)),
    'a verdict that said nothing is on the error log, never swallowed',
  );
  assert.equal(
    system.store.listErrors(10).filter((e) => /PR 41/.test(e.message)).length,
    0,
    'a real "no" is an answer, not a fault',
  );
  system.store.close();
});

test('the check is asked only of the pull requests a review is otherwise due for', async () => {
  const { system, prober } = buildWithProber({});
  // 43 stands down behind a human thread, 44 was already open when the review was
  // switched on. Neither would be dispatched, so neither costs a process spawn.
  system.connector.inject({ kind: 'new_pr', number: 43, title: 'A change', branch: 'feature-43' });
  system.connector.inject({ kind: 'pr_comment', prNumber: 43, author: 'alice', body: 'try another approach' });
  system.connector.inject({
    kind: 'new_pr',
    number: 44,
    title: 'Old work',
    branch: 'feature-44',
    openedAt: LAST_MONTH,
  });
  system.connector.inject({ kind: 'new_pr', number: 45, title: 'New work', branch: 'feature-45' });
  await system.harness.runCycle('manual');

  assert.deepEqual(
    prober.asked,
    [45],
    'one spawn per would-be review, not one per open pull request — the reading the rules use decides',
  );
  system.store.close();
});

test('no command configured spawns nothing at all', async () => {
  const { system } = build({ enabled: true });
  system.connector.inject({ kind: 'new_pr', number: 46, title: 'A change', branch: 'feature-46' });
  await system.harness.runCycle('manual');
  assert.ok(
    findTask(system.store, (t) => t.originRef === 'pr:46:review'),
    'every deployment before this existed, unchanged',
  );
  system.store.close();
});
