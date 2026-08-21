import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { failPlanningOpen } from './support/plans.js';

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    // The assessor and the assay are pinned off: they default **on**, and this
    // file is about something else — leaving them on would put an extra agent in
    // front of every issue these assertions dispatch. Each has its own tests.
    // (The planning funnel cannot be pinned off; a goal is planned by writing the
    // funnel having failed open on it — `failPlanningOpen`.)
  });
}

test('buildStateSnapshot ships a refUrls map covering world items and task branches', async () => {
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'feat/x' });
  system.connector.inject({ kind: 'new_issue', number: 13, title: 'Bug' });
  failPlanningOpen(system.store, 13);
  // The fake provider builds no real URLs; stand in a resolver so the wiring is
  // observable (the provider's resolver is unit-tested elsewhere).
  system.connector.resolveRefUrl = (ref: string) => `https://example.test/${ref}`;
  system.store.createTask({
    kind: 'code',
    title: 'Resolve issue #13',
    prompt: 'p',
    branch: 'issue/13',
    originRef: 'issue:13',
  });
  // The snapshot draws the world the *pulse* observed, never a fresh provider
  // read, so an injected world has to be observed before the cockpit can see it.
  // Seeded rather than pulsed: a real cycle would dispatch agents at these items.
  system.store.setWorldBaseline(await system.connector.getState());

  const snap = await buildStateSnapshot(system);

  assert.equal(snap.refUrls['#42'], 'https://example.test/pr:42');
  assert.equal(snap.refUrls['#13'], 'https://example.test/issue:13');
  assert.equal(snap.refUrls['feat/x'], 'https://example.test/feat/x');
  assert.equal(snap.refUrls['issue/13'], 'https://example.test/issue/13');
  system.store.close();
});

test('buildStateSnapshot keys world-event refs so the activity feed can link them', async () => {
  // The activity feed / signals panels draw each `WorldEvent`, whose structured
  // `ref` (`pr:42`, `issue:13`) is the canonical vocabulary, not the `#n` the item
  // lists are keyed by. A world event can also name a PR that has since left the
  // world (merged out of the open list), so its ref must be resolved on its own
  // rather than borrowed from a world item that is no longer there.
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  system.connector.resolveRefUrl = (ref: string) => `https://example.test/${ref}`;
  system.store.recordWorldEvents([
    { kind: 'pr_merged', ref: 'pr:91', summary: 'PR #91 merged' },
    { kind: 'issue_linked', ref: 'issue:88', summary: 'Issue #88 linked to PR #91' },
  ]);
  system.store.setWorldBaseline(await system.connector.getState());

  const snap = await buildStateSnapshot(system);

  assert.equal(snap.refUrls['pr:91'], 'https://example.test/pr:91');
  assert.equal(snap.refUrls['issue:88'], 'https://example.test/issue:88');
  system.store.close();
});

test('buildStateSnapshot keys each task origin ref so agent/overlap/recovery cards can link it', async () => {
  // The fleet card, the overlap panel and the recovery panel all draw a task's
  // *origin* ref (`pr:142:ci`, `issue:13`) through `refLink`, which only links a
  // key the map actually holds — the item lists key by `#n`, not the colon-form
  // origin — so the origin must be resolved on its own.
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  system.connector.resolveRefUrl = (ref: string) => `https://example.test/${ref}`;
  system.store.createTask({
    kind: 'code',
    title: 'Fix CI on PR #142',
    prompt: 'p',
    branch: 'feature/rate-limit',
    originRef: 'pr:142:ci',
  });
  system.store.setWorldBaseline(await system.connector.getState());

  const snap = await buildStateSnapshot(system);

  assert.equal(snap.refUrls['pr:142:ci'], 'https://example.test/pr:142:ci');
  system.store.close();
});

test('buildStateSnapshot keys every goal by its canonical ref, so the cockpit can link it', async () => {
  // The Goal Floor's patch strip and the belt's crates speak the colon form
  // (`issue:13` is a patch's ref and a crate's origin), which the `#n` keys the
  // issue list is built from do not answer. Keyed on the issue existing, not on
  // some task or world event happening to name it — a family that links on a busy
  // world and renders plain on a quiet one is the same defect either way.
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  system.connector.inject({ kind: 'new_issue', number: 13, title: 'Bug' });
  failPlanningOpen(system.store, 13);
  system.connector.resolveRefUrl = (ref: string) => `https://example.test/${ref}`;
  system.store.setWorldBaseline(await system.connector.getState());

  const snap = await buildStateSnapshot(system);

  assert.equal(snap.refUrls['issue:13'], 'https://example.test/issue:13');
  system.store.close();
});

test('buildStateSnapshot gives each decision the ref it is about, and keys it', async () => {
  // The shift log's Ref column. The ref is derived on the server and shipped on
  // the row so the string that keys the map and the string looked up in it are the
  // same one — see `decisionSubjectRef`.
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  system.connector.resolveRefUrl = (ref: string) => `https://example.test/${ref}`;
  system.store.recordDecision({
    cycleId: 'cycle-1',
    action: { type: 'merge_pr', reason: 'merge-ready', prNumber: 42 },
    outcome: 'executed',
    detail: 'squashed it',
  });
  system.store.recordDecision({
    cycleId: 'cycle-1',
    action: { type: 'no_op', reason: 'nothing to do' },
    outcome: 'executed',
    detail: 'nothing to dispatch this cycle',
  });
  system.store.setWorldBaseline(await system.connector.getState());

  const snap = await buildStateSnapshot(system);
  const bySubject = snap.decisions.map((d) => d.subjectRef);

  assert.ok(bySubject.includes('pr:42'), `the merge must name its PR, got ${JSON.stringify(bySubject)}`);
  assert.ok(bySubject.includes(null), 'and an act about nothing external must ship null, not an invented ref');
  // Keyed, or the column would draw the ref it was handed as plain text.
  assert.equal(snap.refUrls['pr:42'], 'https://example.test/pr:42');
  system.store.close();
});

test('buildStateSnapshot attaches a pickup verdict to every issue', async () => {
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  system.connector.inject({ kind: 'new_issue', number: 7, title: 'Bug' });
  failPlanningOpen(system.store, 7);
  system.connector.inject({ kind: 'new_issue', number: 8, title: 'Staffed' });
  failPlanningOpen(system.store, 8);
  // Issue 8 has an active task on its origin → 'active', not 'eligible'.
  system.store.createTask({
    kind: 'code',
    title: 'Resolve issue #8',
    prompt: 'p',
    branch: 'issue/8',
    originRef: 'issue:8',
  });
  system.store.setWorldBaseline(await system.connector.getState());

  const snap = await buildStateSnapshot(system);

  const byNumber = new Map(snap.world.issues.map((i) => [i.number, i]));
  assert.deepEqual(byNumber.get(7)?.pickup, { eligible: true, status: 'eligible', reasons: [] });
  assert.deepEqual(byNumber.get(8)?.pickup, { eligible: false, status: 'active', reasons: ['agent queued'] });
  system.store.close();
});

test('buildStateSnapshot pickup verdict reflects paused dispatch', async () => {
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  system.connector.inject({ kind: 'new_issue', number: 9, title: 'Bug' });
  failPlanningOpen(system.store, 9);
  system.runtimeControl.apply({ paused: true });
  system.store.setWorldBaseline(await system.connector.getState());

  const snap = await buildStateSnapshot(system);

  assert.deepEqual(snap.world.issues[0]?.pickup, {
    eligible: false,
    status: 'blocked',
    reasons: ['dispatch paused'],
  });
  system.store.close();
});

/**
 * The load guard. `connector.getState()` is a provider fan-out — for `azure`,
 * `2 + 3N` REST calls for `N` open PRs — and the cockpit refetches this snapshot
 * on every `dirty`, one of which rides *every file an agent writes*. Reading the
 * provider here made the request rate a function of agent tool-call volume and of
 * how many cockpit tabs were open, which is a rate-limit block waiting to happen.
 *
 * Asserted rather than intended: the count is what a later change would trip.
 */
test('buildStateSnapshot never reads the provider — the pulse is the only reader', async () => {
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  system.connector.inject({ kind: 'new_pr', number: 77, title: 'X', branch: 'feat/x' });
  system.connector.inject({ kind: 'new_issue', number: 78, title: 'Bug' });
  failPlanningOpen(system.store, 78);
  await system.harness.runCycle('manual');

  let reads = 0;
  const real = system.connector.getState.bind(system.connector);
  system.connector.getState = () => {
    reads += 1;
    return real();
  };

  for (let i = 0; i < 3; i += 1) {
    const snap = await buildStateSnapshot(system);
    // Reading the store, not nothing: the world the pulse observed is all there.
    assert.equal(snap.world.pullRequests.length, 1);
    assert.equal(snap.world.issues.length, 1);
    assert.equal(snap.worldObservedAt, snap.world.takenAt);
  }

  assert.equal(reads, 0, 'the snapshot fanned out to the provider');
  system.store.close();
});

/**
 * Before the first cycle there is no baseline. Falling back to a live fetch here
 * is the obvious move and is wrong: boot while the provider is throttling and the
 * boot cycle fails, so the baseline is never written, so every `dirty` refetches,
 * fans out, fails, and records an error — which broadcasts another `dirty`.
 * Unbounded, and worst exactly when the provider is already refusing us.
 */
test('buildStateSnapshot with no baseline ships an empty world, not a live fetch', async () => {
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  system.connector.inject({ kind: 'new_pr', number: 79, title: 'X', branch: 'feat/y' });

  let reads = 0;
  const real = system.connector.getState.bind(system.connector);
  system.connector.getState = () => {
    reads += 1;
    return real();
  };

  const snap = await buildStateSnapshot(system);

  assert.equal(snap.worldObservedAt, null, 'an unobserved world must not claim a timestamp');
  assert.deepEqual(snap.world.pullRequests, []);
  assert.deepEqual(snap.world.issues, []);
  assert.equal(reads, 0, 'the empty case fell back to the provider');
  system.store.close();
});

/**
 * Where the local run could be pointed, and — the whole discipline of the view —
 * what has happened on **that ref** and nothing else.
 *
 * A pull request is a fact about a branch, not about a goal. This goal has two on
 * two branches, and the tempting fold ("show the goal's PR") is how a panel comes to
 * report a passing build for a branch nothing has built.
 */
test('buildStateSnapshot ships the local run’s targets, matched by branch', async () => {
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  system.connector.inject({ kind: 'new_issue', number: 21, title: 'Stacked goal' });
  system.connector.inject({ kind: 'new_issue', number: 22, title: 'Nothing started' });
  failPlanningOpen(system.store, 21);
  failPlanningOpen(system.store, 22);
  const plan = system.store.upsertPlan({
    originRef: 'issue:21',
    title: 'Stacked goal',
    status: 'active',
    reason: 'Two rungs.',
  });
  system.store.upsertPlanParts(
    plan.id,
    ['first', 'second'].map((slug, i) => ({
      slug,
      seq: i + 1,
      title: `Part ${String(i + 1)}`,
      scope: 'src/',
      dependsOn: [],
      rationale: null,
      acceptance: null,
      touches: [],
      size: null,
      expectedKind: 'code' as const,
    })),
  );
  const parts = system.store.listPlanParts(plan.id);
  system.store.updatePlanPart(parts[0]?.id ?? '', { status: 'merged', branch: 'issue/21/first', prNumber: 61 });
  system.store.updatePlanPart(parts[1]?.id ?? '', { status: 'in_review', branch: 'issue/21/second', prNumber: 62 });
  system.connector.inject({ kind: 'new_pr', number: 61, title: '[1/2]', branch: 'issue/21/first' });
  system.connector.inject({ kind: 'new_pr', number: 62, title: '[2/2]', branch: 'issue/21/second' });
  system.store.setWorldBaseline(await system.connector.getState());

  const snap = await buildStateSnapshot(system);
  const stacked = snap.localRunTargets.find((t) => t.issueNumber === 21);

  // The tip, not the first unmerged part: the whole stack is what somebody asking to
  // see this goal means.
  assert.equal(stacked?.target.ref, 'issue/21/second');
  assert.equal(stacked?.target.pr?.number, 62, 'the pull request is the one on that branch');
  assert.equal(stacked?.target.part?.seq, 2);
  assert.equal(stacked?.target.part?.total, 2);
  assert.equal(stacked?.runnable, true);
  // The merged part stays on offer, carrying its own pull request rather than the tip's.
  const earlier = stacked?.options.find((o) => o.option.ref === 'issue/21/first');
  assert.equal(earlier?.option.part?.status, 'merged');
  assert.equal(earlier?.facts.pr?.number, 61);

  // A goal nothing has started resolves to the integration branch — the same answer
  // every such goal gives, which is why it is not offered as a choice. Its facts say
  // so rather than borrowing anything: no pull request of its own, nothing merged.
  const bare = snap.localRunTargets.find((t) => t.issueNumber === 22);
  assert.equal(bare?.runnable, false);
  assert.equal(bare?.target.isDefaultBranch, true);
  assert.equal(bare?.target.pr, null);
  assert.equal(bare?.target.mergedParts, 0);
  assert.deepEqual(bare?.options, []);
  system.store.close();
});
