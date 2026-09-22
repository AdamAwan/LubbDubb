import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GoalEnvironmentReachView, OpenPullRequest, ValidationCheckView } from '../web/src/types.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';
import type { GoalPageView, GoalTab } from '../web/src/view/goalPage.js';
import {
  buildGoalNav,
  buildGoalPage,
  buildGoalReachMatrix,
  goalLanding,
  goalTabOpening,
  GOAL_TABS,
  GOAL_TAB_OF,
  GOAL_ASK_TAB,
} from '../web/src/view/goalPage.js';
import { openGoalForAsk } from '../web/src/console/jump.js';
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

test('the demo deployment’s tabs are its own environments’ obligations', () => {
  /* The row is derived from the environment list, and the fixtures declare the shape that
     exercises it: staging carries the checks, the close-out and the watch; prod carries the
     close-out too, so that tab draws a picker; preview opens nothing.
     → docs/spec/17-cockpit.md#the-panes */
  const nav = buildGoalNav(bare());
  assert.deepEqual(
    nav.map((e) => [e.tab, e.on]),
    [
      ['ask', []],
      ['plan', []],
      ['validate', ['staging']],
      ['close', ['staging', 'prod']],
      ['watch', ['staging']],
    ],
  );
});

test('a goal nobody has planned opens on the ask', () => {
  const page = bare();
  assert.equal(goalTabOpening(page).tab, 'ask');
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
  assert.equal(goalTabOpening(held).tab, 'close', 'the hold is what the close-out is waiting on');

  const finished: GoalPageView = { ...held, issue: { ...held.issue, state: 'closed' } };
  assert.equal(goalTabOpening(finished).tab, 'close', 'nothing is left to steer on a shut goal');
});

test('a flagged validation plan opens on the checks, a clear one does not', () => {
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
  assert.equal(goalTabOpening(flagged).tab, 'validate');

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

test('reaching an environment opens on the close-out it is owed against', () => {
  const page = bare();
  const shipped: GoalPageView = {
    ...page,
    openPullRequests: [openPr()],
    environments: [
      { environment: 'prod', status: 'reached', landed: 2, total: 2, unplaced: 0, at: null, opens: [], sheet: null },
    ],
  };
  assert.equal(goalTabOpening(shipped).tab, 'close');
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

test('the close tab says the gate before it says the count', () => {
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
  const reached = buildGoalNav({ ...page, environments: envs }).find((e) => e.tab === 'close')!;
  assert.equal(reached.reading, 'reached prod');
  assert.equal(reached.tone, 'green');

  const held = buildGoalNav({ ...page, environments: envs, gateHold: 'validate' }).find((e) => e.tab === 'close')!;
  assert.equal(held.reading, 'gate held');
  assert.equal(held.tone, 'amber');
});

test('a goal with no environments still draws the close tab', () => {
  /* Validation and the close-out are owed on every deployment; only the environment that
     carries them is configuration. A row that gained and lost a column between two goals
     could not be aimed at from memory. */
  const close = buildGoalNav(bare()).find((e) => e.tab === 'close')!;
  assert.equal(close.reading, 'not reached');
  assert.equal(close.done, null, 'nothing reached of nothing is not a proportion');
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

// ── The Shipped stage, and the matrix behind it ──
// → docs/spec/24-environments.md

function env(over: Partial<GoalEnvironmentReachView> & { environment: string }): GoalEnvironmentReachView {
  return { status: 'absent', landed: 0, total: 0, unplaced: 0, at: null, opens: [], sheet: null, ...over };
}

function shipped(page: GoalPageView): { reading: string; done: number | null } {
  const entry = buildGoalNav(page).find((e) => e.tab === 'close')!;
  return { reading: entry.reading, done: entry.done };
}

test('a goal short of an environment reads what is owed, and draws no meter', () => {
  const page = bare();
  const partial: GoalPageView = {
    ...page,
    environments: [env({ environment: 'staging', status: 'partial', landed: 2, total: 5 })],
  };
  assert.deepEqual(shipped(partial), { reading: '3 landings owed', done: null });
});

/* `total` is landings + unattributed merges + the code parts still owed, so decomposing a plan
   further grows the denominator. A meter against it runs backwards, and worse, it reports a
   goal as part-way *checked* when nothing about it has been checked at all. */
test('the Close meter is drawn only against the environments, which cannot grow with the plan', () => {
  const page = bare();
  const reached: GoalPageView = {
    ...page,
    environments: [
      env({ environment: 'staging', status: 'reached', landed: 5, total: 5, at: '2026-01-01T00:00:00.000Z' }),
      env({ environment: 'prod', status: 'partial', landed: 3, total: 5 }),
    ],
  };
  assert.equal(shipped(reached).done, 50, 'one of the two environments holds every landing');
});

test('a landing on no integration branch is not reported as a goal that can never be checked', () => {
  const page = bare();
  /* `goalReach` drops it from `total` before counting, so it holds nothing short. Read as a
     blocker the tab would announce a dead end the harness has already stepped around.
     → docs/spec/24-environments.md#what-counts-as-a-landing */
  const stranded: GoalPageView = {
    ...page,
    environments: [env({ environment: 'staging', status: 'reached', landed: 1, total: 1, unplaced: 1 })],
    landings: [{ prNumber: 9, sha: 'dead', reach: {}, unplaced: true }],
  };
  assert.match(shipped(stranded).reading, /^reached staging/);
  assert.equal(goalTabOpening(stranded).tab, 'close');
});

test('the matrix gives a row to every part, and to every merge no part claims', () => {
  const state = buildDemoState().state;
  const page = buildGoalPage(state, 'issue:390', [])!;
  const matrix = buildGoalReachMatrix(page);
  assert.deepEqual(matrix.environments, ['staging', 'prod']);

  const claimless = matrix.rows.filter((r) => r.kind === 'unattributed');
  assert.equal(claimless.length, 1, 'a merge counted into total with no row is a number nobody can account for');
  assert.equal(claimless[0]?.prNumber, 397);

  const parts = matrix.rows.filter((r) => r.kind === 'part');
  assert.equal(parts.length, page.parts.length, 'every part is drawn, including ones nobody has written');
});

test('a part with no landing reads pending, which is not the same as absent', () => {
  const state = buildDemoState().state;
  const matrix = buildGoalReachMatrix(buildGoalPage(state, 'issue:390', [])!);
  const landed = matrix.rows.find((r) => r.prNumber === 406)!;
  const unwritten = matrix.rows.find((r) => r.prNumber === null)!;
  assert.deepEqual(landed.cells, ['reached', 'reached']);
  assert.deepEqual(unwritten.cells, ['pending', 'pending'], 'nobody asked, so nothing may be said');
});

test('an unplaced landing marks its row and reads unplaced in every environment', () => {
  const state = buildDemoState().state;
  const matrix = buildGoalReachMatrix(buildGoalPage(state, 'issue:376', [])!);
  const row = matrix.rows.find((r) => r.unplaced)!;
  assert.ok(row, 'the stranded landing has a row of its own');
  assert.deepEqual(row.cells, ['unplaced', 'unplaced']);
});

test('a goal that has landed nothing does not read as one that has arrived', () => {
  /* `owed` is a fraction of `total`, and a goal with nothing placed has a total of nothing — so
     `owed === 0` is true both for a goal every landing of which has arrived and for one that has
     never reached anywhere. Told apart by `arrived` alone, which asks the rollup directly. */
  const state = buildDemoState().state;
  const matrix = buildGoalReachMatrix(buildGoalPage(state, 'issue:376', [])!);
  assert.equal(matrix.owed, 0);
  assert.equal(matrix.arrived, false, 'nothing has reached an environment, so no sheet exists to read');
});

test('an ask opens the goal on the pane it is answered in, not where the lifecycle rule points', () => {
  const moves: { ref: string; pane: GoalTab | null }[] = [];
  const actions = {
    selectGoal: (ref: string | null) => moves.push({ ref: ref ?? '', pane: null }),
    openGoalPane: (ref: string, pane: GoalTab) => moves.push({ ref, pane }),
  } as unknown as CockpitActions;

  /* The goal this ask is about is one whose landing rule answers Validate, which is what the
     pane has to beat: `selectGoal` alone would land the operator on the checks. */
  assert.equal(goalTabOpening(buildGoalPage(buildDemoState().state, 'issue:395', [])!).tab, 'validate');

  openGoalForAsk(actions, 'issue:395', 'describe');
  assert.deepEqual(moves, [{ ref: 'issue:395', pane: 'plan' }], 'a description is written in the plan pane');

  moves.length = 0;
  openGoalForAsk(actions, 'issue:395', 'limit');
  assert.deepEqual(moves, [{ ref: 'issue:395', pane: null }], 'an ask about the fleet leaves the landing to the rule');
});

test('a describe ask carries its part, so the press lands on the form and not near it', () => {
  const parts: (string | null)[] = [];
  const panes: string[] = [];
  /* The press scrolls the plan card into view, which is two animation frames the test
     runtime has none of. Stubbed rather than avoided: the scroll is part of what the
     press does, and a test that dodged it would be asserting a different function. */
  const frames: (() => void)[] = [];
  globalThis.requestAnimationFrame = ((fn: () => void) => {
    frames.push(fn);
    return frames.length;
  }) as typeof requestAnimationFrame;
  const actions = {
    selectGoal: () => {},
    openGoalPane: (_ref: string, pane: GoalTab) => panes.push(pane),
    openGoalPart: (slug: string | null) => parts.push(slug),
  } as unknown as CockpitActions;

  /* The form is drawn only for the chosen part, so a press that moved the pane alone left the
     operator on a board with nothing chosen — the ask named the gap and pointed at no way to
     close it. → docs/spec/17-cockpit.md#which-pane-opens */
  openGoalForAsk(actions, 'issue:395', 'describe', 'issue:395:part:header');
  assert.deepEqual(panes, ['plan']);
  assert.deepEqual(parts, ['header'], 'the part the ask is about is the one the panel opens for');

  parts.length = 0;
  openGoalForAsk(actions, 'issue:395', 'merge', 'issue:395:part:header');
  assert.deepEqual(parts, [], 'the board owns the pick, and an ask about something else must not move it');

  openGoalForAsk(actions, 'issue:395', 'describe', 'issue:395');
  assert.deepEqual(parts, [], 'an origin naming no part chooses none rather than an empty slug');
});

test('every ask kind the rail draws is placed on a pane or deliberately on none', () => {
  for (const [kind, pane] of Object.entries(GOAL_ASK_TAB)) {
    assert.ok(pane === null || GOAL_TABS.includes(pane), `${kind} names a pane the page draws`);
  }
});
