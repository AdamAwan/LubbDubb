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

// `tsx` compiles JSX with the classic runtime, which emits bare
// `React.createElement`; the bundle uses the automatic one. The global goes in
// before the console's modules load so the test exercises the same sources.
(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { ConsoleRoot } = await import('../web/src/console/ConsoleRoot.js');
const { RefLinks } = await import('../web/src/components/refs.js');
const { goalIssue } = await import('../web/src/view/goalPage.js');
const { hasPrPage } = await import('../web/src/view/prPage.js');

const actions = new Proxy({}, { get: () => () => undefined }) as CockpitActions;

/**
 * A goal with no parent Feature is the whole subject, so the fixtures — which
 * ship a flat world with the board off — have to be told two things: the
 * deployment has a feature board, and this item hangs off nothing.
 *
 * `parent` is set to `null` explicitly and never left absent. The two readings
 * are the point of the predicate, and a fixture that relied on the field being
 * missing would assert the opposite of what it looked like it asserted.
 */
function stateWith(mutate: (state: AppState, goal: Issue) => void = () => {}): AppState {
  const state = buildDemoState().state as AppState;
  // `canPlaceWorkItem` and **not** `featureBoard`: the warning is gated on the
  // tracker being able to take the write, never on the operator having asked for a
  // Features tab. The fixtures leave the tab off, which is deliberate — that pair
  // is the deployment the band used to be silent on (issue #683).
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

/**
 * `selectedGoal` goes *into* the builder rather than over its result: the page is
 * `buildGoalPage`'s answer to that ref, and setting the field on the outside
 * leaves `goalPage` null and renders the overview — a test that would have passed
 * for the wrong reason on every assertion about a card.
 */
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

/** The console as the shell mounts it — a `<Ref>` outside `RefLinks` throws. */
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

/** `renderToStaticMarkup` escapes text nodes, so an assertion on prose decodes first. */
function decode(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * The three states of `Issue.parent`, which is the whole of the predicate and the
 * one place it can go silently wrong in either direction.
 *
 * `undefined` is the dangerous one. It means the provider tracks no hierarchy at
 * all — GitHub, every deployment — and a reader that tested `!issue.parent` would
 * put an amber band on every goal of every one of them, which is the failure that
 * types and lint cannot see.
 */
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

/**
 * The other half of the gate, and the only half that ever carried an argument:
 * where the tracker cannot be handed a parent, the warning is a dead end and is
 * drawn nowhere.
 */
test('the warning is silent where nothing can write a parent', () => {
  const state = stateWith();
  state.config = { ...state.config, canPlaceWorkItem: false };
  assert.equal(orphanGoal(state, firstGoal(state)), null);
});

/**
 * The regression this separation exists for (issue #683). `featureBoard` is that
 * same probe **and** the operator's own flag, and the flag is about wanting the
 * tier above one's stories drawn as a *tab*. Gated on it, a real Azure board with
 * Features and Epics in it and six goals rolling up to nothing said nothing at
 * all, because nobody had asked for the tab — and the rail does not cover the gap,
 * since its row rides inside `issue.appraisal`.
 *
 * So the fixture pair here is the one that used to be silent and must not be: the
 * tab off, the tracker able to take the write.
 */
test('the warning does not need the operator to have asked for a Features tab', () => {
  const state = stateWith();
  state.config = { ...state.config, featureBoard: false, canPlaceWorkItem: true };
  assert.notEqual(orphanGoal(state, firstGoal(state)), null);
});

/**
 * The two readings the band draws differently. Both are orphans and neither rolls
 * up — what separates them is whether anybody has ruled on it, and the stamp is
 * the only thing that says so.
 */
test('an unanswered orphan and a settled one are different readings', () => {
  const open = stateWith((_s, goal) => {
    goal.appraisal = {
      verdict: 'workable',
      summary: 'Two subsystems.',
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
      by: 'appraiser',
      decidedAt: '2026-01-01T00:00:00.000Z',
      commentRef: null,
      proposedProfile: null,
      awaitingProfileAnswer: false,
      // Answering it closes the ask, which is why the proposal is gone from
      // `placement` and the stamp is the only trace left of the decision.
      placement: [],
      parentSettledAt: '2026-01-03T00:00:00.000Z',
    };
  });
  assert.deepEqual(orphanGoal(settled, firstGoal(settled)), {
    proposed: null,
    settledAt: '2026-01-03T00:00:00.000Z',
  });
});

/**
 * A goal nothing has appraised is an orphan all the same — the case the needs
 * rail's `placement` row is silent about, and most of why this exists.
 */
test('an orphan nobody appraised still warns, with nothing to offer', () => {
  const state = stateWith((_s, goal) => {
    goal.appraisal = null;
  });
  assert.deepEqual(orphanGoal(state, firstGoal(state)), { proposed: null, settledAt: null });
});

/**
 * The header count and the rows it counts are one predicate. A header that
 * filtered differently from its own list is the failure worth pinning: both look
 * right on their own, and they disagree only where it matters.
 */
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

/**
 * The band is drawn on the goal page, above every card on it.
 *
 * Asserted on the rendered page rather than on the component, for the reason the
 * record test is: `OrphanBand` renders identically wherever it is mounted, and
 * the defect worth catching is it quietly ceasing to be mounted here — which
 * types, lint and a component test would all go on passing through.
 */
test('a goal page states in words that the goal hangs off no Feature', () => {
  const state = stateWith();
  const goal = firstGoal(state);
  const html = decode(render(view(state, `issue:${goal.number}`)));

  assert.ok(html.includes('No parent Feature'), 'the page must name the gap');
  assert.ok(html.includes('it is on no team’s board'), 'and say what it costs, not only that it is true');
  assert.ok(html.includes('Not applicable'), 'and offer the answer that ends it');
});

/**
 * Answered, it goes quiet rather than away: the item is still an orphan and the
 * board still cannot roll it up, so the reading stands — it has just stopped
 * being an ask.
 */
test('an answered orphan keeps a quiet note and a way back', () => {
  const state = stateWith((_s, goal) => {
    goal.appraisal = {
      verdict: 'workable',
      summary: 'Two subsystems.',
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

/**
 * A goal in flight carries the warning on its row too, so the gap is visible
 * before anybody opens anything — which is the point: an operator who already
 * decided to open this goal did not need telling.
 */
test('goals in flight name the ones missing a Feature', () => {
  const state = stateWith((s, goal) => {
    goal.pickup = { ...goal.pickup, status: 'active' };
    // A second in-flight goal that *has* a parent, so the count is a filter and
    // not the length of the list.
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
