import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReliabilityInsights, tallyRunOutcomes } from '../src/insights/reliabilityInsights.js';
import { ciStatusOf, diffWorlds } from '../src/world/worldDiff.js';
import type { Agent, AgentStatus, Task, UsageEvent, WorldEvent, WorldSnapshot } from '../src/types.js';
import { resolveWindow, type InsightsWindow } from '../src/insights/insightsWindow.js';

const T0 = Date.parse('2026-08-04T00:00:00.000Z');
const NOW = Date.parse('2026-08-04T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

function agent(id: string, status: AgentStatus, over: Partial<Agent> = {}): Agent {
  return {
    id,
    taskId: `task_${id}`,
    status,
    cwd: `/wt/${id}`,
    pid: null,
    waitingReason: null,
    sessionId: null,
    startedAt: iso(NOW - 30 * MIN),
    endedAt: iso(NOW - 20 * MIN),
    costUsd: 1,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: 3,
    note: null,
    notedAt: null,
    resumedAt: null,
    resumeAttempts: 0,
    ...over,
  };
}

function task(id: string, originRef: string | null, title = `Task ${id}`): Task {
  return {
    id: `task_${id}`,
    kind: 'code',
    title,
    prompt: 'do it',
    branch: null,
    originRef,
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'done',
    agentId: id,
    createdAt: iso(T0),
    updatedAt: iso(T0),
  };
}

function ciEvent(ref: string, status: string, at: number): WorldEvent {
  return { id: `we_${ref}_${at}`, kind: 'pr_ci', ref, summary: `PR #${ref.slice(3)} CI ${status}`, createdAt: iso(at) };
}

function build(
  over: { agents?: Agent[]; tasks?: Task[]; ciEvents?: WorldEvent[]; usageEvents?: UsageEvent[] },
  key: InsightsWindow = '30d',
) {
  return buildReliabilityInsights({
    agents: over.agents ?? [],
    tasks: over.tasks ?? [],
    ciEvents: over.ciEvents ?? [],
    usageEvents: over.usageEvents ?? [],
    window: resolveWindow(key, NOW, null),
    now: NOW,
  });
}

test('a live run is not an outcome, and a stopped run is not a fault', () => {
  const agents = [
    agent('a1', 'done'),
    agent('a2', 'done'),
    agent('a3', 'failed'),
    agent('a4', 'killed'),
    agent('a5', 'running', { endedAt: null }),
    agent('a6', 'waiting', { endedAt: null }),
  ];
  const { runs } = build({ agents, tasks: agents.map((a) => task(a.id, 'issue:12')) });

  assert.equal(runs.live, 2, 'the two live agents are outside every rate');
  assert.equal(runs.settled, 4);
  assert.equal(runs.completed, 2);
  assert.equal(runs.lost, 1, 'only the failure is a fault');
  assert.equal(runs.stopped, 1, 'the killed run is someone’s decision, counted apart');
  assert.equal(runs.completionRate, 0.5);
  assert.equal(runs.lostCostUsd, 1);
});

test('the tally the gauge draws is the one the panel opens with', () => {
  const agents = [agent('a1', 'done'), agent('a2', 'crashed'), agent('a3', 'starting', { endedAt: null })];
  const { runs } = build({ agents, tasks: agents.map((a) => task(a.id, 'issue:9')) });
  const gauge = tallyRunOutcomes(agents);

  assert.equal(runs.settled, gauge.settled);
  assert.equal(runs.live, gauge.live);
  assert.equal(runs.completed, gauge.completed);
  assert.equal(runs.lost, gauge.lost);
  assert.equal(runs.stopped, gauge.stopped);
  assert.equal(runs.completionRate, gauge.completionRate);
});

test('nothing settled is null, never a perfect score', () => {
  const agents = [agent('a1', 'running', { endedAt: null })];
  const { runs } = build({ agents, tasks: [task('a1', 'issue:1')] });
  assert.equal(runs.completionRate, null, 'a rate over no runs is unknown, not 100%');
  assert.equal(tallyRunOutcomes(agents).completionRate, null);
});

test('phases come from the spend classifier, so both panels split the same runs', () => {
  const agents = [
    agent('a1', 'done'),
    agent('a2', 'failed'),
    agent('a3', 'done'),
    agent('a4', 'done'),
    agent('a5', 'done'),
  ];
  const tasks = [
    task('a1', 'issue:12:part:schema'),
    task('a2', 'issue:12:part:api'),
    task('a3', 'issue:12:plan'),
    task('a4', 'pr:41:ci'),
    task('a5', 'job:j1'),
  ];
  const { runs } = build({ agents, tasks });
  const byPhase = new Map(runs.byPhase.map((p) => [p.phase, p]));

  assert.equal(byPhase.get('build')?.settled, 2);
  assert.equal(byPhase.get('build')?.completionRate, 0.5);
  assert.equal(byPhase.get('build')?.lostCostUsd, 1);
  assert.equal(byPhase.get('deliberation')?.completionRate, 1);
  assert.equal(byPhase.get('ci')?.label, 'CI', 'the label is the spend panel’s own');
  assert.equal(byPhase.get('landing'), undefined, 'a CI run is not landing — the split is the same one');
  assert.equal(byPhase.get('job')?.settled, 1);
});

test('an origin the harness went round twice is ranked, and named by its latest run', () => {
  const agents = [
    agent('a1', 'failed', { endedAt: iso(NOW - 90 * MIN) }),
    agent('a2', 'done', { endedAt: iso(NOW - 10 * MIN) }),
    agent('a3', 'done'),
  ];
  const tasks = [
    task('a1', 'pr:41:ci', 'First go at the checks'),
    task('a2', 'pr:41:ci', 'Second go at the checks'),
    task('a3', 'issue:7'),
  ];
  const { runs } = build({ agents, tasks });

  assert.equal(runs.repeats.length, 1, 'the origin that ran once is not a repeat');
  assert.equal(runs.repeats[0]?.originRef, 'pr:41:ci');
  assert.equal(runs.repeats[0]?.runs, 2);
  assert.equal(runs.repeats[0]?.lost, 1);
  assert.equal(runs.repeats[0]?.title, 'Second go at the checks', 'named by what it was last asked to do');
});

test('a CI summary is read back by the matcher that wrote it', () => {
  const world = (ciStatus: 'passing' | 'failing'): WorldSnapshot => ({
    takenAt: iso(T0),
    issues: [],
    pullRequests: [
      {
        id: 'pr-1',
        number: 41,
        title: 'A change',
        branch: 'feat/x',
        baseBranch: 'main',
        ciStatus,
        approved: false,
        mergeable: true,
        merged: false,
        unresolvedComments: [],
      },
    ],
  });

  const events = diffWorlds(world('passing'), world('failing'));
  const ci = events.find((e) => e.kind === 'pr_ci');
  assert.ok(ci, 'the status change is recorded');
  assert.equal(ciStatusOf({ kind: ci.kind, summary: ci.summary }), 'failing');
  assert.equal(ciStatusOf({ kind: 'pr_merged', summary: ci.summary }), null, 'only pr_ci rows are read');
  assert.equal(ciStatusOf({ kind: 'pr_ci', summary: 'PR #41 CI went a bit wrong' }), null);
});

test('a red span ends at the next green and a pending does not end it', () => {
  const events = [
    ciEvent('pr:41', 'failing', NOW - 300 * MIN),
    ciEvent('pr:41', 'pending', NOW - 280 * MIN),
    ciEvent('pr:41', 'passing', NOW - 240 * MIN),
    ciEvent('pr:42', 'failing', NOW - 120 * MIN),
  ];
  const { ci } = build({ ciEvents: events });

  assert.equal(ci.reds, 2);
  assert.equal(ci.greens, 1, 'pending is not a verdict');
  assert.equal(ci.redRate, 2 / 3);
  assert.equal(ci.recoveries, 1);
  assert.equal(ci.medianToGreenMs, 60 * MIN, 'the span runs through the pending, not to it');
  assert.equal(ci.unrecovered, 1);

  const stillRed = ci.flakiest.find((s) => s.ref === 'pr:42');
  assert.equal(stillRed?.stillRed, true);
  assert.equal(stillRed?.redMs, 120 * MIN);
  assert.equal(ci.flakiest.find((s) => s.ref === 'pr:41')?.redMs, 60 * MIN);
});

test('a second failure while already red is another red on the same span', () => {
  const events = [
    ciEvent('pr:41', 'failing', NOW - 100 * MIN),
    ciEvent('pr:41', 'pending', NOW - 90 * MIN),
    ciEvent('pr:41', 'failing', NOW - 80 * MIN),
    ciEvent('pr:41', 'passing', NOW - 40 * MIN),
  ];
  const { ci } = build({ ciEvents: events });

  assert.equal(ci.reds, 2, 'a rerun that failed again is a second failure');
  assert.equal(ci.recoveries, 1);
  assert.equal(ci.medianToGreenMs, 60 * MIN);
  assert.equal(ci.prsAffected, 1);
  assert.equal(ci.prsObserved, 1);
});

test('no verdict observed is null, never a clean pipeline', () => {
  const { ci } = build({ ciEvents: [ciEvent('pr:41', 'pending', NOW - 10 * MIN)] });
  assert.equal(ci.redRate, null, 'a harness watching nothing has not got green CI');
  assert.equal(ci.prsObserved, 0);
  assert.equal(ci.flakiest.length, 0);
});

test('the CI and landing figures are the windowed money, from dated deltas', () => {
  const agents = [agent('a1', 'done'), agent('a2', 'done'), agent('a3', 'done'), agent('a4', 'done')];
  const tasks = [
    task('a1', 'pr:41:ci'),
    task('a2', 'issue:12:part:schema'),
    task('a3', 'pr:41:comments'),
    task('a4', 'pr:41:ci-gate'),
  ];
  const usageEvents: UsageEvent[] = [
    { agentId: 'a1', costUsd: 0.5, at: iso(NOW - 60 * MIN) },
    { agentId: 'a1', costUsd: 0.25, at: iso(NOW - 30 * MIN) },
    { agentId: 'a1', costUsd: 9, at: iso(NOW - 30 * 24 * 60 * MIN) },
    { agentId: 'a2', costUsd: 4, at: iso(NOW - 30 * MIN) },
    { agentId: 'a3', costUsd: 1.5, at: iso(NOW - 30 * MIN) },
    { agentId: 'a4', costUsd: 0.4, at: iso(NOW - 20 * MIN) },
  ];
  const { ci } = build({ agents, tasks, usageEvents }, '7d');
  assert.equal(ci.ciCostUsd, 1.15, 'a blocked gate is the same pipeline’s bill as a failing check');
  assert.equal(ci.landingCostUsd, 1.5, 'answering review is landing, and never in the CI figure');
});

test('CI spend lands on the pull request whose checks it answered', () => {
  const agents = [agent('a1', 'done'), agent('a2', 'done')];
  const tasks = [task('a1', 'pr:41:ci'), task('a2', 'pr:88:ci')];
  const { ci } = build({
    agents,
    tasks,
    ciEvents: [
      ciEvent('pr:41', 'failing', NOW - 120 * MIN),
      ciEvent('pr:41', 'passing', NOW - 90 * MIN),
      ciEvent('pr:41', 'failing', NOW - 60 * MIN),
      ciEvent('pr:41', 'passing', NOW - 50 * MIN),
      ciEvent('pr:88', 'failing', NOW - 40 * MIN),
      ciEvent('pr:88', 'passing', NOW - 30 * MIN),
    ],
    usageEvents: [
      { agentId: 'a1', costUsd: 3, at: iso(NOW - 55 * MIN) },
      { agentId: 'a2', costUsd: 1, at: iso(NOW - 35 * MIN) },
    ],
  });

  const byRef = new Map(ci.flakiest.map((s) => [s.ref, s]));
  assert.equal(byRef.get('pr:41')?.costUsd, 3, 'both of #41’s reds were answered by its own agent');
  assert.equal(byRef.get('pr:41')?.reds, 2);
  assert.equal(byRef.get('pr:88')?.costUsd, 1, 'and #88’s money does not leak onto it');
  assert.equal(ci.ciCostUsd, 4, 'the rows are a partition of the fleet’s CI spend');
});

test('CI spend on a pull request with no verdict counts in the total and in no row', () => {
  const { ci } = build({
    agents: [agent('a1', 'done')],
    tasks: [task('a1', 'pr:41:ci')],
    usageEvents: [{ agentId: 'a1', costUsd: 2.5, at: iso(NOW - 30 * MIN) }],
  });

  assert.equal(ci.ciCostUsd, 2.5);
  assert.equal(ci.flakiest.length, 0);
});

test('the timelines bucket by day and end at now', () => {
  const agents = [agent('a1', 'failed', { endedAt: iso(NOW - 30 * MIN) })];
  const insights = build({
    agents,
    tasks: [task('a1', 'issue:3')],
    ciEvents: [ciEvent('pr:41', 'failing', NOW - 30 * MIN), ciEvent('pr:41', 'passing', NOW - 10 * MIN)],
  });

  const ciBuckets = insights.ci.timeline.buckets;
  const runBuckets = insights.runs.timeline.buckets;
  assert.equal(ciBuckets.length, insights.window.buckets);
  assert.equal(runBuckets.length, insights.window.buckets);
  assert.equal(ciBuckets.at(-1)?.red, 1);
  assert.equal(ciBuckets.at(-1)?.green, 1);
  assert.equal(runBuckets.at(-1)?.settled, 1);
  assert.equal(runBuckets.at(-1)?.lost, 1);
  assert.equal(
    ciBuckets.reduce((a, b) => a + b.red + b.green, 0),
    2,
    'every event lands in exactly one bucket',
  );
});

test('the CI read is bounded by kind and comes back oldest first', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadConfig } = await import('../src/config/config.js');
  const { buildSystem } = await import('../src/system.js');
  const { FakePtyBackend } = await import('../src/pty/fakeBackend.js');
  const { FakeWorktreeManager } = await import('../src/worktree/fakeWorktreeManager.js');

  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-rl-'));
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 3,
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );

  await system.harness.runCycle('manual');
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'Add widget', branch: 'feat/widget' });
  await system.harness.runCycle('manual');
  system.connector.inject({ kind: 'ci_failed', prNumber: 42 });
  await system.harness.runCycle('manual');
  system.connector.inject({ kind: 'ci_passed', prNumber: 42 });
  await system.harness.runCycle('manual');

  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const events = system.store.world.listWorldEventsOfKindsSince(since, ['pr_ci']);
  assert.ok(events.length >= 2, 'both CI transitions are recorded');
  assert.ok(
    events.every((e) => e.kind === 'pr_ci'),
    'the pr_opened row is not in this conversation',
  );
  const statuses = events.map((e) => ciStatusOf(e));
  assert.deepEqual(
    statuses.filter((s) => s === 'failing' || s === 'passing'),
    ['failing', 'passing'],
    'oldest first: the failure comes back before the recovery it was fixed by',
  );
  assert.deepEqual(system.store.world.listWorldEventsOfKindsSince(since, []), [], 'no kinds, no query');
});

test('the run half obeys the window, in every table and not only the headline', () => {
  const day = 24 * 60 * 60 * 1000;
  const inside = agent('a1', 'done');
  const outside = agent('a2', 'failed', {
    startedAt: iso(NOW - 40 * day),
    endedAt: iso(NOW - 40 * day),
    costUsd: 99,
  });
  const tasks = [task('a1', 'issue:7:part:one'), task('a2', 'issue:7:part:two')];

  const week = build({ agents: [inside, outside], tasks }, '7d');
  assert.equal(week.runs.settled, 1);
  assert.equal(week.runs.completionRate, 1, 'a failure a month ago is not this week');
  assert.equal(week.runs.lostCostUsd, 0);
  assert.equal(
    week.runs.byOutcome.reduce((n, o) => n + o.runs, 0),
    1,
    'the outcome bar must count the same population as the rate above it',
  );
  assert.equal(week.runs.byPhase.reduce((n, p) => n + p.settled, 0), 1); // prettier-ignore

  const all = build({ agents: [inside, outside], tasks }, 'all');
  assert.equal(all.runs.settled, 2);
  assert.equal(all.runs.completionRate, 0.5);
  assert.equal(all.runs.lostCostUsd, 99);
});

test('a run that reported tokens and no price is measured, as it is to every spend fold', () => {
  const priced = agent('a1', 'done');
  const tokensOnly = agent('a2', 'done', { costUsd: null, inputTokens: 4000, outputTokens: 200 });
  const silent = agent('a3', 'done', { costUsd: null, inputTokens: null, outputTokens: null });
  const agents = [priced, tokensOnly, silent];
  const { runs } = build({ agents, tasks: agents.map((a) => task(a.id, 'issue:12')) });

  assert.equal(runs.settled, 3);
  assert.equal(runs.unmeasuredRuns, 1, 'only the run that reported nothing at all');
});

test('under `all` the axis spans the CI history too, not just the runs', () => {
  const DAY = 24 * 60 * MIN;
  const events = [
    ciEvent('pr:41', 'failing', NOW - 45 * DAY),
    ciEvent('pr:41', 'passing', NOW - 44 * DAY),
    ciEvent('pr:42', 'failing', NOW - 2 * DAY),
    ciEvent('pr:42', 'passing', NOW - 1 * DAY),
  ];
  const totals = (ci: ReturnType<typeof build>['ci']) => ({
    red: ci.timeline.buckets.reduce((n, b) => n + b.red, 0),
    green: ci.timeline.buckets.reduce((n, b) => n + b.green, 0),
  });

  const bare = build({ ciEvents: events }, 'all').ci;
  assert.equal(bare.reds, 2);
  assert.equal(bare.greens, 2);
  assert.deepEqual(totals(bare), { red: 2, green: 2 }, 'every counted event is on the graph');

  const young = build(
    { agents: [agent('a1', 'done', { startedAt: iso(NOW - DAY), endedAt: iso(NOW - DAY) })], ciEvents: events },
    'all',
  ).ci;
  assert.deepEqual(totals(young), { red: young.reds, green: young.greens });

  const old = build(
    {
      agents: [agent('a1', 'done', { startedAt: iso(NOW - 60 * DAY), endedAt: iso(NOW - 60 * DAY) })],
      ciEvents: events,
    },
    'all',
  ).ci;
  assert.deepEqual(totals(old), { red: old.reds, green: old.greens });
  assert.ok(
    Date.parse(old.timeline.startsAt) < Date.parse(young.timeline.startsAt),
    'the older agent still widens the axis past the oldest event',
  );
});
