import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenPullRequest, ValidationCheckView } from '../web/src/types.js';
import type { GoalPageView } from '../web/src/view/goalPage.js';
import {
  buildGoalNav,
  buildGoalPage,
  goalLanding,
  goalTabOpening,
  GOAL_TABS,
  GOAL_TAB_OF,
} from '../web/src/view/goalPage.js';
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

test('a plan, a pull request or an agent moves the landing to the plan', () => {
  const page = bare();
  assert.equal(goalTabOpening({ ...page, openPullRequests: [openPr()] }).tab, 'plan');
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
  assert.equal(goalTabOpening(validating).tab, 'plan', 'the ask in your own court is what moves the goal');
});

test('a held gate beats everything but a finished goal', () => {
  const page = bare();
  const held: GoalPageView = {
    ...page,
    gateHold: 'validate',
    openPullRequests: [openPr({ attention: { status: 'you', reasons: ['review'] } })],
  };
  assert.equal(goalTabOpening(held).tab, 'shipped');

  const finished: GoalPageView = { ...held, issue: { ...held.issue, state: 'closed' } };
  assert.equal(goalTabOpening(finished).tab, 'closeout', 'nothing is left to steer on a shut goal');
});

test('a flagged validation plan opens on validation, a clear one does not', () => {
  const page = bare();
  const flagged: GoalPageView = {
    ...page,
    openPullRequests: [openPr()],
    issue: {
      ...page.issue,
      validation: {
        state: 'flagged',
        total: 3,
        passed: 1,
        failed: 1,
        unrun: 1,
        deferred: 0,
        waived: 0,
        captured: 0,
        declined: 0,
      },
    },
  };
  assert.equal(goalTabOpening(flagged).tab, 'checks');

  const clear: GoalPageView = {
    ...flagged,
    issue: {
      ...page.issue,
      validation: {
        state: 'clear',
        total: 3,
        passed: 3,
        failed: 0,
        unrun: 0,
        deferred: 0,
        waived: 0,
        captured: 0,
        declined: 0,
      },
    },
  };
  assert.equal(clear.issue.validation?.state, 'clear');
  assert.equal(goalTabOpening(clear).tab, 'plan', 'a settled plan is not a reason to be looking at it');
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
  assert.equal(goalTabOpening(shipped).tab, 'shipped');
});

test('every tab reads something, even on a goal that has nothing', () => {
  const nav = buildGoalNav(bare());
  assert.deepEqual(
    nav.map((e) => e.tab),
    [...GOAL_TABS],
    'the row draws every pane in order, whatever the goal has reached',
  );
  /* A tab is a stage as well as a way in, so it always says where the goal is on
     that stage. "no checks" and "not drawn" are readings; a blank tab would be
     the row saying nothing about a stage the goal simply has not reached. */
  for (const entry of nav) {
    assert.ok(entry.reading.length > 0, `${entry.tab} says nothing at all`);
    assert.equal(entry.done, null, `${entry.tab} drew a meter on a goal with nothing to measure`);
    assert.equal(entry.needsYou, false, `${entry.tab} claims an ask on a goal that carries none`);
  }
});

test('the plan tab says what wants a person before it says how far the work got', () => {
  const page = bare();
  const parts = buildGoalNav(page).find((e) => e.tab === 'plan')!;
  assert.equal(parts.reading, 'not drawn');

  /* The reading the tab row used to carry and the track did not. Folding the two
     controls into one is exactly how it would have been lost, so it is asserted
     against the one control that survived. */
  const court = buildGoalNav({
    ...page,
    openPullRequests: [openPr({ attention: { status: 'you', reasons: ['review'] } })],
  }).find((e) => e.tab === 'plan')!;
  assert.equal(court.reading, '1 in your court');
  assert.equal(court.tone, 'amber');
});

test('the shipped tab says the gate before it says the count', () => {
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
  const reached = buildGoalNav({ ...page, environments: envs }).find((e) => e.tab === 'shipped')!;
  assert.equal(reached.reading, 'reached prod');
  assert.equal(reached.tone, 'green');

  const held = buildGoalNav({ ...page, environments: envs, gateHold: 'validate' }).find((e) => e.tab === 'shipped')!;
  assert.equal(held.reading, 'gate held');
  assert.equal(held.tone, 'amber');
});

test('a goal with no environments still draws the shipped tab', () => {
  /* The row keeps its shape between goals: a control that gains and loses a
     column cannot be aimed at from memory. */
  const shipped = buildGoalNav(bare()).find((e) => e.tab === 'shipped')!;
  assert.equal(shipped.reading, 'no environments');
  assert.equal(shipped.done, null, 'nothing reached of nothing is not a proportion');
});

test('the landing is decided on arrival and held, however the goal moves under it', () => {
  const page = bare();
  const reading: GoalPageView = { ...page, openPullRequests: [openPr()] };
  assert.equal(goalTabOpening(reading).tab, 'plan', 'the fixture must land on the plan for this to say anything');

  const landed = goalLanding(null, 'issue:1', reading);
  assert.equal(landed.opening.tab, 'plan');

  /* The goal moves while somebody is reading it: a pull request lands in their court, then the work
     reaches an environment. Both re-answer the rule, and neither is allowed to move the pane —
     that is the whole of "it decides the landing only".
     → docs/spec/17-cockpit.md#which-pane-opens */
  const called: GoalPageView = {
    ...reading,
    openPullRequests: [openPr({ attention: { status: 'you', reasons: [] } })],
  };
  assert.equal(goalLanding(landed, 'issue:1', called).opening.tab, 'plan');

  const shipped: GoalPageView = {
    ...called,
    environments: [
      { environment: 'prod', status: 'reached', landed: 1, total: 1, unplaced: 0, at: null, opens: [], sheet: null },
    ],
  };
  assert.equal(goalTabOpening(shipped).tab, 'plan', 'the court arm outranks the shipped one');
  const still = goalLanding(landed, 'issue:1', shipped);
  assert.equal(still.opening.tab, 'plan');
  assert.equal(still, landed, 'the held landing is returned as it stands, sentence and all');

  /* The next goal is a fresh arrival, and the pick made on this one does not follow the operator to
     it — `goalMove` drops `?pane=` for the same reason. */
  const next = goalLanding(landed, 'issue:2', shipped);
  assert.equal(next.ref, 'issue:2');
  assert.equal(next.opening.tab, goalTabOpening(shipped).tab);
});
