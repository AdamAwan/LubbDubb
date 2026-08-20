import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { mergeShaFor } from '../src/integrations/fake/fakeGitHub.js';
import { FakeEnvironmentProber } from '../src/environments/fakeProber.js';
import { CommandEnvironmentProber } from '../src/environments/prober.js';
import { validateEnvironments, type EnvironmentConfig } from '../src/environments/policy.js';
import { unattributedMerges, unrecordedLandings } from '../src/environments/landings.js';
import { goalReach } from '../src/environments/reach.js';
import { environmentGateHold, openedGoals } from '../src/environments/arrival.js';
import { EnvironmentDesk } from '../src/environments/environmentDesk.js';
import { GitCliObserver } from '../src/git/gitObserver.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { Store } from '../src/store/store.js';
import { gitRepo } from './support/gitRepo.js';
import type { ActionSink, IssueCommentInput, SendResult } from '../src/sink/actionSink.js';
import type {
  EnvironmentReading,
  GoalArrival,
  GoalLanding,
  PullRequest,
  WorkNode,
  WorldSnapshot,
} from '../src/types.js';

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

const ENVS: EnvironmentConfig[] = [
  { name: 'staging', at: 'unused' },
  { name: 'prod', at: 'unused' },
];

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

test('the probe answers with commits, and anything else is not an answer', async () => {
  const prober = new CommandEnvironmentProber(process.cwd(), 10_000);
  const head = await prober.at('prod', 'node -e "console.log(\'cafe123\')"');
  assert.deepEqual(head.commits, ['cafe123']);

  // Several services at several versions, in one spawn — the laggard governs, and
  // that fold is the clone's ({@link GitObserver.contains}), not the probe's.
  const many = await prober.at('prod', "node -e \"console.log('aaa'); console.log('bbb')\"");
  assert.deepEqual(many.commits, ['aaa', 'bbb']);

  // The case the whole two-valued shape exists for: an expired credential, a
  // missing binary and an environment holding nothing all fail to answer, and
  // none of them is the environment saying "not deployed".
  const failed = await prober.at('prod', 'node -e "console.error(\'no kubeconfig\'); process.exit(3)"');
  assert.equal(failed.commits, null);
  assert.match(failed.detail ?? '', /exit 3/);
  assert.match(failed.detail ?? '', /no kubeconfig/);

  const missing = await prober.at('prod', 'definitely-not-a-real-binary-xyz');
  assert.equal(missing.commits, null, 'a command that does not exist has not said where the environment is');

  // A pipeline query with no successful run prints nothing and exits 0, which is
  // the same output a broken query gives. Unanswered is the direction that gets
  // asked again rather than the one that reports the fleet as never shipped.
  const silent = await prober.at('prod', 'node -e "process.exit(0)"');
  assert.equal(silent.commits, null);
  assert.match(silent.detail ?? '', /named no commit/);
});

test('the environment’s name reaches the command, and no commit does', async () => {
  const prober = new CommandEnvironmentProber(process.cwd(), 10_000);
  // Nothing about a commit is passed in at all — there is no placeholder for an
  // operator's command to have never learned about, which is the whole class of
  // silently-answering-the-wrong-question this shape removes.
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

// --- configuration ---------------------------------------------------------

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
  // The one that would otherwise leave every goal unanswered, forever.
  assert.throws(() => validateEnvironments([{ name: 'prod', at: '  ' }]), /non-empty command/);
  // The previous key asked a different question, so a file still carrying it is
  // named rather than ignored: silently loading it is an environment that never
  // answers anything, which is the exact silence the verdicts exist to prevent.
  assert.throws(
    () => validateEnvironments([{ name: 'prod', command: 'git merge-base --is-ancestor x y' } as never]),
    /no longer read/,
  );
  assert.doesNotThrow(() => validateEnvironments([]));
});

test('an arrival that cannot mean what it says is refused at load', () => {
  const env = (arrival: unknown): EnvironmentConfig[] => [{ name: 'testUk', at: 'x', arrival } as EnvironmentConfig];
  // Reads as a gate and gates nothing — the shape most likely to be written by
  // somebody who meant one and left it for later.
  assert.throws(() => validateEnvironments(env({ opens: [] })), /is empty/);
  assert.throws(() => validateEnvironments(env({ opens: ['deploy'] })), /not an obligation/);
  assert.throws(() => validateEnvironments(env({})), /declares nothing/);
  assert.throws(() => validateEnvironments(env({ comment: 'yes' })), /true or false/);
  assert.doesNotThrow(() => validateEnvironments(env({ opens: ['validate', 'close_out'], comment: true })));
  assert.doesNotThrow(() => validateEnvironments(env({ comment: true })));
});

test('no environments configured is the off switch, and it loads', () => {
  assert.deepEqual(loadConfig({}).environments, []);
});

// --- the clone's half (the subject really is git) ---------------------------

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
  // The clause the three-valued answer exists for: an object this checkout never
  // fetched and a commit that genuinely has not shipped are the same silence, and
  // only one of them is about deployment.
  assert.equal(said.get(absent), null, 'a commit the clone does not hold is not "no"');

  // Several services at several versions: the laggard governs, so a commit one
  // head has and another does not is not there.
  const both = await observer.contains([older, newer], [head, newer]);
  assert.equal(both.get(older), true);
  assert.equal(both.get(newer), false, 'reachable from one head is not reachable from every head');

  const unresolvable = await observer.contains([older], ['not-a-ref-anywhere']);
  assert.equal(unresolvable.get(older), null, 'a head that resolves to nothing answers about nothing');

  // Never "everything is in it", which is the one way this can be wrong at scale.
  const noHeads = await observer.contains([older], []);
  assert.equal(noHeads.get(older), null);

  rmSync(dir, { recursive: true, force: true });
});

// --- the whole system ------------------------------------------------------

/**
 * A system with environments configured, a scripted probe, and a clone that has
 * been told what each head holds. Three fakes because the subject is the fold
 * between them — no shell, no git, no network.
 */
function build(
  environments: EnvironmentConfig[],
  prober: FakeEnvironmentProber,
  git: FakeGitObserver = new FakeGitObserver(),
) {
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
    gitObserver: git,
  });
}

/** The heads two environments sit at, and what each holds of PR 7's merge. */
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

/** A goal whose single pull request has merged — the shape every case below starts from. */
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

test('an environment is asked where it is once a pulse, not once a landing', async () => {
  const { prober, git } = twoEnvironments(false, false);
  const system = build(TWO_ENVS, prober, git);
  mergedGoal(system);
  system.connector.inject({ kind: 'new_pr', number: 8, title: 'PR 8', branch: 'issue/7/second' });
  system.connector.inject({ kind: 'pr_closed', prNumber: 8, merged: true });

  await system.harness.runCycle();

  // Two landings, two environments — and two questions, not four. This is the
  // whole cost argument: the spawn is per environment, and the clone answers the
  // rest in a batch.
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
  // Nothing scripted for `staging`, which is the fake's stand-in for a probe that
  // failed: an environment that has gone dark is a thing the cockpit has to be
  // able to say.
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
  // The merge SHA is only on offer inside the closed window, so a deployment that
  // configures its first environment next month still has this month's landings.
  assert.equal(system.store.listGoalLandings().length, 1);
});

// --- arrivals ---------------------------------------------------------------

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

// --- announcing an arrival --------------------------------------------------

/** A desk on a memory store with a recording sink — the seam the comment goes through. */
function announcingDesk(environments: EnvironmentConfig[], now: () => number) {
  const store = new Store(':memory:');
  const comments: IssueCommentInput[] = [];
  const sink = {
    async upsertIssueComment(input: IssueCommentInput): Promise<SendResult> {
      comments.push(input);
      return { ok: true, ref: `comment_${comments.length}` };
    },
  } as unknown as ActionSink;
  const desk = new EnvironmentDesk({
    store,
    environments,
    prober: new FakeEnvironmentProber(),
    git: new FakeGitObserver(),
    sink,
    probeIntervalMs: 60_000,
    now,
  });
  return { store, desk, comments };
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
  // A fresh comment rather than an edit: this is a thing that happened at a time,
  // and editing one in place would rewrite the record of the last environment.
  assert.equal(comments[0]?.commentRef, null);
  assert.notEqual(store.listGoalArrivals()[0]?.announcedAt, null);
});

test('an arrival the harness merely discovered is stamped, and says nothing', async () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const { store, desk, comments } = announcingDesk(TESTUK, () => now);
  // A reading from last week: the first pulse after this ships finds every goal
  // already in the environment, and a comment on each is the backfill-on-boot
  // failure wearing a ticket thread.
  store.recordGoalArrival({ goalRef: 'issue:12', environment: 'testUk', arrivedAt: '2026-08-13T09:00:00.000Z' });

  await desk.run({ issues: [], pullRequests: [], closedPullRequests: [] } as unknown as WorldSnapshot);

  assert.deepEqual(comments, []);
  assert.notEqual(
    store.listGoalArrivals()[0]?.announcedAt,
    null,
    'stamped anyway, so turning comments on later does not announce a year of history',
  );
});

test('an environment that asks for no comment stamps its arrivals silently', async () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const { store, desk, comments } = announcingDesk([{ name: 'testUk', at: 'unused' }], () => now);
  store.recordGoalArrival({ goalRef: 'issue:12', environment: 'testUk', arrivedAt: '2026-08-20T11:59:30.000Z' });

  await desk.run({ issues: [], pullRequests: [], closedPullRequests: [] } as unknown as WorldSnapshot);

  assert.deepEqual(comments, []);
  assert.notEqual(store.listGoalArrivals()[0]?.announcedAt, null);
});

// --- the gate ---------------------------------------------------------------

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
    { goalRef: 'issue:12', environment, arrivedAt: '2026-08-20T00:00:00.000Z', announcedAt: null },
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
