import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { mergeShaFor } from '../src/integrations/fake/fakeGitHub.js';
import { FakeEnvironmentHealthProber } from '../src/environments/fakeHealthProber.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { CommandEnvironmentProber } from '../src/environments/prober.js';
import { validateEnvironments, type EnvironmentConfig } from '../src/environments/policy.js';
import { unattributedMerges, unrecordedLandings } from '../src/environments/landings.js';
import { allGoalReach, goalReach } from '../src/environments/reach.js';
import { environmentGateHold, openedGoals } from '../src/environments/arrival.js';
import { stuckGoals } from '../src/environments/stuck.js';
import { EnvironmentDesk } from '../src/environments/environmentDesk.js';
import { GitCliObserver } from '../src/git/gitObserver.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { Store } from '../src/store/store.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { gitRepo } from './support/gitRepo.js';
import type { ActionSink, IssueCommentInput, SendResult, WorkItemStateInput } from '../src/sink/actionSink.js';
import type {
  EnvironmentReading,
  GoalArrival,
  GoalLanding,
  Plan,
  PlanPart,
  PullRequest,
  WorkNode,
  WorldSnapshot,
} from '../src/types.js';

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

function twoPartGoal(): WorkNode[] {
  return [
    node({ ref: 'issue:12', kind: 'issue' }),
    node({ ref: 'plan:12', kind: 'plan', parentRef: 'issue:12' }),
    node({ ref: 'pr:1', kind: 'pr', parentRef: 'plan:12', status: 'merged', terminal: true }),
    node({ ref: 'pr:2', kind: 'pr', parentRef: 'plan:12', status: 'merged', terminal: true }),
  ];
}

function plannedGoal(): WorkNode[] {
  return [
    node({ ref: 'issue:12', kind: 'issue' }),
    node({ ref: 'issue:12:part:api', kind: 'part', parentRef: 'issue:12' }),
    node({ ref: 'issue:12:part:ui', kind: 'part', parentRef: 'issue:12' }),
    node({ ref: 'pr:1', kind: 'pr', parentRef: 'issue:12:part:api', status: 'merged', terminal: true }),
    node({ ref: 'pr:2', kind: 'pr', parentRef: 'issue:12:part:ui', status: 'merged', terminal: true }),
  ];
}

function fourPartGoal(): WorkNode[] {
  const slugs = ['api', 'ui', 'docs', 'tests'];
  return [
    node({ ref: 'issue:12', kind: 'issue' }),
    ...slugs.map((slug) => node({ ref: `issue:12:part:${slug}`, kind: 'part', parentRef: 'issue:12' })),
    ...slugs.map((slug, i) =>
      node({ ref: `pr:${i + 1}`, kind: 'pr', parentRef: `issue:12:part:${slug}`, status: 'merged', terminal: true }),
    ),
  ];
}

function landing(over: Partial<GoalLanding> & { prNumber: number; sha: string }): GoalLanding {
  return { goalRef: 'issue:12', recordedAt: '2026-01-01T00:00:00.000Z', onIntegration: null, ...over };
}

function reading(over: Partial<EnvironmentReading> & { sha: string; environment: string }): EnvironmentReading {
  return { status: 'reached', detail: null, observedAt: '2026-01-02T00:00:00.000Z', ...over };
}

test('a merged pull request is attributed to its goal through the work graph', () => {
  const found = unrecordedLandings({
    world: world({ closedPullRequests: [mergedPr({ number: 1 })] }),
    nodes: twoPartGoal(),
    integrationBranch: 'main',
    landed: new Set(),
  });
  assert.deepEqual(found, [{ prNumber: 1, goalRef: 'issue:12', sha: 'sha1' }]);
});

test('a merge already recorded is not swept up again', () => {
  const found = unrecordedLandings({
    world: world({ closedPullRequests: [mergedPr({ number: 1 })] }),
    nodes: twoPartGoal(),
    integrationBranch: 'main',
    landed: new Set([1]),
  });
  assert.deepEqual(found, [], 'the closed window re-offers a merge for hours; the recorded set is what stops it');
});

test('a merged pull request with no merge commit is left alone rather than recorded blank', () => {
  const found = unrecordedLandings({
    world: world({ closedPullRequests: [pr({ number: 1, merged: true, state: 'merged' })] }),
    nodes: twoPartGoal(),
    integrationBranch: 'main',
    landed: new Set(),
  });
  assert.deepEqual(found, [], 'a provider that reports no merge SHA must not produce a landing pointing at nothing');
});

test('an unmerged closed pull request is never a landing', () => {
  const found = unrecordedLandings({
    world: world({ closedPullRequests: [pr({ number: 1, state: 'closed', mergeCommitSha: 'sha1' })] }),
    nodes: twoPartGoal(),
    integrationBranch: 'main',
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
    integrationBranch: 'main',
    landed: new Set(),
  });
  assert.deepEqual(found, [{ prNumber: 1, goalRef: 'issue:12', sha: 'sha1' }]);
});

test('a merged pull request belonging to no goal is skipped, not attributed to a guess', () => {
  const found = unrecordedLandings({
    world: world({ closedPullRequests: [mergedPr({ number: 9, branch: 'chore/tidy' })] }),
    nodes: [node({ ref: 'pr:9', kind: 'pr', status: 'merged', terminal: true })],
    integrationBranch: 'main',
    landed: new Set(),
  });
  assert.deepEqual(found, []);
});

test('a merge onto another pull request’s branch is not a landing', () => {
  const found = unrecordedLandings({
    world: world({
      closedPullRequests: [
        mergedPr({ number: 1, baseBranch: 'main' }),
        mergedPr({ number: 2, baseBranch: 'issue/12/part-1' }),
      ],
    }),
    nodes: twoPartGoal(),
    integrationBranch: 'main',
    landed: new Set(),
  });
  assert.deepEqual(
    found,
    [{ prNumber: 1, goalRef: 'issue:12', sha: 'sha1' }],
    'a stacked squash lands on a branch that is deleted and is an ancestor of nothing',
  );
});

test('a merge whose provider reported no base branch is still a landing', () => {
  const found = unrecordedLandings({
    world: world({ closedPullRequests: [mergedPr({ number: 1 })] }),
    nodes: twoPartGoal(),
    integrationBranch: 'main',
    landed: new Set(),
  });
  assert.deepEqual(found, [{ prNumber: 1, goalRef: 'issue:12', sha: 'sha1' }], 'the clone reconciles what it cannot');
});

test('a stacked merge is not counted as unattributed either', () => {
  const stacked = [
    node({ ref: 'issue:12', kind: 'issue' }),
    node({ ref: 'pr:1', kind: 'pr', parentRef: 'issue:12', status: 'merged', terminal: true }),
    node({ ref: 'pr:2', kind: 'pr', parentRef: 'issue:12', baseRef: 'pr:1', status: 'merged', terminal: true }),
  ];
  assert.equal(unattributedMerges('issue:12', stacked, new Set()), 1, 'only the stack base can inflate the total');
});

test('merges the sweep could not attribute are counted from the graph, not the closed window', () => {
  assert.equal(unattributedMerges('issue:12', twoPartGoal(), new Set([1])), 1);
  assert.equal(unattributedMerges('issue:12', twoPartGoal(), new Set([1, 2])), 0);
  assert.equal(unattributedMerges('issue:12', twoPartGoal(), new Set()), 2);
});

test('a part’s merge is attributed to the goal, not to the part it hung off', () => {
  const found = unrecordedLandings({
    world: world({ closedPullRequests: [mergedPr({ number: 1 }), mergedPr({ number: 2 })] }),
    nodes: plannedGoal(),
    integrationBranch: 'main',
    landed: new Set(),
  });
  assert.deepEqual(found, [
    { prNumber: 1, goalRef: 'issue:12', sha: 'sha1' },
    { prNumber: 2, goalRef: 'issue:12', sha: 'sha2' },
  ]);
});

test('a planned goal’s unattributed merges are counted against the goal, not its parts', () => {
  assert.equal(unattributedMerges('issue:12', plannedGoal(), new Set()), 2);
  assert.equal(unattributedMerges('issue:12', plannedGoal(), new Set([1])), 1);
  assert.equal(
    unattributedMerges('issue:12:part:api', plannedGoal(), new Set()),
    0,
    'a part is not a goal, and nothing may be counted against one',
  );
});

const ENVS: EnvironmentConfig[] = [
  { name: 'staging', at: 'unused' },
  { name: 'prod', at: 'unused' },
];

test('a landing the clone placed off the integration branch leaves the goal’s total', () => {
  const rows = goalReach({
    goalRef: 'issue:12',
    landings: [
      landing({ prNumber: 1, sha: 'a', onIntegration: true }),
      landing({ prNumber: 2, sha: 'b', onIntegration: false }),
    ],
    readings: [reading({ sha: 'a', environment: 'staging' })],
    environments: ENVS,
    unattributed: 0,
    outstanding: 0,
  });
  assert.equal(rows[0]?.status, 'reached');
  assert.equal(rows[0]?.total, 1);
  assert.equal(rows[0]?.unplaced, 1, 'the card says what it could not place rather than reading partial forever');
});

const GATED: EnvironmentConfig[] = [{ name: 'staging', at: 'unused', arrival: { opens: ['validate'] } }];

test('a delivered goal held behind an environment its work never reached is reported, not held quietly', () => {
  const stuck = stuckGoals({
    delivered: ['issue:12'],
    shortfalled: new Set(),
    environments: GATED,
    arrivals: [],
    releases: [],
    landings: [landing({ prNumber: 1, sha: 'a' })],
    readings: [reading({ sha: 'a', environment: 'staging', status: 'absent', observedAt: '2026-01-02T00:00:00.000Z' })],
    probeIntervalMs: 60_000,
    now: Date.parse('2026-01-03T00:00:00.000Z'),
  });
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0]?.goalRef, 'issue:12');
  assert.equal(stuck[0]?.absent, 1);
});

test('a reading that has not sat long enough, and a goal already arrived, are not stuck', () => {
  const args = {
    delivered: ['issue:12'],
    shortfalled: new Set<string>(),
    environments: GATED,
    releases: [],
    landings: [landing({ prNumber: 1, sha: 'a' })],
    readings: [reading({ sha: 'a', environment: 'staging', status: 'absent', observedAt: '2026-01-02T00:00:00.000Z' })],
    probeIntervalMs: 60_000,
  };
  assert.deepEqual(stuckGoals({ ...args, arrivals: [], now: Date.parse('2026-01-02T00:01:00.000Z') }), []);
  assert.deepEqual(
    stuckGoals({
      ...args,
      arrivals: [
        {
          goalRef: 'issue:12',
          environment: 'staging',
          arrivedAt: '2026-01-02T00:00:00.000Z',
          announcedAt: null,
          watchedAt: null,
        },
      ],
      now: Date.parse('2026-01-03T00:00:00.000Z'),
    }),
    [],
    'nothing is held, so nothing is stuck',
  );
});

function reachOf(over: {
  landings: GoalLanding[];
  readings: EnvironmentReading[];
  unattributed?: number;
  outstanding?: number;
}): Record<string, string> {
  const rows = goalReach({
    goalRef: 'issue:12',
    landings: over.landings,
    readings: over.readings,
    environments: ENVS,
    unattributed: over.unattributed ?? 0,
    outstanding: over.outstanding ?? 0,
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
  const rows = goalReach({
    goalRef: 'issue:12',
    landings,
    readings: half,
    environments: ENVS,
    unattributed: 0,
    outstanding: 0,
  });
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
  const landings = [landing({ prNumber: 1, sha: 'a' })];
  const readings = [reading({ sha: 'a', environment: 'staging' })];
  const rows = goalReach({
    goalRef: 'issue:12',
    landings,
    readings,
    environments: ENVS,
    unattributed: 1,
    outstanding: 0,
  });
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
  const rows = goalReach({
    goalRef: 'issue:12',
    landings,
    readings,
    environments: ENVS,
    unattributed: 0,
    outstanding: 0,
  });
  assert.equal(rows.find((r) => r.environment === 'prod')?.at, '2026-03-04T00:00:00.000Z');
});

test('a plan’s unmerged parts are counted, so one part of four is not the whole goal', () => {
  const landings = [landing({ prNumber: 1, sha: 'a' })];
  const readings = [reading({ sha: 'a', environment: 'staging' })];
  const rows = goalReach({
    goalRef: 'issue:12',
    landings,
    readings,
    environments: ENVS,
    unattributed: 0,
    outstanding: 3,
  });
  const staging = rows.find((r) => r.environment === 'staging');
  assert.equal(staging?.status, 'partial');
  assert.equal(staging?.landed, 1);
  assert.equal(staging?.total, 4);
  assert.equal(staging?.at, null, 'nothing arrived as a whole, so there is no moment to record');
});

test('a part with no commit yet is absent, never unknown', () => {
  const landings = [landing({ prNumber: 1, sha: 'a' })];
  const readings = [reading({ sha: 'a', environment: 'prod', status: 'absent' })];
  assert.equal(reachOf({ landings, readings, outstanding: 2 })['prod'], 'absent');
});

test('a goal owing nothing more is reached on its landings alone', () => {
  const landings = [landing({ prNumber: 1, sha: 'a' })];
  const readings = [reading({ sha: 'a', environment: 'staging' })];
  assert.equal(reachOf({ landings, readings, outstanding: 0 })['staging'], 'reached');
});

function plan(over: Partial<Plan> = {}): Plan {
  return {
    id: 'plan_1',
    originRef: 'issue:12',
    title: 'Big thing',
    status: 'active',
    reason: null,
    diagnosis: null,
    approach: null,
    risks: null,
    outOfScope: null,
    alternatives: null,
    openQuestions: null,
    verification: null,
    evidence: [],
    document: null,
    statusCommentRef: null,
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
    ...over,
  };
}

function part(slug: string, over: Partial<PlanPart> = {}): PlanPart {
  return {
    id: `plan_1:${slug}`,
    planId: 'plan_1',
    slug,
    seq: 1,
    title: `The ${slug} part`,
    scope: `src/${slug}/`,
    rationale: null,
    acceptance: null,
    acceptanceMet: [],
    touches: [],
    size: null,
    expectedKind: null,
    outcomeKind: null,
    outcomeRef: null,
    outcomeSummary: null,
    dependsOn: [],
    branch: null,
    prNumber: null,
    status: 'ready',
    blockedReason: null,
    blockedBy: null,
    taskId: null,
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
    ...over,
  };
}

function totalFor(parts: PlanPart[], plans: Plan[] = [plan()]): number {
  const rows = allGoalReach({
    landings: [landing({ prNumber: 1, sha: 'a' })],
    readings: [reading({ sha: 'a', environment: 'staging' })],
    nodes: [],
    landed: new Set([1]),
    plans,
    parts,
    environments: ENVS,
  });
  const staging = rows.find((r) => r.goalRef === 'issue:12')?.environments.find((e) => e.environment === 'staging');
  return staging?.total ?? -1;
}

test('the parts a goal still owes a merge widen its denominator', () => {
  assert.equal(totalFor([part('one', { status: 'merged' }), part('two'), part('three')]), 3);
});

test('a settled part is not owed twice — its merge is already the landing', () => {
  assert.equal(totalFor([part('one', { status: 'merged' })]), 1, 'the landing, and nothing beside it');
  assert.equal(totalFor([part('one', { status: 'concluded' })]), 1, 'a concluded part produced no merge to wait for');
});

test('a retired part, and an abandoned plan’s parts, are not work any more', () => {
  assert.equal(totalFor([part('one', { status: 'merged' }), part('two', { status: 'retired' })]), 1);
  assert.equal(
    totalFor([part('one', { status: 'merged' }), part('two')], [plan({ status: 'abandoned' })]),
    1,
    'the plan withdrew the claim that its parts were work',
  );
});

test('a part that will never merge anything stays out of the denominator', () => {
  for (const kind of ['report', 'determination', 'human'] as const)
    assert.equal(totalFor([part('one', { status: 'merged' }), part('two', { expectedKind: kind })]), 1, kind);
  assert.equal(totalFor([part('one', { status: 'merged' }), part('two', { expectedKind: 'code' })]), 2);
  assert.equal(totalFor([part('one', { status: 'merged' }), part('two', { expectedKind: null })]), 2);
});

test('another plan’s parts are never this goal’s to owe', () => {
  const other = plan({ id: 'plan_9', originRef: 'issue:99' });
  const parts = [part('one', { status: 'merged' }), { ...part('two'), id: 'plan_9:two', planId: 'plan_9' }];
  assert.equal(totalFor(parts, [plan(), other]), 1);
});

test('a goal with a plan but nothing merged is still dropped, not drawn 0/4', () => {
  const rows = allGoalReach({
    landings: [],
    readings: [],
    nodes: [node({ ref: 'issue:12', kind: 'issue' })],
    landed: new Set(),
    plans: [plan()],
    parts: [part('one'), part('two')],
    environments: ENVS,
  });
  assert.equal(
    rows.length,
    0,
    'a plan cut this morning has not been anywhere; a row of 0/2 would bury the ones that moved',
  );
});

test('another goal’s landings never count towards this one', () => {
  const landings = [landing({ prNumber: 1, sha: 'a' }), landing({ prNumber: 9, sha: 'z', goalRef: 'issue:99' })];
  const readings = [reading({ sha: 'a', environment: 'prod' }), reading({ sha: 'z', environment: 'prod' })];
  const rows = goalReach({
    goalRef: 'issue:12',
    landings,
    readings,
    environments: ENVS,
    unattributed: 0,
    outstanding: 0,
  });
  assert.equal(rows.find((r) => r.environment === 'prod')?.total, 1);
});

test('the probe answers with commits, and anything else is not an answer', async () => {
  const prober = new CommandEnvironmentProber(process.cwd(), 10_000);
  const head = await prober.at('prod', 'node -e "console.log(\'cafe123\')"');
  assert.deepEqual(head.commits, ['cafe123']);

  const many = await prober.at('prod', "node -e \"console.log('aaa'); console.log('bbb')\"");
  assert.deepEqual(many.commits, ['aaa', 'bbb']);

  const failed = await prober.at('prod', 'node -e "console.error(\'no kubeconfig\'); process.exit(3)"');
  assert.equal(failed.commits, null);
  assert.match(failed.detail ?? '', /exit 3/);
  assert.match(failed.detail ?? '', /no kubeconfig/);

  const missing = await prober.at('prod', 'definitely-not-a-real-binary-xyz');
  assert.equal(missing.commits, null, 'a command that does not exist has not said where the environment is');

  const silent = await prober.at('prod', 'node -e "process.exit(0)"');
  assert.equal(silent.commits, null);
  assert.match(silent.detail ?? '', /named no commit/);
});

test('the environment’s name reaches the command, and no commit does', async () => {
  const prober = new CommandEnvironmentProber(process.cwd(), 10_000);
  const head = await prober.at(
    'prod',
    'node -e "console.log(process.env.LUBBDUBB_ENVIRONMENT); console.log(process.env.LUBBDUBB_COMMIT ?? \'none\')"',
  );
  assert.deepEqual(head.commits, ['prod', 'none']);
});

test('a probe that hangs is killed and answers nothing', async () => {
  const prober = new CommandEnvironmentProber(process.cwd(), 250);
  const head = await prober.at('prod', 'node -e "setTimeout(() => {}, 10000)"');
  assert.equal(head.commits, null, 'a probe that said nothing has not said where the environment is');
});

test('an environment list that cannot mean what it says is refused at load', () => {
  assert.throws(() => validateEnvironments([{ name: '', at: 'true' }]), /non-empty name/);
  assert.throws(
    () =>
      validateEnvironments([
        { name: 'prod', at: 'a' },
        { name: 'prod', at: 'b' },
      ]),
    /declared twice/,
  );
  assert.throws(() => validateEnvironments([{ name: 'prod', at: '  ' }]), /non-empty command/);
  assert.throws(
    () => validateEnvironments([{ name: 'prod', command: 'git merge-base --is-ancestor x y' } as never]),
    /no longer read/,
  );
  assert.doesNotThrow(() => validateEnvironments([]));
});

test('an arrival that cannot mean what it says is refused at load', () => {
  const env = (arrival: unknown): EnvironmentConfig[] => [{ name: 'testUk', at: 'x', arrival } as EnvironmentConfig];
  assert.throws(() => validateEnvironments(env({ opens: [] })), /is empty/);
  assert.throws(() => validateEnvironments(env({ opens: ['deploy'] })), /not an obligation/);
  assert.throws(() => validateEnvironments(env({})), /declares nothing/);
  assert.throws(() => validateEnvironments(env({ comment: 'yes' })), /true or false/);
  assert.throws(() => validateEnvironments(env({ workItemState: '  ' })), /non-empty tracker state/);
  assert.doesNotThrow(() => validateEnvironments(env({ workItemState: 'Worthy' })));
  assert.doesNotThrow(() => validateEnvironments(env({ opens: ['validate', 'close_out'], comment: true })));
  assert.doesNotThrow(() => validateEnvironments(env({ comment: true })));
});

test('no environments configured is the off switch, and it loads', () => {
  assert.deepEqual(loadConfig({}).environments, []);
});

test('the clone answers containment in a batch, three-valued', async () => {
  const dir = gitRepo('lubbdubb-env-');
  const git = (args: string[]): string => execFileSync('git', args, { cwd: dir }).toString().trim();
  git(['commit', '-q', '--allow-empty', '-m', 'one']);
  const older = git(['rev-parse', 'HEAD']);
  git(['commit', '-q', '--allow-empty', '-m', 'two']);
  const head = git(['rev-parse', 'HEAD']);
  git(['commit', '-q', '--allow-empty', '-m', 'three']);
  const newer = git(['rev-parse', 'HEAD']);
  const absent = '0000000000000000000000000000000000000001';

  const observer = new GitCliObserver(dir);
  const said = await observer.contains([older, head, newer, absent], [head]);
  assert.equal(said.get(older), true, 'an ancestor of the head is in it');
  assert.equal(said.get(head), true, 'the head holds itself');
  assert.equal(said.get(newer), false, 'a commit past the head is not in it');
  assert.equal(said.get(absent), null, 'a commit the clone does not hold is not "no"');

  const both = await observer.contains([older, newer], [head, newer]);
  assert.equal(both.get(older), true);
  assert.equal(both.get(newer), false, 'reachable from one head is not reachable from every head');

  const unresolvable = await observer.contains([older], ['not-a-ref-anywhere']);
  assert.equal(unresolvable.get(older), null, 'a head that resolves to nothing answers about nothing');

  const noHeads = await observer.contains([older], []);
  assert.equal(noHeads.get(older), null);

  rmSync(dir, { recursive: true, force: true });
});

function build(
  environments: EnvironmentConfig[],
  prober: FakeEnvironmentProber,
  git: FakeGitObserver = new FakeGitObserver(),
) {
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    dbPath: ':memory:',
    heartbeatIntervalMs: 60_000,
    environments,
    environmentProbeIntervalMs: 0,
  });
  return buildSystem(config, {
    backend: new FakePtyBackend(),
    worktrees: new FakeWorktreeManager(),
    environmentProber: prober,
    gitObserver: git,
  });
}

function twoEnvironments(staging: boolean, prod: boolean): { prober: FakeEnvironmentProber; git: FakeGitObserver } {
  return {
    prober: new FakeEnvironmentProber({ staging: ['head-staging'], prod: ['head-prod'] }),
    git: new FakeGitObserver()
      .setContains('head-staging', mergeShaFor(7), staging)
      .setContains('head-prod', mergeShaFor(7), prod),
  };
}

const TWO_ENVS: EnvironmentConfig[] = [
  { name: 'staging', at: 'unused' },
  { name: 'prod', at: 'unused' },
];

function mergedGoal(system: ReturnType<typeof build>): void {
  system.connector.inject({ kind: 'new_issue', number: 7, title: 'the goal' });
  system.connector.inject({ kind: 'new_pr', number: 7, title: 'PR 7', branch: 'issue/7' });
  system.connector.inject({ kind: 'pr_closed', prNumber: 7, merged: true });
}

test('a merge is recorded against its goal and answered from where the environment is', async () => {
  const { prober, git } = twoEnvironments(true, false);
  const system = build(TWO_ENVS, prober, git);
  mergedGoal(system);

  await system.harness.runCycle();

  const landings = system.store.listGoalLandings();
  assert.equal(landings.length, 1);
  assert.equal(landings[0]?.goalRef, 'issue:7');
  assert.equal(landings[0]?.sha, mergeShaFor(7));

  const rows = system.store.listEnvironmentReach();
  assert.equal(rows.find((r) => r.environment === 'staging')?.status, 'reached');
  assert.equal(rows.find((r) => r.environment === 'prod')?.status, 'absent');
});

test('a stacked pull request’s squash is not a landing, and the goal still arrives', async () => {
  const { prober, git } = twoEnvironments(true, false);
  const system = build(TWO_ENVS, prober, git);
  system.connector.inject({ kind: 'new_issue', number: 7, title: 'the goal' });
  system.connector.inject({ kind: 'new_pr', number: 7, title: 'PR 7', branch: 'issue/7' });
  system.connector.inject({
    kind: 'new_pr',
    number: 8,
    title: 'PR 8',
    branch: 'issue/7/second',
    baseBranch: 'issue/7',
  });

  await system.harness.runCycle();
  system.connector.inject({ kind: 'pr_closed', prNumber: 7, merged: true });
  system.connector.inject({ kind: 'pr_closed', prNumber: 8, merged: true });
  await system.harness.runCycle();

  assert.deepEqual(
    system.store.listGoalLandings().map((l) => l.prNumber),
    [7],
    'the stacked squash sits on a branch that is deleted and is an ancestor of nothing',
  );
  const staging = buildStateSnapshot(system)
    .environmentReach.find((g) => g.goalRef === 'issue:7')
    ?.environments.find((e) => e.environment === 'staging');
  assert.equal(staging?.total, 1);
  assert.equal(staging?.status, 'reached');
  assert.deepEqual(
    system.store.listGoalArrivals().map((a) => `${a.goalRef} ${a.environment}`),
    ['issue:7 staging'],
    'the arrival fires rather than the goal reading partial 1/2 for ever',
  );
});

test('an environment is asked where it is once a pulse, not once a landing', async () => {
  const { prober, git } = twoEnvironments(false, false);
  const system = build(TWO_ENVS, prober, git);
  mergedGoal(system);
  system.connector.inject({ kind: 'new_pr', number: 8, title: 'PR 8', branch: 'issue/7/second' });
  system.connector.inject({ kind: 'pr_closed', prNumber: 8, merged: true });

  await system.harness.runCycle();

  assert.deepEqual(prober.asked, ['staging', 'prod']);
});

test('a confirmed landing is never asked about again, and an environment with nothing pending is not asked at all', async () => {
  const { prober, git } = twoEnvironments(true, false);
  const system = build(TWO_ENVS, prober, git);
  mergedGoal(system);

  await system.harness.runCycle();
  await system.harness.runCycle();

  assert.deepEqual(
    prober.asked,
    ['staging', 'prod', 'prod'],
    'staging has nothing left to confirm, so it is not even asked where it is',
  );
});

test('a probe that could not answer marks every landing unknown rather than leaving them silent', async () => {
  const system = build([{ name: 'staging', at: 'unused' }], new FakeEnvironmentProber());
  mergedGoal(system);

  await system.harness.runCycle();

  const row = system.store.listEnvironmentReach().find((r) => r.environment === 'staging');
  assert.equal(row?.status, 'unknown');
  assert.match(row?.detail ?? '', /unscripted/);
});

test('with no environment configured nothing is probed, but landings are still recorded', async () => {
  const prober = new FakeEnvironmentProber();
  const system = build([], prober);
  mergedGoal(system);

  await system.harness.runCycle();

  assert.deepEqual(prober.asked, []);
  assert.equal(system.store.listGoalLandings().length, 1);
});

test('a goal arriving is recorded once, and a later pulse adds nothing', async () => {
  const { prober, git } = twoEnvironments(true, false);
  const system = build(TWO_ENVS, prober, git);
  mergedGoal(system);

  await system.harness.runCycle();
  await system.harness.runCycle();

  const arrivals = system.store.listGoalArrivals();
  assert.equal(arrivals.length, 1, 'arriving twice is not two arrivals');
  assert.equal(arrivals[0]?.goalRef, 'issue:7');
  assert.equal(arrivals[0]?.environment, 'staging');
});

test('half a goal in an environment has not arrived in it', async () => {
  const { prober, git } = twoEnvironments(true, false);
  git.setContains('head-staging', mergeShaFor(8), false);
  const system = build(TWO_ENVS, prober, git);
  mergedGoal(system);
  system.connector.inject({ kind: 'new_pr', number: 8, title: 'PR 8', branch: 'issue/7/second' });
  system.connector.inject({ kind: 'pr_closed', prNumber: 8, merged: true });

  await system.harness.runCycle();

  assert.deepEqual(system.store.listGoalArrivals(), [], 'a release cut between two merges is not an arrival');
});

function announcingDesk(environments: EnvironmentConfig[], now: () => number) {
  const store = new Store(':memory:');
  const comments: IssueCommentInput[] = [];
  const moves: WorkItemStateInput[] = [];
  const sink = {
    async upsertIssueComment(input: IssueCommentInput): Promise<SendResult> {
      comments.push(input);
      return { ok: true, ref: `comment_${comments.length}` };
    },
    async setWorkItemState(input: WorkItemStateInput): Promise<SendResult> {
      moves.push(input);
      return { ok: true, ref: `state_${moves.length}` };
    },
  } as unknown as ActionSink;
  const desk = new EnvironmentDesk({
    store,
    environments,
    healthProber: new FakeEnvironmentHealthProber(),
    healthIntervalMs: 60_000,
    prober: new FakeEnvironmentProber(),
    git: new FakeGitObserver(),
    sink,
    integrationBranch: 'main',
    probeIntervalMs: 60_000,
    now,
  });
  return { store, desk, comments, moves };
}

const TESTUK: EnvironmentConfig[] = [{ name: 'testUk', at: 'unused', arrival: { comment: true } }];

test('an arrival the harness watched happen is said on the ticket, once', async () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const { store, desk, comments } = announcingDesk(TESTUK, () => now);
  store.recordGoalLanding({ prNumber: 4, goalRef: 'issue:12', sha: 'abc' });
  store.recordGoalArrival({ goalRef: 'issue:12', environment: 'testUk', arrivedAt: '2026-08-20T11:59:30.000Z' });

  await desk.run({ issues: [], pullRequests: [], closedPullRequests: [] } as unknown as WorldSnapshot);
  await desk.run({ issues: [], pullRequests: [], closedPullRequests: [] } as unknown as WorldSnapshot);

  assert.equal(comments.length, 1, 'an arrival is a moment, not a status to restate every pulse');
  assert.equal(comments[0]?.number, 12);
  assert.match(comments[0]?.body ?? '', /reached `testUk`/);
  assert.equal(comments[0]?.commentRef, null);
  assert.notEqual(store.listGoalArrivals()[0]?.announcedAt, null);
});

test('an arrival the harness merely discovered is stamped, and says nothing', async () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const { store, desk, comments } = announcingDesk(TESTUK, () => now);
  store.recordGoalArrival({ goalRef: 'issue:12', environment: 'testUk', arrivedAt: '2026-08-13T09:00:00.000Z' });

  await desk.run({ issues: [], pullRequests: [], closedPullRequests: [] } as unknown as WorldSnapshot);

  assert.deepEqual(comments, []);
  assert.notEqual(
    store.listGoalArrivals()[0]?.announcedAt,
    null,
    'stamped anyway, so turning comments on later does not announce a year of history',
  );
});

function establishedDeployment(environments: EnvironmentConfig[], now: number) {
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
    store.recordGoalLanding({ prNumber: n, goalRef: `issue:${n}`, sha: `sha${n}` });
    for (const env of environments) {
      store.recordEnvironmentReach({ sha: `sha${n}`, environment: env.name, status: 'reached', detail: null });
      store.recordGoalArrival({ goalRef: `issue:${n}`, environment: env.name, arrivedAt: clock });
      store.markArrivalAnnounced(`issue:${n}`, env.name);
    }
  }
  clock = new Date(now).toISOString();
  const desk = (envs: EnvironmentConfig[]) =>
    new EnvironmentDesk({
      store,
      environments: envs,
      healthProber: new FakeEnvironmentHealthProber(),
      healthIntervalMs: 60_000,
      prober: new FakeEnvironmentProber(),
      git: new FakeGitObserver(),
      sink,
      integrationBranch: 'main',
      probeIntervalMs: 60_000,
      now: () => now,
    });
  return { store, comments, desk, clock: () => clock };
}

test('a renamed environment catches the deployment up silently', async () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const { store, comments, desk, clock } = establishedDeployment(TESTUK, now);
  assert.deepEqual(comments, [], 'the history was announced under the old name, before this test starts');

  const renamed: EnvironmentConfig[] = [{ name: 'test-uk', at: 'unused', arrival: { comment: true } }];
  for (let n = 1; n <= 12; n += 1)
    store.recordEnvironmentReach({ sha: `sha${n}`, environment: 'test-uk', status: 'reached', detail: null });
  for (let n = 1; n <= 12; n += 1)
    store.recordGoalArrival({ goalRef: `issue:${n}`, environment: 'test-uk', arrivedAt: clock() });

  await desk(renamed).run({ issues: [], pullRequests: [], closedPullRequests: [] } as unknown as WorldSnapshot);

  assert.deepEqual(comments, [], 'nothing about the work changed — the operator edited a string');
  const under = store.listGoalArrivals().filter((a) => a.environment === 'test-uk');
  assert.equal(under.length, 12);
  assert.ok(
    under.every((a) => a.announcedAt !== null),
    'stamped anyway, so the catch-up happens once rather than on every pulse',
  );
});

test('a name with no history still speaks for work that lands after it', async () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const { store, comments, desk } = establishedDeployment(TESTUK, now);
  const added: EnvironmentConfig[] = [...TESTUK, { name: 'liveEu', at: 'unused', arrival: { comment: true } }];
  store.recordGoalLanding({ prNumber: 99, goalRef: 'issue:99', sha: 'sha99' });
  store.recordEnvironmentReach({ sha: 'sha99', environment: 'liveEu', status: 'reached', detail: null });
  store.recordGoalArrival({ goalRef: 'issue:99', environment: 'liveEu', arrivedAt: new Date(now).toISOString() });
  for (let n = 1; n <= 12; n += 1)
    store.recordGoalArrival({ goalRef: `issue:${n}`, environment: 'liveEu', arrivedAt: new Date(now).toISOString() });

  await desk(added).run({ issues: [], pullRequests: [], closedPullRequests: [] } as unknown as WorldSnapshot);

  assert.deepEqual(
    comments.map((c) => c.number),
    [99],
    'the work that landed inside the window is announced; the history it was added on top of is not',
  );
});

const HALLWAY: EnvironmentConfig[] = [{ name: 'hallway', at: 'unused', arrival: { workItemState: 'Worthy' } }];

test('an arrival the harness watched happen moves the work item on, once', async () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const { store, desk, moves } = announcingDesk(HALLWAY, () => now);
  store.recordGoalLanding({ prNumber: 4, goalRef: 'issue:12', sha: 'abc' });
  store.recordGoalArrival({ goalRef: 'issue:12', environment: 'hallway', arrivedAt: '2026-08-20T11:59:30.000Z' });

  await desk.run({ issues: [], pullRequests: [], closedPullRequests: [] } as unknown as WorldSnapshot);
  await desk.run({ issues: [], pullRequests: [], closedPullRequests: [] } as unknown as WorldSnapshot);

  assert.deepEqual(moves, [{ number: 12, state: 'Worthy' }], 'the arrival is a moment, so the board moves once');
  assert.notEqual(store.listGoalArrivals()[0]?.announcedAt, null);
});

test('an arrival the harness merely discovered moves nothing', async () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const { store, desk, moves } = announcingDesk(HALLWAY, () => now);
  store.recordGoalArrival({ goalRef: 'issue:12', environment: 'hallway', arrivedAt: '2026-08-13T09:00:00.000Z' });

  await desk.run({ issues: [], pullRequests: [], closedPullRequests: [] } as unknown as WorldSnapshot);

  assert.deepEqual(moves, [], 'naming the state later does not re-file a year of shipped work');
  assert.notEqual(store.listGoalArrivals()[0]?.announcedAt, null);
});

test('a work item the provider refuses to move is left for the next pulse', async () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const { store, desk } = announcingDesk(HALLWAY, () => now);
  store.recordGoalLanding({ prNumber: 4, goalRef: 'issue:12', sha: 'abc' });
  store.recordGoalArrival({ goalRef: 'issue:12', environment: 'hallway', arrivedAt: '2026-08-20T11:59:30.000Z' });
  const sink = (desk as unknown as { deps: { sink: { setWorkItemState: () => Promise<never> } } }).deps.sink;
  sink.setWorkItemState = () => Promise.reject(new Error('transition not allowed'));

  await desk.run({ issues: [], pullRequests: [], closedPullRequests: [] } as unknown as WorldSnapshot);

  assert.equal(store.listGoalArrivals()[0]?.announcedAt, null, 'unstamped, so the move is retried rather than lost');
});

test('an environment that asks for no comment stamps its arrivals silently', async () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const { store, desk, comments } = announcingDesk([{ name: 'testUk', at: 'unused' }], () => now);
  store.recordGoalArrival({ goalRef: 'issue:12', environment: 'testUk', arrivedAt: '2026-08-20T11:59:30.000Z' });

  await desk.run({ issues: [], pullRequests: [], closedPullRequests: [] } as unknown as WorldSnapshot);

  assert.deepEqual(comments, []);
  assert.notEqual(store.listGoalArrivals()[0]?.announcedAt, null);
});

test('nothing gates the obligations until an environment says it does', () => {
  const arrivals: GoalArrival[] = [];
  assert.equal(
    openedGoals('close_out', [{ name: 'testUk', at: 'x' }], arrivals, []),
    null,
    'null is "nothing gates this" — an empty set would withhold every bench row on earth',
  );
});

test('a gate is opened by whichever environment declaring it the goal reaches first', () => {
  const envs: EnvironmentConfig[] = [
    { name: 'testUk', at: 'x', arrival: { opens: ['validate', 'close_out'] } },
    { name: 'testIe', at: 'x', arrival: { opens: ['validate', 'close_out'] } },
    { name: 'liveUk', at: 'x', arrival: { comment: true } },
  ];
  const arrived = (environment: string): GoalArrival[] => [
    { goalRef: 'issue:12', environment, arrivedAt: '2026-08-20T00:00:00.000Z', announcedAt: null, watchedAt: null },
  ];
  assert.equal(openedGoals('close_out', envs, arrived('testIe'), [])?.has('issue:12'), true);
  assert.equal(
    openedGoals('close_out', envs, arrived('liveUk'), [])?.has('issue:12'),
    false,
    'an environment that opens nothing opens nothing',
  );
});

test('an operator’s release opens every gate on that goal', () => {
  const envs: EnvironmentConfig[] = [{ name: 'testUk', at: 'x', arrival: { opens: ['validate', 'close_out'] } }];
  const releases = [{ goalRef: 'issue:12', note: 'docs only', releasedAt: '2026-08-20T00:00:00.000Z' }];
  assert.equal(openedGoals('validate', envs, [], releases)?.has('issue:12'), true);
  assert.equal(openedGoals('close_out', envs, [], releases)?.has('issue:12'), true);
});

test('a held goal says what it is waiting for, and a released one says nothing', () => {
  const envs: EnvironmentConfig[] = [
    { name: 'testUk', at: 'x', arrival: { opens: ['validate', 'close_out'] } },
    { name: 'testIe', at: 'x', arrival: { opens: ['close_out'] } },
  ];
  const hold = environmentGateHold({ goalRef: 'issue:12', environments: envs, arrivals: [], releases: [] });
  assert.match(hold ?? '', /validation checks/);
  assert.match(hold ?? '', /close-out/);
  assert.match(hold ?? '', /testUk/);
  assert.equal(
    environmentGateHold({
      goalRef: 'issue:12',
      environments: envs,
      arrivals: [],
      releases: [{ goalRef: 'issue:12', note: 'docs only', releasedAt: '2026-08-20T00:00:00.000Z' }],
    }),
    null,
  );
});

test('a delivered goal that merged nothing still draws its hold, and the release lifts it', async () => {
  const environments: EnvironmentConfig[] = [
    { name: 'testUk', at: 'unused', arrival: { opens: ['validate', 'close_out'] } },
  ];
  const system = build(environments, new FakeEnvironmentProber());
  system.connector.inject({ kind: 'new_issue', number: 7, title: 'the goal' });
  await system.harness.runCycle();
  system.store.recordDelivery({
    originRef: 'issue:7',
    summary: 'closed out by hand — nothing here merges',
    by: 'operator',
  });

  await system.harness.runCycle();
  assert.equal(system.store.listGoalLandings().length, 0, 'this goal merged nothing — that is the shape');

  const row = buildStateSnapshot(system).environmentReach.find((g) => g.goalRef === 'issue:7');
  assert.ok(row, 'a held goal earns a row because it is held, not because it has been anywhere');
  assert.match(row.gateHold ?? '', /waiting for this work to reach testUk/);
  assert.deepEqual(
    row.environments.map((e) => [e.environment, e.status, e.landed, e.total]),
    [['testUk', 'absent', 0, 0]],
  );

  system.store.releaseEnvironmentGate('issue:7', 'nothing here deploys');
  await system.harness.runCycle();
  const released = buildStateSnapshot(system).environmentReach.find((g) => g.goalRef === 'issue:7');
  assert.equal(released?.gateHold, null, 'released, so nothing is holding it any more');
  assert.equal(released?.released?.note, 'nothing here deploys', 'and the row says on whose word');
  assert.equal(
    system.store.listHumanTasksOfKind('close_out').some((t) => t.originRef === 'issue:7'),
    true,
    'the close-out the gate was holding is filed on the next pulse',
  );
});

test('a part’s merge lands under the goal, arrives as the goal, and opens the goal’s gate', async () => {
  const environments: EnvironmentConfig[] = [
    { name: 'testUk', at: 'unused', arrival: { opens: ['validate', 'close_out'], comment: true } },
  ];
  const store = new Store(':memory:');
  const comments: IssueCommentInput[] = [];
  const sink = {
    async upsertIssueComment(input: IssueCommentInput): Promise<SendResult> {
      comments.push(input);
      return { ok: true, ref: `comment_${comments.length}` };
    },
  } as unknown as ActionSink;
  store.recordWorkGraph(plannedGoal());
  const desk = new EnvironmentDesk({
    store,
    environments,
    healthProber: new FakeEnvironmentHealthProber(),
    healthIntervalMs: 60_000,
    prober: new FakeEnvironmentProber({ testUk: ['head-testUk'] }),
    git: new FakeGitObserver().setContains('head-testUk', 'sha1', true).setContains('head-testUk', 'sha2', true),
    sink,
    integrationBranch: 'main',
    probeIntervalMs: 60_000,
  });

  await desk.run(world({ closedPullRequests: [mergedPr({ number: 1 }), mergedPr({ number: 2 })] }));

  assert.deepEqual(
    store.listGoalLandings().map((l) => l.goalRef),
    ['issue:12', 'issue:12'],
    'both parts’ merges are the goal’s landings',
  );
  const arrivals = store.listGoalArrivals();
  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0]?.goalRef, 'issue:12', 'the goal arrived, not one part of it');
  assert.equal(openedGoals('close_out', environments, arrivals, [])?.has('issue:12'), true);
  assert.equal(openedGoals('validate', environments, arrivals, [])?.has('issue:12'), true);
  assert.equal(comments[0]?.number, 12, 'and the line goes on the goal’s ticket');
  store.close();
});

test('the rows a part ref was already filed under are repaired on the next boot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-partref-'));
  const path = join(dir, 'landings.db');
  const before = new Store(path);
  before.recordGoalLanding({ prNumber: 1, goalRef: 'issue:12:part:api', sha: 'sha1' });
  before.recordGoalLanding({ prNumber: 2, goalRef: 'issue:12:part:ui', sha: 'sha2' });
  before.recordGoalLanding({ prNumber: 3, goalRef: 'issue:99', sha: 'sha3' });
  before.recordGoalArrival({ goalRef: 'issue:12:part:api', environment: 'testUk', arrivedAt: '2026-08-01' });
  before.recordGoalArrival({ goalRef: 'issue:99', environment: 'testUk', arrivedAt: '2026-08-01' });
  before.close();

  const after = new Store(path);
  assert.deepEqual(
    after.listGoalLandings().map((l) => [l.prNumber, l.goalRef]),
    [
      [1, 'issue:12'],
      [2, 'issue:12'],
      [3, 'issue:99'],
    ],
    'the label is corrected and the fact — which commit which PR merged as — is untouched',
  );
  assert.deepEqual(
    after.listGoalArrivals().map((a) => a.goalRef),
    ['issue:99'],
  );

  after.close();
  const again = new Store(path);
  assert.equal(again.listGoalLandings().length, 3);
  again.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a partial goal arrival is discarded and re-derived after every part arrives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-partial-arrival-'));
  const path = join(dir, 'landings.db');
  const old = Date.parse('2026-08-19T12:00:00.000Z');
  const now = Date.parse('2026-08-23T12:00:00.000Z');
  const before = new Store(path, () => new Date(old).toISOString());
  before.recordWorkGraph(fourPartGoal());
  const plan = before.upsertPlan({ originRef: 'issue:12', title: 'Four parts', status: 'active' });
  const parts = before.upsertPlanParts(
    plan.id,
    ['api', 'ui', 'docs', 'tests'].map((slug, i) => ({
      slug,
      seq: i + 1,
      title: slug,
      scope: slug,
      touches: [],
      dependsOn: [],
      rationale: null,
      acceptance: null,
      size: null,
      expectedKind: null,
      profile: null,
    })),
  );
  before.updatePlanPart(parts[0]!.id, { status: 'merged' });
  before.recordGoalLanding({ prNumber: 1, goalRef: 'issue:12', sha: 'sha1' });
  before.recordEnvironmentReach({ sha: 'sha1', environment: 'testUk', status: 'reached', detail: null });
  before.recordGoalArrival({ goalRef: 'issue:12', environment: 'testUk', arrivedAt: new Date(old).toISOString() });
  before.close();

  const after = new Store(path, () => new Date(now).toISOString());
  const environments: EnvironmentConfig[] = [
    { name: 'testUk', at: 'unused', arrival: { opens: ['close_out'], comment: true } },
  ];
  assert.equal(
    openedGoals('close_out', environments, after.listGoalArrivals(), [])?.has('issue:12'),
    false,
    'a stale partial arrival must not keep the gate open',
  );
  assert.deepEqual(after.listGoalArrivals(), []);

  const comments: IssueCommentInput[] = [];
  const sink = {
    async upsertIssueComment(input: IssueCommentInput): Promise<SendResult> {
      comments.push(input);
      return { ok: true, ref: `comment_${comments.length}` };
    },
  } as unknown as ActionSink;
  const prober = new FakeEnvironmentProber({ testUk: ['head-testUk'] });
  const git = new FakeGitObserver();
  for (const sha of ['sha1', 'sha2', 'sha3', 'sha4']) git.setContains('head-testUk', sha, true);
  for (const part of parts.slice(1)) after.updatePlanPart(part!.id, { status: 'merged' });
  const desk = new EnvironmentDesk({
    store: after,
    environments,
    healthProber: new FakeEnvironmentHealthProber(),
    healthIntervalMs: 60_000,
    prober,
    git,
    sink,
    integrationBranch: 'main',
    probeIntervalMs: 60_000,
    now: () => now,
  });

  await desk.run(
    world({ closedPullRequests: [mergedPr({ number: 2 }), mergedPr({ number: 3 }), mergedPr({ number: 4 })] }),
  );

  const arrivals = after.listGoalArrivals();
  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0]?.goalRef, 'issue:12');
  assert.equal(arrivals[0]?.environment, 'testUk');
  assert.notEqual(arrivals[0]?.announcedAt, null);
  assert.equal(comments.length, 1, 'the repaired row must not suppress the real arrival or duplicate it');
  after.close();
  rmSync(dir, { recursive: true, force: true });
});
