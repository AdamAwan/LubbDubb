import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeEnvironmentHealthProber } from '../src/environments/fakeHealthProber.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { EnvironmentDesk } from '../src/environments/environmentDesk.js';
import { mergeShaFor } from '../src/integrations/fake/fakeGitHub.js';
import { Store } from '../src/store/store.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import type { ActionSink, IssueCommentInput, SendResult } from '../src/sink/actionSink.js';
import type { WorldSnapshot } from '../src/types.js';

// → docs/spec/24-environments.md

const HALLWAY: EnvironmentConfig[] = [{ name: 'hallway', at: 'unused', arrival: { comment: true } }];

function emptyWorld(): WorldSnapshot {
  return { issues: [], pullRequests: [], closedPullRequests: [] } as unknown as WorldSnapshot;
}

function mergedGoal(environments: EnvironmentConfig[], prober: FakeEnvironmentProber, git: FakeGitObserver) {
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      dbPath: ':memory:',
      heartbeatIntervalMs: 60_000,
      environments,
      environmentProbeIntervalMs: 0,
    }),
    {
      backend: new FakePtyBackend(),
      worktrees: new FakeWorktreeManager(),
      environmentProber: prober,
      gitObserver: git,
      errorMirror: () => {},
    },
  );
  system.connector.inject({ kind: 'new_issue', number: 7, title: 'the goal' });
  system.connector.inject({ kind: 'new_pr', number: 7, title: 'PR 7', branch: 'issue/7' });
  system.connector.inject({ kind: 'pr_closed', prNumber: 7, merged: true });
  return system;
}

test('a landing a stale integration ref placed off it is re-asked, and the goal arrives once it answers yes', async () => {
  const git = new FakeGitObserver()
    .setContains('head-hallway', mergeShaFor(7), true)
    .setContains('main', mergeShaFor(7), false);
  const system = mergedGoal(HALLWAY, new FakeEnvironmentProber({ hallway: ['head-hallway'] }), git);

  await system.harness.runCycle();

  assert.equal(
    system.store.environments.listGoalLandings()[0]?.onIntegration,
    false,
    'the clone holds the merge commit, origin/main has not moved yet, and contains says a confident no',
  );
  assert.deepEqual(system.store.environments.listEnvironmentReach(), [], 'so nothing is probed for it');
  assert.deepEqual(system.store.environments.listGoalArrivals(), []);

  git.setContains('main', mergeShaFor(7), true);
  await system.harness.runCycle();

  assert.equal(
    system.store.environments.listGoalLandings()[0]?.onIntegration,
    true,
    'a no is provisional: the next pulse asks again and the row corrects itself',
  );
  assert.equal(
    system.store.environments.listEnvironmentReach().find((r) => r.environment === 'hallway')?.status,
    'reached',
    'and the landing rejoins the environments it was never asked about',
  );
  assert.deepEqual(
    system.store.environments.listGoalArrivals().map((a) => `${a.goalRef} ${a.environment}`),
    ['issue:7 hallway'],
    'so the goal arrives rather than holding its validate and close-out gates for good',
  );
});

test('a landing the clone still places off the integration branch stays out, however often it is asked', async () => {
  const git = new FakeGitObserver()
    .setContains('head-hallway', mergeShaFor(7), true)
    .setContains('main', mergeShaFor(7), false);
  const system = mergedGoal(HALLWAY, new FakeEnvironmentProber({ hallway: ['head-hallway'] }), git);

  await system.harness.runCycle();
  await system.harness.runCycle();

  assert.equal(system.store.environments.listGoalLandings()[0]?.onIntegration, false);
  assert.deepEqual(
    system.store.environments.listEnvironmentReach(),
    [],
    'a squash on a deleted topic branch is an ancestor of nothing, and re-asking does not make it one',
  );
  assert.deepEqual(system.store.environments.listGoalArrivals(), []);
});

function establishedHallway(now: number): { store: Store; desk: EnvironmentDesk; comments: IssueCommentInput[] } {
  const comments: IssueCommentInput[] = [];
  const sink = {
    async upsertIssueComment(input: IssueCommentInput): Promise<SendResult> {
      comments.push(input);
      return { ok: true, ref: `comment_${comments.length}` };
    },
  } as unknown as ActionSink;

  let clock = new Date(now - 7 * 24 * 60 * 60_000).toISOString();
  const store = new Store(':memory:', () => clock);
  for (let n = 1; n <= 12; n += 1) {
    store.environments.recordGoalLanding({ prNumber: n, goalRef: `issue:${n}`, sha: `sha${n}` });
    store.environments.markLandingIntegration(n, true);
    store.environments.recordEnvironmentReach({
      sha: `sha${n}`,
      environment: 'hallway',
      status: 'reached',
      detail: null,
    });
    store.environments.recordGoalArrival({ goalRef: `issue:${n}`, environment: 'hallway', arrivedAt: clock });
    store.environments.markArrivalAnnounced(`issue:${n}`, 'hallway');
  }
  store.environments.recordGoalLanding({ prNumber: 99, goalRef: 'issue:99', sha: 'sha99' });
  store.environments.markLandingIntegration(99, false);
  clock = new Date(now).toISOString();

  const desk = new EnvironmentDesk({
    store,
    environments: HALLWAY,
    healthProber: new FakeEnvironmentHealthProber(),
    healthIntervalMs: 60_000,
    prober: new FakeEnvironmentProber({ hallway: ['head-hallway'] }),
    git: new FakeGitObserver().setContains('main', 'sha99', true).setContains('head-hallway', 'sha99', true),
    sink,
    integrationBranch: 'main',
    probeIntervalMs: 60_000,
    now: () => now,
  });
  return { store, desk, comments };
}

test('correcting a landing catches up one goal, not every ticket the deployment ever shipped', async () => {
  const now = Date.parse('2026-09-18T12:00:00.000Z');
  const { store, desk, comments } = establishedHallway(now);

  await desk.run(emptyWorld());

  assert.equal(store.environments.listGoalLandings().find((l) => l.prNumber === 99)?.onIntegration, true);
  assert.deepEqual(
    store.environments
      .listGoalArrivals()
      .filter((a) => a.goalRef === 'issue:99')
      .map((a) => a.environment),
    ['hallway'],
  );
  assert.deepEqual(
    comments.map((c) => c.number),
    [99],
    'the twelve arrivals already stamped are not re-announced: the announce guard reads announced_at first',
  );

  await desk.run(emptyWorld());
  assert.deepEqual(
    comments.map((c) => c.number),
    [99],
    'and an arrival is a moment, said once',
  );
});
