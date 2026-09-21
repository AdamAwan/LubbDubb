import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  Agent,
  CockpitDecision,
  Escalation,
  OpenPullRequest,
  PlanView,
  PlanPart,
  PlanPartView,
  PullRequest,
  TaskSummary,
} from '../web/src/types.js';
import type { GoalPageView, GoalPartView, GoalTrack, PartGroup } from '../web/src/view/goalPage.js';
import {
  buildGoalPage,
  buildGoalNav,
  buildGoalTrack,
  GOAL_TAB_OF,
  goalSectionsOpen,
  planVerdictAsk,
  splitGoalAsks,
  standsFor,
} from '../web/src/view/goalPage.js';
import type { NeedRow } from '../web/src/view/needsYou.js';
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

function plan(originRef: string): PlanView {
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
    revealed: true,
    revealedAt: null,
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
    steps: null,
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

  // Every other goal draws its own rows and nobody else's. The demo carries a second check set — one
  // still waiting on an operator's accept — so "every other goal draws nothing" was an assertion about
  // the fixture rather than about the lens.
  const elsewhere = state.world.issues.filter((i) => `issue:${i.number}` !== ref);
  for (const issue of elsewhere) {
    const theirs = `issue:${issue.number}`;
    assert.deepEqual(
      buildGoalPage(state, theirs, [])?.checks.map((c) => c.id),
      checks.filter((c) => c.originRef === theirs).map((c) => c.id),
      `#${issue.number} draws its own checks and only its own`,
    );
  }
});

test('the header’s validation chip agrees with the checks the card under it draws', () => {
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

test('a stage with nothing to measure draws no proportion', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const ref = `issue:${issue.number}`;
  const page = buildGoalPage({ ...state, plans: [], planParts: [], environmentReach: [] }, ref, [])!;

  const nav = buildGoalNav({ ...page, issue: { ...page.issue, validation: null } });
  const plan = nav.find((t) => t.tab === 'plan')!;
  const checks = nav.find((t) => t.tab === 'validate')!;

  assert.equal(plan.reading, 'not drawn');
  assert.equal(plan.done, null, 'a goal with no plan has no parts outstanding, so nothing to measure');
  assert.equal(checks.reading, 'no checks');
  assert.equal(
    checks.done,
    null,
    'a goal with no check plan has no checks outstanding — a bar at 0 would report every one still to run',
  );
});

test('a tab quotes the parts and the checks rather than re-reading them', () => {
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
      validation: {
        state: 'flagged',
        total: 4,
        passed: 1,
        failed: 1,
        unrun: 2,
        deferred: 0,
        waived: 0,
        captured: 0,
        declined: 0,
      },
    },
  };
  const nav = buildGoalNav(withChecks);

  const planTab = nav.find((t) => t.tab === 'plan')!;
  assert.equal(planTab.reading, '1/3 parts merged', 'the same fold the plan card draws');
  assert.equal(planTab.done, (1 / 3) * 100);
  assert.equal(planTab.tone, 'blue', 'something is moving and nothing is held');

  const checks = nav.find((t) => t.tab === 'validate')!;
  assert.equal(checks.reading, '1 of 4 done', 'passed plus waived, as the check plan counts them');
  assert.equal(checks.tone, 'amber', 'a check actually failed');
});

test('the close tab is drawn without environments, and never folds unknown into absent', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const ref = `issue:${issue.number}`;
  const bare = buildGoalPage({ ...state, environmentReach: [] }, ref, [])!;
  /* The tab is drawn and says so, rather than being left out: the close-out is owed on
     every deployment, whether or not an environment's arrival is what opens it. */
  assert.equal(buildGoalNav(bare).find((t) => t.tab === 'close')!.reading, 'not reached');

  const unknown = buildGoalNav({
    ...bare,
    environments: [
      { environment: 'prod', status: 'unknown', landed: 0, total: 2, unplaced: 0, at: null, opens: [], sheet: null },
    ],
  }).find((t) => t.tab === 'close')!;
  assert.equal(unknown.reading, 'not known', 'a probe that could not say is not work that has not shipped');
  assert.equal(unknown.done, null);
});

test('validation and signals stay folded until the work is somewhere', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const nowhere: GoalPageView = {
    ...buildGoalPage(state, `issue:${issue.number}`, [])!,
    checks: [],
    signals: [],
    environments: [
      { environment: 'prod', status: 'absent', landed: 0, total: 2, unplaced: 0, at: null, opens: [], sheet: null },
    ],
  };

  assert.equal(goalSectionsOpen(nowhere).validation, false);
  assert.equal(goalSectionsOpen(nowhere).signals, false);
  assert.equal(goalSectionsOpen(nowhere).environments, false);

  const page = buildGoalPage(state, `issue:${issue.number}`, [])!;
  const partial: GoalPageView = {
    ...nowhere,
    checks: page.checks,
    signals: page.signals,
    environments: [
      { environment: 'prod', status: 'partial', landed: 1, total: 2, unplaced: 0, at: null, opens: [], sheet: null },
    ],
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
    environments: [
      { environment: 'prod', status: 'unknown', landed: 0, total: 2, unplaced: 0, at: null, opens: [], sheet: null },
    ],
  };
  assert.equal(
    goalSectionsOpen(unknown).validation,
    false,
    'a probe that could not say is not a reading that the work arrived',
  );
});

test('the criteria fold is the page at its widest, for the card to narrow', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const page = buildGoalPage(state, `issue:${issue.number}`, [])!;

  /* Whether anybody has written what "done" means is a read the goal page does not
     carry, so the default here can only be the widest honest answer — and the card
     narrows it off its own reading, while the operator has not said otherwise.
     → docs/spec/17-cockpit.md#goal-criteria-and-drift */
  assert.equal(goalSectionsOpen(page).criteria, true);
  assert.equal(GOAL_TAB_OF.criteria, 'plan', 'the criteria card is drawn beside the plan it is read against');
});

test('a check anyone has ruled on opens validation wherever the work is', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues.find((i) =>
    state.validationChecks.some((c) => c.originRef === `issue:${i.number}`),
  )!;
  const page = buildGoalPage(state, `issue:${issue.number}`, [])!;
  const grounded: GoalPageView = {
    ...page,
    environments: [
      { environment: 'prod', status: 'absent', landed: 0, total: 1, unplaced: 0, at: null, opens: [], sheet: null },
    ],
  };
  const settled = grounded.checks.some((c) => c.state !== 'unrun');
  assert.equal(
    goalSectionsOpen(grounded).validation,
    settled,
    'a card the operator has already written verdicts into is not a card with nothing in it',
  );
});

test('a superseded check is not something in the card', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues.find((i) =>
    state.validationChecks.some((c) => c.originRef === `issue:${i.number}`),
  )!;
  const page = buildGoalPage(state, `issue:${issue.number}`, [])!;
  const live = page.checks.filter((c) => c.supersededReason === null);
  assert.ok(live.length > 0, 'the goal the fixture picked has no live checks to supersede');

  /* Every live row unrun, and one the plan moved past already passed. The card draws the superseded
     row nowhere, so opening on it is the page reporting work that is not on it — and the heading it
     opens under still reads "no checks". */
  const moved: GoalPageView = {
    ...page,
    environments: [],
    checks: [
      ...live.map((c) => ({ ...c, state: 'unrun' as const })),
      { ...live[0]!, id: `${live[0]!.id}-old`, state: 'passed' as const, supersededReason: 'the plan was amended' },
    ],
  };
  assert.equal(goalSectionsOpen(moved).validation, false, 'a superseded verdict opened a card with nothing live in it');

  const ruled: GoalPageView = { ...moved, checks: [{ ...live[0]!, state: 'passed' as const }, ...live.slice(1)] };
  assert.equal(goalSectionsOpen(ruled).validation, true, 'a live verdict still opens the card');
});

test('the record has no relevant moment, so it never opens itself', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const page = buildGoalPage(state, `issue:${issue.number}`, [])!;
  assert.equal(goalSectionsOpen(page).record, false);
});

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

test('standsFor reads a job origin through to the work it is redoing', () => {
  const state = buildDemoState().state;
  const jobs = [
    { id: 'j1', originRef: 'issue:41:retro' },
    { id: 'j2', originRef: 'job:j1' },
    { id: 'j3', originRef: null },
    { id: 'c1', originRef: 'job:c2' },
    { id: 'c2', originRef: 'job:c1' },
  ] as never;
  const withJobs = { ...state, jobs };

  assert.equal(standsFor(withJobs, 'job:j1'), 'issue:41:retro', 'the origin the job stands in for');
  assert.equal(standsFor(withJobs, 'job:j2'), 'issue:41:retro', 'a requeue of a requeue walks the chain');
  assert.equal(standsFor(withJobs, 'job:j3'), 'job:j3', 'an ordinary operator job stands in for nothing');
  assert.equal(standsFor(withJobs, 'job:gone'), 'job:gone', 'a job the snapshot has dropped stays itself');
  assert.equal(standsFor(withJobs, 'issue:41'), 'issue:41', 'every other origin is its own answer');
  assert.equal(standsFor(withJobs, null), null);
  assert.match(standsFor(withJobs, 'job:c1') ?? '', /^job:c[12]$/, 'a cycle ends at the bound rather than spinning');
});

function planAsk(over: Partial<NeedRow>): NeedRow {
  return {
    id: 'e:1',
    kind: 'plan',
    group: 'blocking',
    urgency: 'now',
    title: 'Plan ready',
    goalRef: null,
    originRef: null,
    opens: 'goal',
    agentId: null,
    agentLabel: null,
    holding: 0,
    raisedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function planEscalation(id: string, planId: string): Escalation {
  return {
    id,
    type: 'approve_change',
    status: 'open',
    prompt: 'A plan is ready',
    context: { planId },
    agentId: null,
    taskId: null,
    response: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    answeredAt: null,
  };
}

test('the plan’s verdict is asked beside the plan once it is revealed and still undecided', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const ref = `issue:${issue.number}`;
  const base = buildGoalPage({ ...state, plans: [plan(ref)] }, ref, [])!;
  const waiting: GoalPageView = {
    ...base,
    plan: { ...base.plan!, status: 'awaiting_approval', revealed: true },
    needs: [planAsk({})],
  };
  const escalations = [planEscalation('e:1', 'p')];

  assert.equal(planVerdictAsk(waiting, escalations)?.id, 'e:1');

  const withheld: GoalPageView = { ...waiting, plan: { ...waiting.plan!, revealed: false } };
  assert.equal(
    planVerdictAsk(withheld, escalations),
    null,
    'under the gate every verdict is refused server-side, so the ask is not drawn there',
  );

  const approved: GoalPageView = { ...waiting, plan: { ...waiting.plan!, status: 'active' } };
  assert.equal(planVerdictAsk(approved, escalations), null, 'a plan under way is not waiting on a verdict');

  const amendment: GoalPageView = { ...waiting, needs: [planAsk({ id: 'e:2' })] };
  assert.equal(
    planVerdictAsk(amendment, [planEscalation('e:2', 'other')]),
    null,
    'a `plan` ask about another plan — a change to a running one — is not this plan’s verdict',
  );
});

test('an ask is drawn in the pane it is about, and stays a row everywhere else', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const ref = `issue:${issue.number}`;
  const base = buildGoalPage({ ...state, plans: [plan(ref)] }, ref, [])!;
  const page: GoalPageView = {
    ...base,
    plan: { ...base.plan!, status: 'awaiting_approval', revealed: true },
    needs: [
      planAsk({}),
      /* About the goal as a whole — no pane owns it, so it can only ever be a row. */
      planAsk({ id: 'profile:1', kind: 'profile' }),
      planAsk({ id: 'task:check', kind: 'validate' }),
      planAsk({ id: 'placement:parent:1', kind: 'placement' }),
    ],
  };
  const escalations = [planEscalation('e:1', 'p')];

  const onPlan = splitGoalAsks(page, escalations, 'plan');
  assert.deepEqual(
    onPlan.inPane.map((row) => row.id),
    [],
    'the plan ask is the plan card’s in both states, and the parent ask is the foot band’s',
  );
  assert.deepEqual(
    onPlan.lines.map((row) => row.id),
    ['profile:1', 'task:check'],
    'the checks ask belongs to another pane, and the profile ask to none',
  );

  const onValidate = splitGoalAsks(page, escalations, 'validate');
  assert.deepEqual(
    onValidate.inPane.map((row) => row.id),
    ['task:check'],
    'the checks ask is drawn in full on the pane that owns the rows',
  );
  assert.deepEqual(
    onValidate.lines.map((row) => row.id),
    ['e:1', 'profile:1'],
  );
});

test('a withheld plan’s ask is the gate’s, never a card above it as well', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const ref = `issue:${issue.number}`;
  const base = buildGoalPage({ ...state, plans: [plan(ref)] }, ref, [])!;
  const gated: GoalPageView = {
    ...base,
    plan: { ...base.plan!, status: 'awaiting_approval', revealed: false },
    needs: [planAsk({})],
  };
  const escalations = [planEscalation('e:1', 'p')];

  const split = splitGoalAsks(gated, escalations, 'plan');
  assert.deepEqual(split.inPane, [], 'the gate is what asks it — a card saying reveal it is the ask twice');
  assert.deepEqual(split.lines, [], 'and neither is a row that leads back to the card in front of them');
  assert.equal(planVerdictAsk(gated, escalations), null, 'no verdict is asked under the gate');
});
