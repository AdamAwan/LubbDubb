import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenPullRequest, ValidationCheckView } from '../web/src/types.js';
import type { GoalPageView } from '../web/src/view/goalPage.js';
import { buildGoalPage, goalTabBadges, goalTabOpening, GOAL_TABS, GOAL_TAB_OF } from '../web/src/view/goalPage.js';
import { GOAL_SECTIONS } from '../web/src/view/goalPage.js';

const { buildDemoState } = await import('../web/src/demo/fixtures.js');

function bare(): GoalPageView {
  const state = buildDemoState().state;
  const issue = state.world.issues[0]!;
  const page = buildGoalPage(state, `issue:${issue.number}`, [])!;
  return {
    ...page,
    issue: {
      ...page.issue,
      state: 'open',
      instructions: [],
      validation: null,
      localValidation: null,
      spend: null,
      conclusion: { ...page.issue.conclusion, verdict: 'undeclared' },
    },
    plan: null,
    parts: [],
    agents: [],
    openPullRequests: [],
    closedPullRequests: [],
    checks: [],
    remoteSheets: [],
    environments: [],
    gateHold: null,
  };
}

function openPr(over: Partial<OpenPullRequest> = {}): OpenPullRequest {
  return {
    id: 'pr-901',
    number: 901,
    title: 'a pull request',
    branch: 'issue/1',
    ciStatus: 'passing',
    unresolvedComments: [],
    merged: false,
    health: { blocked: false, reasons: [] },
    attention: { status: 'harness', reasons: [] },
    ciVerdict: { actionable: true, dispatch: [], escalate: [], ignored: [], urgent: false },
    ...over,
  };
}

test('every foldable section is drawn in exactly one pane', () => {
  for (const section of GOAL_SECTIONS) {
    assert.ok(
      GOAL_TABS.includes(GOAL_TAB_OF[section]),
      `${section} is behind a pane that does not exist — a card nothing draws is a card nobody reads`,
    );
  }
});

test('a goal nobody has planned opens on its ticket', () => {
  const page = bare();
  assert.equal(goalTabOpening(page).tab, 'ticket');
  assert.match(goalTabOpening(page).why, /planned/);
});

test('a plan, a pull request or an agent moves the landing to the work', () => {
  const page = bare();
  assert.equal(goalTabOpening({ ...page, openPullRequests: [openPr()] }).tab, 'work');
});

test('a pull request in the operator’s court outranks a running check', () => {
  const page = bare();
  const checks = [{ ...(buildDemoState().state.validationChecks ?? [])[0] }] as ValidationCheckView[];
  const validating: GoalPageView = {
    ...page,
    checks,
    issue: { ...page.issue, localValidation: null },
    openPullRequests: [openPr({ attention: { status: 'you', reasons: ['review'] } })],
  };
  assert.equal(goalTabOpening(validating).tab, 'work', 'the ask in your own court is what moves the goal');
});

test('a held gate beats everything but a finished goal', () => {
  const page = bare();
  const held: GoalPageView = {
    ...page,
    gateHold: 'validate',
    openPullRequests: [openPr({ attention: { status: 'you', reasons: ['review'] } })],
  };
  assert.equal(goalTabOpening(held).tab, 'shipping');

  const finished: GoalPageView = { ...held, issue: { ...held.issue, state: 'closed' } };
  assert.equal(goalTabOpening(finished).tab, 'record', 'nothing is left to steer on a shut goal');
});

test('a flagged validation plan opens on validation, a clear one does not', () => {
  const page = bare();
  const flagged: GoalPageView = {
    ...page,
    openPullRequests: [openPr()],
    issue: {
      ...page.issue,
      validation: { state: 'flagged', total: 3, passed: 1, failed: 1, unrun: 1, deferred: 0, waived: 0, captured: 0 },
    },
  };
  assert.equal(goalTabOpening(flagged).tab, 'validation');

  const clear: GoalPageView = {
    ...flagged,
    issue: {
      ...page.issue,
      validation: { state: 'clear', total: 3, passed: 3, failed: 0, unrun: 0, deferred: 0, waived: 0, captured: 0 },
    },
  };
  assert.equal(clear.issue.validation?.state, 'clear');
  assert.equal(goalTabOpening(clear).tab, 'work', 'a settled plan is not a reason to be looking at it');
});

test('reaching an environment opens on shipping', () => {
  const page = bare();
  const shipped: GoalPageView = {
    ...page,
    openPullRequests: [openPr()],
    environments: [
      { environment: 'prod', status: 'reached', landed: 2, total: 2, unplaced: 0, at: null, opens: [], sheet: null },
    ],
  };
  assert.equal(goalTabOpening(shipped).tab, 'shipping');
});

test('a pane with nothing in it carries no badge, because zero is a count', () => {
  const badges = goalTabBadges(bare());
  for (const tab of GOAL_TABS) {
    assert.equal(badges[tab], null, `${tab} counted something on a goal that has nothing`);
  }
});

test('the work badge says what wants a person, then what has landed', () => {
  const page = bare();
  const wants = goalTabBadges({
    ...page,
    openPullRequests: [openPr({ attention: { status: 'you', reasons: ['review'] } })],
  }).work;
  assert.deepEqual(wants, { text: '1 in your court', tone: 'red' });

  const open = goalTabBadges({ ...page, openPullRequests: [openPr()] }).work;
  assert.deepEqual(open, { text: '1 open', tone: 'blue' });
});

test('the shipping badge says the gate before it says the count', () => {
  const page = bare();
  const envs = [
    {
      environment: 'prod',
      status: 'reached' as const,
      landed: 2,
      total: 2,
      unplaced: 0,
      at: null,
      opens: [],
      sheet: null,
    },
  ];
  assert.deepEqual(goalTabBadges({ ...page, environments: envs }).shipping, { text: '1/1', tone: 'green' });
  assert.deepEqual(goalTabBadges({ ...page, environments: envs, gateHold: 'validate' }).shipping, {
    text: 'gate held',
    tone: 'amber',
  });
});
