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
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakePortLister } from '../src/localRun/fakePortLister.js';
import { failPlanningOpen } from './support/plans.js';

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    selfUpdate: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
  });
}

test('buildStateSnapshot ships a refUrls map covering world items and task branches', async () => {
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'feat/x' });
  system.connector.inject({ kind: 'new_issue', number: 13, title: 'Bug' });
  failPlanningOpen(system.store, 13);
  system.connector.resolveRefUrl = (ref: string) => `https://example.test/${ref}`;
  system.store.createTask({
    kind: 'code',
    title: 'Resolve issue #13',
    prompt: 'p',
    branch: 'issue/13',
    originRef: 'issue:13',
  });
  system.store.setWorldBaseline(await system.connector.getState());

  const snap = await buildStateSnapshot(system);

  assert.equal(snap.refUrls['#42'], 'https://example.test/pr:42');
  assert.equal(snap.refUrls['#13'], 'https://example.test/issue:13');
  assert.equal(snap.refUrls['feat/x'], 'https://example.test/feat/x');
  assert.equal(snap.refUrls['issue/13'], 'https://example.test/issue/13');
  system.store.close();
});

test('buildStateSnapshot keys world-event refs so the activity feed can link them', async () => {
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
  assert.equal(snap.refUrls['pr:42'], 'https://example.test/pr:42');
  system.store.close();
});

test('buildStateSnapshot attaches a pickup verdict to every issue', async () => {
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  system.connector.inject({ kind: 'new_issue', number: 7, title: 'Bug' });
  failPlanningOpen(system.store, 7);
  system.connector.inject({ kind: 'new_issue', number: 8, title: 'Staffed' });
  failPlanningOpen(system.store, 8);
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
    assert.equal(snap.world.pullRequests.length, 1);
    assert.equal(snap.world.issues.length, 1);
    assert.equal(snap.worldObservedAt, snap.world.takenAt);
  }

  assert.equal(reads, 0, 'the snapshot fanned out to the provider');
  system.store.close();
});

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

test('buildStateSnapshot puts a local run’s spend on the goal it ran', async () => {
  const system = buildSystem(testConfig(), { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend() });
  system.connector.inject({ kind: 'new_issue', number: 31, title: 'A goal somebody looked at' });
  failPlanningOpen(system.store, 31);
  system.store.setWorldBaseline(await system.connector.getState());

  const run = system.store.beginLocalRun({
    originRef: 'issue:31',
    ref: 'issue/31',
    dir: '/preview',
    commit: 'abc123',
    url: null,
  });
  system.store.addLocalRunUsage(run.id, {
    costUsd: 0.8,
    inputTokens: 4000,
    outputTokens: 200,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: 5,
  });

  const snap = await buildStateSnapshot(system);
  const issue = snap.world.issues.find((i) => i.number === 31);
  assert.equal(issue?.spend?.costUsd, 0.8);
  assert.equal(issue?.spend?.agents, 0);
  assert.equal(issue?.spend?.localRuns, 1);
  system.store.close();
});

test('buildStateSnapshot ships the watch’s readings on a live run, and nothing on a settled one', async () => {
  const git = new FakeGitObserver()
    .setDivergence('issue/31', 'abc123', { ahead: 2, behind: 0 })
    .setDivergence('issue/31', 'main', { ahead: 4, behind: 1 });
  const ports = new FakePortLister().set('/preview', [5173]);
  const system = buildSystem(testConfig(), {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    gitObserver: git,
    portLister: ports,
  });
  system.connector.inject({ kind: 'new_issue', number: 31, title: 'A goal somebody looked at' });
  system.store.setWorldBaseline(await system.connector.getState());
  const run = system.store.beginLocalRun({
    originRef: 'issue:31',
    ref: 'issue/31',
    dir: '/preview',
    commit: 'abc123',
    url: null,
  });
  system.store.markLocalRunPid(run.id, 777);
  system.store.setLocalRunStatus(run.id, 'running');
  await system.localRunWatch.tick();

  const live = (await buildStateSnapshot(system)).localRun;
  assert.deepEqual(live?.ports?.listening, [5173]);
  assert.equal(live?.ports?.declared, null);
  assert.equal(live?.freshness?.behindTip, 2);
  assert.deepEqual(live?.freshness?.base, { ref: 'main', behind: 1 });
  assert.equal(live?.turn, null);
  assert.equal(live?.holdsSession, false, 'nothing in this process spawned the session');
  assert.equal(live?.commit, 'abc123');

  system.store.setLocalRunStatus(run.id, 'stopped', 'done');
  const settled = (await buildStateSnapshot(system)).localRun;
  assert.equal(settled?.ports, null);
  assert.equal(settled?.freshness, null);
  system.store.close();
});

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

  assert.equal(stacked?.target.ref, 'issue/21/second');
  assert.equal(stacked?.target.pr?.number, 62, 'the pull request is the one on that branch');
  assert.equal(stacked?.target.part?.seq, 2);
  assert.equal(stacked?.target.part?.total, 2);
  assert.equal(stacked?.runnable, true);
  const earlier = stacked?.options.find((o) => o.option.ref === 'issue/21/first');
  assert.equal(earlier?.option.part?.status, 'merged');
  assert.equal(earlier?.facts.pr?.number, 61);

  const bare = snap.localRunTargets.find((t) => t.issueNumber === 22);
  assert.equal(bare?.runnable, false);
  assert.equal(bare?.target.isDefaultBranch, true);
  assert.equal(bare?.target.pr, null);
  assert.equal(bare?.target.mergedParts, 0);
  assert.deepEqual(bare?.options, []);
  system.store.close();
});
