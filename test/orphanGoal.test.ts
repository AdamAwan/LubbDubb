import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { CockpitView } from '../web/src/view/viewModel.js';
import type { AppState, Issue } from '../web/src/types.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';
import { orphanCount, orphanGoal } from '../web/src/view/orphanGoal.js';

(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { ConsoleRoot } = await import('../web/src/console/ConsoleRoot.js');
const { RefLinks } = await import('../web/src/components/refs.js');
const { goalIssue } = await import('../web/src/view/goalPage.js');
const { hasPrPage } = await import('../web/src/view/prPage.js');

const actions = new Proxy({}, { get: () => () => undefined }) as CockpitActions;

function stateWith(mutate: (state: AppState, goal: Issue) => void = () => {}): AppState {
  const state = buildDemoState().state as AppState;
  state.config = { ...state.config, canPlaceWorkItem: true };
  const goal = state.world.issues[0];
  assert.ok(goal, 'the demo fixtures must carry at least one issue');
  goal.parent = null;
  mutate(state, goal);
  return state;
}

function firstGoal(state: AppState): Issue {
  const goal = state.world.issues[0];
  assert.ok(goal, 'the demo fixtures must carry at least one issue');
  return goal;
}

function view(state: AppState, selectedGoal: string | null = null): CockpitView {
  return buildViewModel({
    state,
    now: Date.now(),
    connected: true,
    demo: true,
    setup: null,
    selected: null,
    liveOutput: new Map(),
    tails: new Map(),
    lastPulseAt: Date.now(),
    viewingPlan: null,
    viewingRetro: null,
    hatching: null,
    viewingScratchpad: null,
    insightsView: 'economics',
    insightsWindow: '7d',
    selectedGoal,
    consolePanel: null,
    tab: 'overview',
  });
}

const render = (v: CockpitView): string =>
  renderToStaticMarkup(
    createElement(RefLinks, {
      refUrls: v.state.refUrls,
      openGoal: () => undefined,
      hasGoal: (ref: string) => goalIssue(v.state, ref) !== undefined,
      openPr: () => undefined,
      hasPr: (n: number) => hasPrPage(v.state, n),
      children: createElement(ConsoleRoot, { view: v, actions }),
    }),
  );

function decode(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

test('only a tracker that reports an orphan is an orphan', () => {
  const state = stateWith();
  const goal = firstGoal(state);

  assert.notEqual(orphanGoal(state, goal), null, 'a null parent is the tracker saying this hangs off nothing');

  goal.parent = undefined;
  assert.equal(orphanGoal(state, goal), null, 'a provider with no hierarchy has nothing to be missing');

  goal.parent = {
    number: 12,
    title: 'Mirror resilience',
    issueType: 'Feature',
    workItemState: 'Active',
    state: 'open',
  };
  assert.equal(orphanGoal(state, goal), null, 'a goal with a parent is not the subject');
});

test('the warning is silent where nothing can write a parent', () => {
  const state = stateWith();
  state.config = { ...state.config, canPlaceWorkItem: false };
  assert.equal(orphanGoal(state, firstGoal(state)), null);
});

test('the warning does not need the operator to have asked for a Features tab', () => {
  const state = stateWith();
  state.config = { ...state.config, featureBoard: false, canPlaceWorkItem: true };
  assert.notEqual(orphanGoal(state, firstGoal(state)), null);
});

test('an unanswered orphan and a settled one are different readings', () => {
  const open = stateWith((_s, goal) => {
    goal.appraisal = {
      verdict: 'workable',
      summary: 'Two subsystems.',
      missing: [],
      by: 'appraiser',
      decidedAt: '2026-01-01T00:00:00.000Z',
      commentRef: null,
      proposedProfile: null,
      awaitingProfileAnswer: false,
      placement: [{ field: 'parent', proposedParent: 1204, proposedAreaPath: null }],
      parentSettledAt: null,
    };
  });
  assert.deepEqual(orphanGoal(open, firstGoal(open)), { proposed: 1204, settledAt: null });

  const settled = stateWith((_s, goal) => {
    goal.appraisal = {
      verdict: 'workable',
      summary: 'Two subsystems.',
      missing: [],
      by: 'appraiser',
      decidedAt: '2026-01-01T00:00:00.000Z',
      commentRef: null,
      proposedProfile: null,
      awaitingProfileAnswer: false,
      placement: [],
      parentSettledAt: '2026-01-03T00:00:00.000Z',
    };
  });
  assert.deepEqual(orphanGoal(settled, firstGoal(settled)), {
    proposed: null,
    settledAt: '2026-01-03T00:00:00.000Z',
  });
});

test('an orphan nobody appraised still warns, with nothing to offer', () => {
  const state = stateWith((_s, goal) => {
    goal.appraisal = null;
  });
  assert.deepEqual(orphanGoal(state, firstGoal(state)), { proposed: null, settledAt: null });
});

test('the count is a fold of the same predicate', () => {
  const state = stateWith();
  const issues = state.world.issues;
  assert.equal(
    orphanCount(state, issues),
    issues.filter((i) => orphanGoal(state, i) !== null).length,
    'the count must be the rows',
  );

  state.config = { ...state.config, canPlaceWorkItem: false };
  assert.equal(orphanCount(state, issues), 0, 'and zero wherever the predicate is silent');
});

test('a goal page states in words that the goal hangs off no Feature', () => {
  const state = stateWith();
  const goal = firstGoal(state);
  const html = decode(render(view(state, `issue:${goal.number}`)));

  assert.ok(html.includes('No parent Feature'), 'the page must name the gap');
  assert.ok(html.includes('it is on no team’s board'), 'and say what it costs, not only that it is true');
  assert.ok(html.includes('Not applicable'), 'and offer the answer that ends it');
});

test('an answered orphan keeps a quiet note and a way back', () => {
  const state = stateWith((_s, goal) => {
    goal.appraisal = {
      verdict: 'workable',
      summary: 'Two subsystems.',
      missing: [],
      by: 'appraiser',
      decidedAt: '2026-01-01T00:00:00.000Z',
      commentRef: null,
      proposedProfile: null,
      awaitingProfileAnswer: false,
      placement: [],
      parentSettledAt: '2026-01-03T00:00:00.000Z',
    };
  });
  const goal = firstGoal(state);
  const html = decode(render(view(state, `issue:${goal.number}`)));

  assert.ok(html.includes('you said this goal wants none'), 'the page must say the decision was made');
  assert.ok(html.includes('cn-orphan-quiet'), 'and draw it in the answered weight');
  assert.ok(html.includes('It still rolls up to nothing'), 'while still stating what is true of the item');
});

test('goals in flight name the ones missing a Feature', () => {
  const state = stateWith((s, goal) => {
    goal.pickup = { ...goal.pickup, status: 'active' };
    const other = s.world.issues[1];
    assert.ok(other, 'the fixtures must carry a second issue');
    other.pickup = { ...other.pickup, status: 'active' };
    other.parent = {
      number: 1204,
      title: 'Mirror resilience',
      issueType: 'Feature',
      workItemState: 'Active',
      state: 'open',
    };
  });
  const html = decode(render(view(state)));

  assert.ok(html.includes('1 with no Feature'), 'the card header must count them');
  assert.ok(html.includes('no Feature'), 'and the row must wear the word');
  assert.ok(html.includes('cn-row-orphan'), 'and the tint that makes it stop the eye');
});
