import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  Agent,
  CockpitDecision,
  OpenPullRequest,
  Plan,
  PlanPart,
  PlanPartView,
  PullRequest,
  TaskSummary,
} from '../web/src/types.js';
import type { GoalPageView, GoalPartView, GoalTrack, PartGroup } from '../web/src/view/goalPage.js';
import { buildGoalPage, buildGoalStrip, buildGoalTrack, goalSectionsOpen } from '../web/src/view/goalPage.js';
import { buildNeedsYou } from '../web/src/view/needsYou.js';

const { buildDemoState } = await import('../web/src/demo/fixtures.js');

function part(over: Partial<PlanPart>): PlanPartView {
  return {
    id: 'p:a',
    planId: 'p',
    slug: 'a',
    seq: 1,
    title: 'A',
    scope: 'src/a.ts',
    rationale: null,
    acceptance: null,
    touches: [],
    acceptanceMet: [],
    depth: 0,
    acceptanceCriteria: [],
    outsideScope: [],
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
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function plan(originRef: string): Plan {
  return {
    id: 'p',
    originRef,
    title: 'A plan',
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
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function task(over: Partial<TaskSummary>): TaskSummary {
  return {
    id: 't:x',
    kind: 'code',
    title: 'work',
    branch: null,
    originRef: null,
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'running',
    agentId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function agent(over: Partial<Agent>): Agent {
  return {
    id: 'a:x',
    taskId: 't:x',
    status: 'running',
    cwd: '/work',
    pid: 1,
    waitingReason: null,
    sessionId: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    numTurns: null,
    note: null,
    notedAt: null,
    resumedAt: null,
    resumeAttempts: 0,
    ...over,
  };
}

function decision(over: Partial<CockpitDecision>): CockpitDecision {
  return {
    id: 'd:x',
    cycleId: 'c:1',
    action: { type: 'no_op', reason: 'nothing to do' },
    outcome: 'executed',
    detail: '',
    rule: null,
    admission: null,
    subjectRef: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

test('an unknown goal ref yields null rather than an empty page', () => {
  const state = buildDemoState().state;
  assert.equal(buildGoalPage(state, 'issue:99999', []), null);
});

test('parts group by status, and a retired part joins none of the groups', () => {
  const parts = [
    part({ id: 'p:1', slug: 'one', status: 'merged' }),
    part({ id: 'p:2', slug: 'two', status: 'in_review' }),
    part({ id: 'p:3', slug: 'three', status: 'blocked', blockedReason: 'waits on creds' }),
    part({ id: 'p:4', slug: 'four', status: 'pending' }),
    part({ id: 'p:5', slug: 'five', status: 'retired' }),
  ];
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const page: GoalPageView | null = buildGoalPage(
    { ...state, planParts: parts, plans: [plan(`issue:${issue.number}`)] },
    `issue:${issue.number}`,
    [],
  );

  const groups: [string, PartGroup][] | undefined = page?.parts.map((p: GoalPartView) => [p.part.slug, p.group]);
  assert.deepEqual(groups, [
    ['one', 'merged'],
    ['two', 'now'],
    ['three', 'held'],
    ['four', 'waiting'],
  ]);
});

/**
 * A part names the agent that worked it, and says separately whether it still is.
 *
 * Two fields because the card draws both, and they are not the same claim: a
 * finished agent is still the way to what happened here, while only a live one is
 * a claim that something is happening now — which is what `AgentOnIt` says, in the
 * green it says it in. Folded into one field, a merged part pulses.
 */
test('a part’s agent is live only while it is running', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const ref = `issue:${issue.number}`;
  const parts = [part({ id: 'p:1', slug: 'one', status: 'in_review' })];
  const base = { ...state, planParts: parts, plans: [plan(ref)] };
  const task = { ...state.tasks[0]!, id: 't:one', originRef: `${ref}:part:one` };

  const worked = (endedAt: string | null): GoalPartView => {
    const page = buildGoalPage(
      { ...base, tasks: [task], agents: [agent({ id: 'a:one', taskId: 't:one', endedAt })] },
      ref,
      [],
    );
    const found = page?.parts[0];
    assert.ok(found, 'the part must be on the page');
    return found;
  };

  const live = worked(null);
  assert.equal(live.agentId, 'a:one');
  assert.equal(live.agentLive, true);

  const over = worked('2026-01-01T01:00:00.000Z');
  assert.equal(over.agentId, 'a:one', 'a finished agent is still the way to what happened here');
  assert.equal(over.agentLive, false, 'and is not a claim that anything still is');
});

test('the track folds the same groups the page draws, so the two cannot disagree', () => {
  const parts = [
    part({ id: 'p:1', slug: 'one', status: 'merged' }),
    part({ id: 'p:2', slug: 'two', status: 'concluded' }),
    part({ id: 'p:3', slug: 'three', status: 'dispatched' }),
    part({ id: 'p:4', slug: 'four', status: 'blocked' }),
  ];
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const page = buildGoalPage(
    { ...state, planParts: parts, plans: [plan(`issue:${issue.number}`)] },
    `issue:${issue.number}`,
    [],
  );

  const track: GoalTrack = buildGoalTrack(page?.parts ?? []);
  assert.deepEqual(track, { merged: 2, now: 1, held: 1, waiting: 0, total: 4 });
});

test('only this goal’s asks reach its page', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const needs = buildNeedsYou(state);
  const page = buildGoalPage(state, `issue:${issue.number}`, needs);

  for (const row of page?.needs ?? []) assert.equal(row.goalRef, `issue:${issue.number}`);
});

test('the activity list is this goal’s decisions, read off subjectRef', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const page = buildGoalPage(state, `issue:${issue.number}`, []);

  for (const d of page?.decisions ?? []) {
    assert.ok(d.subjectRef?.startsWith(`issue:${issue.number}`));
  }
});

test('a goal whose number is a prefix of another does not inherit that goal’s agents or decisions', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const ref = `issue:${issue.number}`;
  // Shares `ref` as a string prefix without being this goal or a part of it —
  // exactly what `startsWith(ref)` alone would wrongly admit.
  const otherRef = `issue:${issue.number}9`;

  const otherTask = task({ id: 't:other', originRef: `${otherRef}:part:x` });
  const otherAgent = agent({ id: 'a:other', taskId: otherTask.id });
  const otherDecision = decision({ id: 'd:other', subjectRef: `${otherRef}:part:x` });

  const page = buildGoalPage(
    {
      ...state,
      tasks: [...state.tasks, otherTask],
      agents: [...state.agents, otherAgent],
      decisions: [...state.decisions, otherDecision],
    },
    ref,
    [],
  );

  assert.ok(!page?.agents.some((a) => a.agent.id === otherAgent.id));
  assert.ok(!page?.decisions.some((d) => d.id === otherDecision.id));
});

/**
 * A pull request is opened for a goal, so an agent dispatched at one is an agent on
 * the goal. Read off the `issue:<n>` subtree alone the card said *no agent is on
 * this goal* through every CI fix and review round — which is most of the time a
 * goal has somebody on it.
 */
test('an agent dispatched at this goal’s pull request is one of its agents, and says which PR', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const ref = `issue:${issue.number}`;
  const open: OpenPullRequest = {
    id: 'pr-911',
    number: 911,
    title: 'the goal’s PR',
    branch: `issue/${issue.number}`,
    ciStatus: 'failing',
    unresolvedComments: [],
    merged: false,
    health: { blocked: false, reasons: [] },
    attention: { status: 'harness', reasons: [] },
    ciVerdict: { actionable: true, dispatch: [], escalate: [], ignored: [], urgent: false },
  };
  const ciTask = task({ id: 't:ci', originRef: 'pr:911', title: 'Fix failing CI on PR #911' });
  const ciAgent = agent({ id: 'a:ci', taskId: ciTask.id });
  // Another goal's pull request, dispatched the same way — the reading is the
  // three-way match, never "the origin is a PR".
  const strayTask = task({ id: 't:stray', originRef: 'pr:912' });
  const strayAgent = agent({ id: 'a:stray', taskId: strayTask.id });

  const page = buildGoalPage(
    {
      ...state,
      world: { ...state.world, pullRequests: [open] },
      tasks: [...state.tasks, ciTask, strayTask],
      agents: [ciAgent, strayAgent],
    },
    ref,
    [],
  );

  assert.deepEqual(
    page?.agents.map((a) => [a.agent.id, a.onPr]),
    [['a:ci', 911]],
  );
});

/**
 * The other half of the same fact one tier down: a part whose work has reached
 * review has its agents dispatched at `pr:<n>`, so a part row read off its own
 * origin alone draws no agent on exactly the parts that are moving.
 */
test('a part wears the agent on its pull request, preferring the live one', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const ref = `issue:${issue.number}`;
  const parts = [part({ id: 'p:1', slug: 'one', status: 'in_review', prNumber: 921 })];

  const built = task({ id: 't:build', originRef: `${ref}:part:one` });
  const review = task({ id: 't:review', originRef: 'pr:921' });
  const page = buildGoalPage(
    {
      ...state,
      plans: [plan(ref)],
      planParts: parts,
      tasks: [...state.tasks, built, review],
      // Newest first, as the snapshot orders them.
      agents: [
        agent({ id: 'a:review', taskId: review.id, startedAt: '2026-01-02T00:00:00.000Z' }),
        agent({ id: 'a:build', taskId: built.id, endedAt: '2026-01-01T01:00:00.000Z', status: 'done' }),
      ],
    },
    ref,
    [],
  );

  assert.equal(page?.parts[0]?.agentId, 'a:review');
  assert.equal(page?.parts[0]?.agentLive, true);
});

/**
 * The pull requests a goal owns, and why the part rows are only one of three ways.
 *
 * A goal delivered **whole** has no parts at all — the single-PR arm is exactly
 * "no live parts" — so a page keyed on `prNumber` drew no pull request for any
 * goal the harness worked in one, which is most finished goals.
 */
test('a goal worked whole owns its pull requests by branch, and a merged one is still shown', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const ref = `issue:${issue.number}`;
  const open: OpenPullRequest = {
    id: 'pr-901',
    number: 901,
    title: 'the one PR',
    branch: `issue/${issue.number}`,
    ciStatus: 'passing',
    unresolvedComments: [],
    merged: false,
    health: { blocked: false, reasons: [] },
    attention: { status: 'you', reasons: [] },
    ciVerdict: { actionable: true, dispatch: [], escalate: [], ignored: [], urgent: false },
  };
  const closed: PullRequest = {
    id: 'pr-902',
    number: 902,
    title: 'an earlier attempt, merged',
    branch: `issue/${issue.number}/first`,
    ciStatus: 'passing',
    unresolvedComments: [],
    merged: true,
    state: 'merged',
  };
  // Shares the goal's digits as a branch prefix without being its branch — what a
  // bare `startsWith` would wrongly admit.
  const other: PullRequest = { ...closed, id: 'pr-903', number: 903, branch: `issue/${issue.number}9` };

  const page = buildGoalPage(
    {
      ...state,
      plans: [],
      planParts: [],
      world: { ...state.world, pullRequests: [open], closedPullRequests: [closed, other] },
    },
    ref,
    [],
  );

  assert.deepEqual(
    page?.openPullRequests.map((pr) => pr.number),
    [901],
  );
  assert.deepEqual(
    page?.closedPullRequests.map((pr) => pr.number),
    [902],
  );
});

/**
 * The window forgets; the page must not.
 *
 * `world.closedPullRequests` is `closedPrWindowMs` wide, so a page drawn off it
 * alone lost every pull request a goal shipped a few hours after it merged — the
 * page of a goal delivered last month said nothing had ever named it. The archive
 * is those rows kept for good, and the two are one list here.
 */
test('a goal keeps its closed pull requests after the world’s window has forgotten them', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const ref = `issue:${issue.number}`;
  const archived: PullRequest = {
    id: 'pr-905',
    number: 905,
    title: 'merged months ago',
    branch: `issue/${issue.number}/early`,
    ciStatus: 'unknown',
    unresolvedComments: [],
    merged: true,
    state: 'merged',
  };
  // Another goal's, so the archive is filtered by the same `ownsPr` the window is
  // rather than shipped whole onto every page.
  const elsewhere: PullRequest = { ...archived, id: 'pr-906', number: 906, branch: 'issue/99999/other' };

  const page = buildGoalPage(
    {
      ...state,
      plans: [],
      planParts: [],
      archivedPullRequests: [archived, elsewhere],
      world: { ...state.world, pullRequests: [], closedPullRequests: [] },
    },
    ref,
    [],
  );

  assert.deepEqual(
    page?.closedPullRequests.map((pr) => pr.number),
    [905],
  );
});

/**
 * The two lists carry the same pull request for as long as the window holds it, and
 * the window's copy is the fresher reading — an archived row is only ever the last
 * thing the world said. A page that preferred the archive would draw a title the
 * provider has since changed, on exactly the pull requests still moving.
 */
test('the world’s reading of a closed PR wins over the archived copy of it', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const ref = `issue:${issue.number}`;
  const stale: PullRequest = {
    id: 'pr-907',
    number: 907,
    title: 'the title it was archived under',
    branch: `issue/${issue.number}/rename`,
    ciStatus: 'unknown',
    unresolvedComments: [],
    merged: true,
    state: 'merged',
  };
  const fresh: PullRequest = { ...stale, title: 'the title it merged under' };

  const page = buildGoalPage(
    {
      ...state,
      plans: [],
      planParts: [],
      archivedPullRequests: [stale],
      world: { ...state.world, pullRequests: [], closedPullRequests: [fresh] },
    },
    ref,
    [],
  );

  assert.deepEqual(
    page?.closedPullRequests.map((pr) => pr.title),
    ['the title it merged under'],
  );
});

test('a PR the provider linked is the goal’s, whatever its branch is called', () => {
  const state = buildDemoState().state;
  const issue = { ...state.world.issues[0]!, linkedPrNumber: 904 };
  const linked: PullRequest = {
    id: 'pr-904',
    number: 904,
    title: 'opened by hand off an unconventional branch',
    branch: 'fix/whatever',
    ciStatus: 'unknown',
    unresolvedComments: [],
    merged: true,
    state: 'merged',
  };

  const page = buildGoalPage(
    {
      ...state,
      plans: [],
      planParts: [],
      world: { ...state.world, issues: [issue], pullRequests: [], closedPullRequests: [linked] },
    },
    `issue:${issue.number}`,
    [],
  );

  assert.deepEqual(
    page?.closedPullRequests.map((pr) => pr.number),
    [904],
  );
});

/**
 * Retired parts are held apart from `parts` rather than folded in: every count on
 * the page and the overview's track reads `parts`, and what a plan *proposed* is
 * not what the goal is made of. They are still carried, because "the plan has no
 * live parts" without them is a sentence about a plan the operator cannot read.
 */
test('a goal’s validation checks reach its own page, and only its own', () => {
  const state = buildDemoState().state;
  const checks = state.validationChecks ?? [];
  assert.ok(checks.length > 0, 'the demo writes a validation plan, which this test reads');

  const ref = checks[0]!.originRef;
  const page = buildGoalPage(state, ref, []);

  assert.deepEqual(
    page?.checks.map((c) => c.id),
    checks.filter((c) => c.originRef === ref).map((c) => c.id),
    'every check the goal owns, superseded ones included — the card draws what an amendment withdrew',
  );

  // The other goals draw none of them. The page reads checks off the goal ref, so
  // the failure worth pinning is a filter loose enough to pull another goal's in.
  const elsewhere = state.world.issues.filter((i) => `issue:${i.number}` !== ref);
  for (const issue of elsewhere) {
    assert.deepEqual(buildGoalPage(state, `issue:${issue.number}`, [])?.checks, [], `#${issue.number} owns no check`);
  }
});

test('the header’s validation chip agrees with the checks the card under it draws', () => {
  // The chip is the way in to the card, so the two disagreeing is the one thing
  // this surface exists to prevent. The server folds the verdict; the demo states
  // it by hand, which is exactly where it can drift.
  const state = buildDemoState().state;
  const ref = (state.validationChecks ?? [])[0]!.originRef;
  const page = buildGoalPage(state, ref, []);
  const verdict = page?.issue.validation;
  assert.ok(verdict, 'a goal with checks carries a verdict — null is "no plan", a third reading');

  const live = (page?.checks ?? []).filter((c) => c.supersededReason === null);
  assert.equal(verdict.total, live.length, 'live checks only — a superseded one is out of the count');
  for (const state_ of ['passed', 'failed', 'unrun', 'deferred', 'waived'] as const) {
    assert.equal(verdict[state_], live.filter((c) => c.state === state_).length, `${state_} agrees with the rows`);
  }
});

test('a check on a goal does not reach the page through a part ref that starts the same way', () => {
  const state = buildDemoState().state;
  const ref = (state.validationChecks ?? [])[0]!.originRef;
  // `belongsToGoal` matches descendants, which is right for agents and decisions
  // and wrong here: a check is keyed on the goal itself, so a row filed against
  // something *under* it is not one of the goal's checks.
  const strayed = { ...(state.validationChecks ?? [])[0]!, id: 'strayed', originRef: `${ref}:part:signer` };
  const page = buildGoalPage({ ...state, validationChecks: [...(state.validationChecks ?? []), strayed] }, ref, []);

  assert.equal(
    page?.checks.some((c) => c.id === 'strayed'),
    false,
    'a part-scoped ref is not the goal’s check',
  );
});

test('a plan with no live parts still carries what it proposed', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const parts = [
    part({ id: 'p:1', slug: 'one', seq: 2, status: 'retired' }),
    part({ id: 'p:2', slug: 'two', seq: 1, status: 'retired' }),
  ];
  const page = buildGoalPage(
    { ...state, planParts: parts, plans: [plan(`issue:${issue.number}`)] },
    `issue:${issue.number}`,
    [],
  );

  assert.deepEqual(page?.parts, [], 'a retired part is in no group and in no count');
  assert.deepEqual(
    page?.retiredParts.map((p) => p.slug),
    ['two', 'one'],
    'in the order the plan declared them',
  );
  assert.deepEqual(buildGoalTrack(page?.parts ?? []), { merged: 0, now: 0, held: 0, waiting: 0, total: 0 });
});

/**
 * The track's three rules, each of which is silent when it breaks.
 *
 * Every one of them is a way for the strip to become the fault it replaced: a
 * reading at the top of the page that disagrees with the card it points at.
 */
test('a stage with nothing to measure draws no proportion', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const ref = `issue:${issue.number}`;
  const page = buildGoalPage({ ...state, plans: [], planParts: [], environmentReach: [] }, ref, [])!;

  const strip = buildGoalStrip({ ...page, issue: { ...page.issue, validation: null } });
  const plan = strip.find((s) => s.at === 'plan')!;
  const validation = strip.find((s) => s.at === 'validation')!;

  assert.equal(plan.reading, 'not drawn');
  assert.equal(plan.done, null, 'a goal with no plan has no parts outstanding, so nothing to measure');
  assert.equal(validation.reading, 'no checks');
  assert.equal(
    validation.done,
    null,
    'a goal with no validation plan has no checks outstanding — a bar at 0 would report every one still to run',
  );
});

test('the strip quotes the parts and the checks rather than re-reading them', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const ref = `issue:${issue.number}`;
  const parts = [
    part({ id: 'p:1', slug: 'one', seq: 1, status: 'merged' }),
    part({ id: 'p:2', slug: 'two', seq: 2, status: 'dispatched' }),
    part({ id: 'p:3', slug: 'three', seq: 3, status: 'pending' }),
  ];
  const page = buildGoalPage({ ...state, planParts: parts, plans: [plan(ref)] }, ref, [])!;
  const withChecks: GoalPageView = {
    ...page,
    issue: {
      ...page.issue,
      validation: { state: 'flagged', total: 4, passed: 1, failed: 1, unrun: 2, deferred: 0, waived: 0 },
    },
  };
  const strip = buildGoalStrip(withChecks);

  const planStage = strip.find((s) => s.at === 'plan')!;
  assert.equal(planStage.reading, '1/3 parts merged', 'the same fold the plan card draws');
  assert.equal(planStage.done, (1 / 3) * 100);
  assert.equal(planStage.tone, 'blue', 'something is moving and nothing is held');

  const validation = strip.find((s) => s.at === 'validation')!;
  assert.equal(validation.reading, '1/4 settled', 'passed plus waived, as the header chip counts them');
  assert.equal(validation.tone, 'amber', 'a check actually failed');
});

test('the shipped stage is absent without environments, and never folds unknown into absent', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const ref = `issue:${issue.number}`;
  const bare = buildGoalPage({ ...state, environmentReach: [] }, ref, [])!;
  assert.deepEqual(
    buildGoalStrip(bare).map((s) => s.at),
    ['plan', 'validation', 'tail'],
    'a stage of question marks on a deployment with no environments is a feature announcing itself as broken',
  );

  const unknown = buildGoalStrip({
    ...bare,
    environments: [{ environment: 'prod', status: 'unknown', landed: 0, total: 2, at: null, opens: [] }],
  }).find((s) => s.at === 'environments')!;
  assert.equal(unknown.reading, 'not known', 'a probe that could not say is not work that has not shipped');
  assert.equal(unknown.done, null);
});

test('the ticket is open until the work starts, and folded once it has', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const ref = `issue:${issue.number}`;
  const page = buildGoalPage(state, ref, [])!;

  const fresh: GoalPageView = { ...page, plan: null, parts: [], openPullRequests: [], agents: [] };
  assert.equal(goalSectionsOpen(fresh).ticket, true, 'on a goal nobody has planned the ticket is the page');
  assert.equal(
    goalSectionsOpen({ ...fresh, plan: plan(ref) }).ticket,
    false,
    'a planned goal has been read once already — the ticket is a screen of prose over the work',
  );
});

test('validation and signals stay folded until the work is somewhere', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const nowhere: GoalPageView = {
    ...buildGoalPage(state, `issue:${issue.number}`, [])!,
    checks: [],
    signals: [],
    environments: [{ environment: 'prod', status: 'absent', landed: 0, total: 2, at: null, opens: [] }],
  };

  assert.equal(goalSectionsOpen(nowhere).validation, false);
  assert.equal(goalSectionsOpen(nowhere).signals, false);
  assert.equal(goalSectionsOpen(nowhere).environments, false);

  const page = buildGoalPage(state, `issue:${issue.number}`, [])!;
  const partial: GoalPageView = {
    ...nowhere,
    checks: page.checks,
    signals: page.signals,
    environments: [{ environment: 'prod', status: 'partial', landed: 1, total: 2, at: null, opens: [] }],
  };
  assert.equal(
    goalSectionsOpen(partial).validation,
    partial.checks.length > 0,
    'half the work being out there is what the checks are most needed for',
  );
  assert.equal(goalSectionsOpen(partial).signals, partial.signals.length > 0);
  assert.equal(goalSectionsOpen(partial).environments, true);

  assert.equal(
    goalSectionsOpen({ ...nowhere, environments: partial.environments }).validation,
    false,
    'a goal that shipped without ever declaring a check has an empty card, and says so in its heading',
  );

  const unknown: GoalPageView = {
    ...nowhere,
    environments: [{ environment: 'prod', status: 'unknown', landed: 0, total: 2, at: null, opens: [] }],
  };
  assert.equal(
    goalSectionsOpen(unknown).validation,
    false,
    'a probe that could not say is not a reading that the work arrived',
  );
});

test('a check anyone has ruled on opens validation wherever the work is', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues.find((i) =>
    state.validationChecks.some((c) => c.originRef === `issue:${i.number}`),
  )!;
  const page = buildGoalPage(state, `issue:${issue.number}`, [])!;
  const grounded: GoalPageView = {
    ...page,
    environments: [{ environment: 'prod', status: 'absent', landed: 0, total: 1, at: null, opens: [] }],
  };
  const settled = grounded.checks.some((c) => c.state !== 'unrun');
  assert.equal(
    goalSectionsOpen(grounded).validation,
    settled,
    'a card the operator has already written verdicts into is not a card with nothing in it',
  );
});

test('the record has no relevant moment, so it never opens itself', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const page = buildGoalPage(state, `issue:${issue.number}`, [])!;
  assert.equal(goalSectionsOpen(page).record, false);
});

/**
 * The local validation card opens when there is a row and folds when there is not.
 *
 * Simpler than its neighbours for a reason worth stating: this card is not about a
 * stage of the goal's life, it is about a thing somebody pressed. Either they
 * pressed it or they did not, and the heading says which either way.
 */
test('the local validation card opens exactly when there is something in it', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const page = buildGoalPage(state, `issue:${issue.number}`, [])!;

  const never: GoalPageView = { ...page, issue: { ...page.issue, localValidation: null } };
  assert.equal(goalSectionsOpen(never).localValidation, false, 'a goal nobody has validated draws a folded card');

  const asked: GoalPageView = {
    ...page,
    issue: { ...page.issue, localValidation: { status: 'failed' } as never },
  };
  assert.equal(goalSectionsOpen(asked).localValidation, true);
});
