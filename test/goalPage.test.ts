import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, CockpitDecision, OpenPullRequest, Plan, PlanPart, PullRequest, Task } from '../web/src/types.js';
import type { GoalPageView, GoalPartView, GoalTrack, PartGroup } from '../web/src/view/goalPage.js';
import { buildGoalPage, buildGoalTrack } from '../web/src/view/goalPage.js';
import { buildNeedsYou } from '../web/src/view/needsYou.js';

const { buildDemoState } = await import('../web/src/demo/fixtures.js');

function part(over: Partial<PlanPart>): PlanPart {
  return {
    id: 'p:a',
    planId: 'p',
    slug: 'a',
    seq: 1,
    title: 'A',
    scope: 'src/a.ts',
    rationale: null,
    acceptance: null,
    expectedKind: null,
    outcomeKind: null,
    outcomeRef: null,
    outcomeSummary: null,
    dependsOn: [],
    branch: null,
    prNumber: null,
    status: 'ready',
    blockedReason: null,
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
    risks: null,
    outOfScope: null,
    document: null,
    discussing: false,
    statusCommentRef: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function task(over: Partial<Task>): Task {
  return {
    id: 't:x',
    kind: 'code',
    title: 'work',
    prompt: '',
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
    numTurns: null,
    note: null,
    notedAt: null,
    resumedAt: null,
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

  assert.ok(!page?.agents.some((a) => a.id === otherAgent.id));
  assert.ok(!page?.decisions.some((d) => d.id === otherDecision.id));
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
