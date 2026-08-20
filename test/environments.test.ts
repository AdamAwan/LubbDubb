import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { mergeShaFor } from '../src/integrations/fake/fakeGitHub.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { CommandEnvironmentProber } from '../src/environments/prober.js';
import { validateEnvironments } from '../src/environments/policy.js';
import { unattributedMerges, unrecordedLandings } from '../src/environments/landings.js';
import { goalReach } from '../src/environments/reach.js';
import type { EnvironmentReading, GoalLanding, PullRequest, WorkNode, WorldSnapshot } from '../src/types.js';

// --- fixtures --------------------------------------------------------------

function pr(over: Partial<PullRequest> & { number: number }): PullRequest {
  return {
    id: `pr_${over.number}`,
    title: `PR ${over.number}`,
    branch: `issue/12/part-${over.number}`,
    ciStatus: 'passing',
    unresolvedComments: [],
    merged: false,
    ...over,
  };
}

const mergedPr = (over: Partial<PullRequest> & { number: number }): PullRequest =>
  pr({ merged: true, state: 'merged', mergeCommitSha: `sha${over.number}`, ...over });

function world(over: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return { issues: [], pullRequests: [], closedPullRequests: [], ...over } as WorldSnapshot;
}

function node(over: Partial<WorkNode> & { ref: string; kind: WorkNode['kind'] }): WorkNode {
  return {
    parentRef: null,
    baseRef: null,
    title: over.ref,
    status: 'open',
    terminal: false,
    provenance: null,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/** A goal with two merged parts, as the work graph holds it. */
function twoPartGoal(): WorkNode[] {
  return [
    node({ ref: 'issue:12', kind: 'issue' }),
    node({ ref: 'plan:12', kind: 'plan', parentRef: 'issue:12' }),
    node({ ref: 'pr:1', kind: 'pr', parentRef: 'plan:12', status: 'merged', terminal: true }),
    node({ ref: 'pr:2', kind: 'pr', parentRef: 'plan:12', status: 'merged', terminal: true }),
  ];
}

function landing(over: Partial<GoalLanding> & { prNumber: number; sha: string }): GoalLanding {
  return { goalRef: 'issue:12', recordedAt: '2026-01-01T00:00:00.000Z', ...over };
}

function reading(over: Partial<EnvironmentReading> & { sha: string; environment: string }): EnvironmentReading {
  return { status: 'reached', detail: null, observedAt: '2026-01-02T00:00:00.000Z', ...over };
}

// --- the sweep -------------------------------------------------------------

test('a merged pull request is attributed to its goal through the work graph', () => {
  const found = unrecordedLandings({
    world: world({ closedPullRequests: [mergedPr({ number: 1 })] }),
    nodes: twoPartGoal(),
    landed: new Set(),
  });
  assert.deepEqual(found, [{ prNumber: 1, goalRef: 'issue:12', sha: 'sha1' }]);
});

test('a merge already recorded is not swept up again', () => {
  const found = unrecordedLandings({
    world: world({ closedPullRequests: [mergedPr({ number: 1 })] }),
    nodes: twoPartGoal(),
    landed: new Set([1]),
  });
  assert.deepEqual(found, [], 'the closed window re-offers a merge for hours; the recorded set is what stops it');
});

test('a merged pull request with no merge commit is left alone rather than recorded blank', () => {
  const found = unrecordedLandings({
    world: world({ closedPullRequests: [pr({ number: 1, merged: true, state: 'merged' })] }),
    nodes: twoPartGoal(),
    landed: new Set(),
  });
  assert.deepEqual(found, [], 'a provider that reports no merge SHA must not produce a landing pointing at nothing');
});

test('an unmerged closed pull request is never a landing', () => {
  const found = unrecordedLandings({
    world: world({ closedPullRequests: [pr({ number: 1, state: 'closed', mergeCommitSha: 'sha1' })] }),
    nodes: twoPartGoal(),
    landed: new Set(),
  });
  assert.deepEqual(found, [], 'abandoned work went nowhere, whatever trial merge the provider computed');
});

test('a merge the graph has not folded yet falls back to the world’s own issue match', () => {
  const found = unrecordedLandings({
    world: world({
      issues: [{ number: 12, title: 'goal', state: 'open', labels: [] }] as unknown as WorldSnapshot['issues'],
      closedPullRequests: [mergedPr({ number: 1, branch: 'issue/12' })],
    }),
    nodes: [],
    landed: new Set(),
  });
  assert.deepEqual(found, [{ prNumber: 1, goalRef: 'issue:12', sha: 'sha1' }]);
});

test('a merged pull request belonging to no goal is skipped, not attributed to a guess', () => {
  const found = unrecordedLandings({
    world: world({ closedPullRequests: [mergedPr({ number: 9, branch: 'chore/tidy' })] }),
    nodes: [node({ ref: 'pr:9', kind: 'pr', status: 'merged', terminal: true })],
    landed: new Set(),
  });
  assert.deepEqual(found, []);
});

test('merges the sweep could not attribute are counted from the graph, not the closed window', () => {
  // The world has forgotten both merges — `closedPrWindowMs` has passed. The count
  // has to survive that, or every goal reads as fully accounted for once it ages.
  assert.equal(unattributedMerges('issue:12', twoPartGoal(), new Set([1])), 1);
  assert.equal(unattributedMerges('issue:12', twoPartGoal(), new Set([1, 2])), 0);
  assert.equal(unattributedMerges('issue:12', twoPartGoal(), new Set()), 2);
});

// --- the roll-up -----------------------------------------------------------

const ENVS = ['staging', 'prod'];

function reachOf(over: {
  landings: GoalLanding[];
  readings: EnvironmentReading[];
  unattributed?: number;
}): Record<string, string> {
  const rows = goalReach({
    goalRef: 'issue:12',
    landings: over.landings,
    readings: over.readings,
    environments: ENVS,
    unattributed: over.unattributed ?? 0,
  });
  return Object.fromEntries(rows.map((r) => [r.environment, r.status]));
}

test('a goal is reached only when every one of its landings is', () => {
  const landings = [landing({ prNumber: 1, sha: 'a' }), landing({ prNumber: 2, sha: 'b' })];
  const both = [reading({ sha: 'a', environment: 'staging' }), reading({ sha: 'b', environment: 'staging' })];
  assert.equal(reachOf({ landings, readings: both })['staging'], 'reached');
});

test('half a goal in an environment is partial, never reached', () => {
  const landings = [landing({ prNumber: 1, sha: 'a' }), landing({ prNumber: 2, sha: 'b' })];
  const half = [
    reading({ sha: 'a', environment: 'prod' }),
    reading({ sha: 'b', environment: 'prod', status: 'absent' }),
  ];
  const rows = goalReach({ goalRef: 'issue:12', landings, readings: half, environments: ENVS, unattributed: 0 });
  const prod = rows.find((r) => r.environment === 'prod');
  assert.equal(prod?.status, 'partial', 'a release cut between two merges puts half a feature in production');
  assert.equal(prod?.landed, 1);
  assert.equal(prod?.total, 2);
  assert.equal(prod?.at, null, 'nothing arrived as a whole, so there is no moment to quote');
});

test('a probe that could not answer reads as unknown, never as absent', () => {
  const landings = [landing({ prNumber: 1, sha: 'a' })];
  const readings = [reading({ sha: 'a', environment: 'prod', status: 'unknown', detail: 'exit 127: kubectl' })];
  assert.equal(reachOf({ landings, readings })['prod'], 'unknown');
});

test('a landing nothing has been asked about yet is unknown, not absent', () => {
  assert.equal(reachOf({ landings: [landing({ prNumber: 1, sha: 'a' })], readings: [] })['staging'], 'unknown');
});

test('a merge the sweep never caught holds the whole goal at unknown', () => {
  // The one landing is confirmed in staging, but a second merge was never
  // attributed — so "all of it is there" is a claim nothing supports.
  const landings = [landing({ prNumber: 1, sha: 'a' })];
  const readings = [reading({ sha: 'a', environment: 'staging' })];
  const rows = goalReach({ goalRef: 'issue:12', landings, readings, environments: ENVS, unattributed: 1 });
  const staging = rows.find((r) => r.environment === 'staging');
  assert.equal(staging?.status, 'partial');
  assert.equal(staging?.total, 2, 'the unattributed merge is counted, so the fraction stays honest');
});

test('a goal with nothing merged is absent rather than unknown', () => {
  assert.equal(reachOf({ landings: [], readings: [] })['prod'], 'absent', 'there is no merge to be uncertain about');
});

test('every landing asked and every answer no is absent', () => {
  const landings = [landing({ prNumber: 1, sha: 'a' })];
  const readings = [reading({ sha: 'a', environment: 'prod', status: 'absent' })];
  assert.equal(reachOf({ landings, readings })['prod'], 'absent');
});

test('a reached goal reports when its last landing arrived, not its first', () => {
  const landings = [landing({ prNumber: 1, sha: 'a' }), landing({ prNumber: 2, sha: 'b' })];
  const readings = [
    reading({ sha: 'a', environment: 'prod', observedAt: '2026-03-01T00:00:00.000Z' }),
    reading({ sha: 'b', environment: 'prod', observedAt: '2026-03-04T00:00:00.000Z' }),
  ];
  const rows = goalReach({ goalRef: 'issue:12', landings, readings, environments: ENVS, unattributed: 0 });
  assert.equal(rows.find((r) => r.environment === 'prod')?.at, '2026-03-04T00:00:00.000Z');
});

test('another goal’s landings never count towards this one', () => {
  const landings = [landing({ prNumber: 1, sha: 'a' }), landing({ prNumber: 9, sha: 'z', goalRef: 'issue:99' })];
  const readings = [reading({ sha: 'a', environment: 'prod' }), reading({ sha: 'z', environment: 'prod' })];
  const rows = goalReach({ goalRef: 'issue:12', landings, readings, environments: ENVS, unattributed: 0 });
  assert.equal(rows.find((r) => r.environment === 'prod')?.total, 1);
});

// --- the probe contract ----------------------------------------------------

test('exit 0 is reached, a quiet exit 1 is absent, and anything else is unknown', async () => {
  const prober = new CommandEnvironmentProber(process.cwd(), 10_000);
  const zero = await prober.reached('prod', 'node -e "process.exit(0)"', 'abc');
  assert.equal(zero.status, 'reached');

  const one = await prober.reached('prod', 'node -e "process.exit(1)"', 'abc');
  assert.equal(one.status, 'absent');

  // The clause that makes the contract portable: `cmd.exe` exits 1 for a command
  // it cannot find, exactly as a clean "no" does, so a 1 that came with a complaint
  // is not an answer. Without this, a typo'd probe reads as "not shipped" on every
  // Windows deployment, forever, with nothing saying so.
  const noisy = await prober.reached('prod', `node -e "console.error('stale kubeconfig'); process.exit(1)"`, 'abc');
  assert.equal(noisy.status, 'unknown');

  // The case the whole tri-state exists for: an expired credential, a missing
  // binary and a genuine not-yet-deployed all exit non-zero, and only one of them
  // is about deployment.
  const other = await prober.reached('prod', 'node -e "console.error(\'no kubeconfig\'); process.exit(3)"', 'abc');
  assert.equal(other.status, 'unknown');
  assert.match(other.detail ?? '', /exit 3/);
  assert.match(other.detail ?? '', /no kubeconfig/);

  const missing = await prober.reached('prod', 'definitely-not-a-real-binary-xyz', 'abc');
  assert.equal(missing.status, 'unknown', 'a command that does not exist has not said the commit is absent');
});

test('the commit reaches the command through the environment, not through interpolation', async () => {
  const prober = new CommandEnvironmentProber(process.cwd(), 10_000);
  const verdict = await prober.reached(
    'prod',
    "node -e \"process.exit(process.env.LUBBDUBB_COMMIT === 'cafe123' && process.env.LUBBDUBB_ENVIRONMENT === 'prod' ? 0 : 1)\"",
    'cafe123',
  );
  assert.equal(verdict.status, 'reached');
});

test('a probe that hangs is killed and reads as unknown', async () => {
  const prober = new CommandEnvironmentProber(process.cwd(), 250);
  const verdict = await prober.reached('prod', 'node -e "setTimeout(() => {}, 10000)"', 'abc');
  assert.equal(verdict.status, 'unknown', 'a probe that said nothing has not said no');
});

// --- configuration ---------------------------------------------------------

test('an environment list that cannot mean what it says is refused at load', () => {
  assert.throws(() => validateEnvironments([{ name: '', command: 'true' }]), /non-empty name/);
  assert.throws(
    () =>
      validateEnvironments([
        { name: 'prod', command: 'a' },
        { name: 'prod', command: 'b' },
      ]),
    /declared twice/,
  );
  // The one that would otherwise report every goal as shipped, forever.
  assert.throws(() => validateEnvironments([{ name: 'prod', command: '  ' }]), /exits 0/);
  assert.doesNotThrow(() => validateEnvironments([]));
});

test('no environments configured is the off switch, and it loads', () => {
  assert.deepEqual(loadConfig({}).environments, []);
});

// --- the whole system ------------------------------------------------------

function build(environments: { name: string; command: string }[], prober: FakeEnvironmentProber) {
  const config = loadConfig({
    dbPath: ':memory:',
    heartbeatIntervalMs: 60_000,
    environments,
    environmentProbeIntervalMs: 0,
  });
  return buildSystem(config, {
    backend: new FakePtyBackend(),
    worktrees: new FakeWorktreeManager(),
    environmentProber: prober,
  });
}

test('a merge is recorded against its goal and probed, end to end', async () => {
  const prober = new FakeEnvironmentProber({
    [`staging ${mergeShaFor(7)}`]: { status: 'reached', detail: null },
    [`prod ${mergeShaFor(7)}`]: { status: 'absent', detail: null },
  });
  const system = build(
    [
      { name: 'staging', command: 'unused' },
      { name: 'prod', command: 'unused' },
    ],
    prober,
  );
  system.connector.inject({ kind: 'new_issue', number: 7, title: 'the goal' });
  system.connector.inject({ kind: 'new_pr', number: 7, title: 'PR 7', branch: 'issue/7' });
  system.connector.inject({ kind: 'pr_closed', prNumber: 7, merged: true });

  await system.harness.runCycle();

  const landings = system.store.listGoalLandings();
  assert.equal(landings.length, 1);
  assert.equal(landings[0]?.goalRef, 'issue:7');
  assert.equal(landings[0]?.sha, mergeShaFor(7));

  const rows = system.store.listEnvironmentReach();
  assert.equal(rows.find((r) => r.environment === 'staging')?.status, 'reached');
  assert.equal(rows.find((r) => r.environment === 'prod')?.status, 'absent');
});

test('a confirmed landing is never asked about again, and an unconfirmed one is', async () => {
  const prober = new FakeEnvironmentProber({
    [`staging ${mergeShaFor(7)}`]: { status: 'reached', detail: null },
    [`prod ${mergeShaFor(7)}`]: { status: 'absent', detail: null },
  });
  const system = build(
    [
      { name: 'staging', command: 'unused' },
      { name: 'prod', command: 'unused' },
    ],
    prober,
  );
  system.connector.inject({ kind: 'new_issue', number: 7, title: 'the goal' });
  system.connector.inject({ kind: 'new_pr', number: 7, title: 'PR 7', branch: 'issue/7' });
  system.connector.inject({ kind: 'pr_closed', prNumber: 7, merged: true });

  await system.harness.runCycle();
  await system.harness.runCycle();

  const staging = prober.asked.filter((a) => a.startsWith('staging')).length;
  const prod = prober.asked.filter((a) => a.startsWith('prod')).length;
  assert.equal(staging, 1, 'a reached verdict is final — re-asking it is the whole cost of the feature');
  assert.equal(prod, 2, 'an absent one is a question about something that moves');
});

test('with no environment configured nothing is probed, but landings are still recorded', async () => {
  const prober = new FakeEnvironmentProber();
  const system = build([], prober);
  system.connector.inject({ kind: 'new_issue', number: 7, title: 'the goal' });
  system.connector.inject({ kind: 'new_pr', number: 7, title: 'PR 7', branch: 'issue/7' });
  system.connector.inject({ kind: 'pr_closed', prNumber: 7, merged: true });

  await system.harness.runCycle();

  assert.deepEqual(prober.asked, []);
  // The merge SHA is only on offer inside the closed window, so a deployment that
  // configures its first environment next month still has this month's landings.
  assert.equal(system.store.listGoalLandings().length, 1);
});
