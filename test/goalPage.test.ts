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
import { buildGoalPage, buildGoalStrip, buildGoalTrack } from '../web/src/view/goalPage.js';
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
