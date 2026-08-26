import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { CockpitView } from '../web/src/view/viewModel.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';
import { NOWHERE, placeQuery, readPlace } from '../web/src/cockpit/place.js';

// `tsx` compiles JSX with the classic runtime, which emits bare
// `React.createElement`; the console's own modules are loaded after this so they
// see the same global the rest of the cockpit tests install.
(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { Overview } = await import('../web/src/console/Overview.js');
const { RefLinks } = await import('../web/src/components/refs.js');
const { goalIssue } = await import('../web/src/view/goalPage.js');

function view(grammar: 'facts' | 'claim'): CockpitView {
  const state = buildDemoState().state;
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
    selectedGoal: null,
    consolePanel: null,
    tab: 'overview',
    panelGrammar: grammar,
  });
}

const actions = new Proxy({}, { get: () => () => undefined }) as CockpitActions;

/**
 * Where a row starts in the markup. The trailing boundary matters: the list a
 * card puts its rows in is `cn-rows`, so a bare `cn-row` counts the container as
 * a row and hands the first assertion a chunk with no refs slot in it.
 */
const ROW = /class="cn-row[ "]/;

/** The overview as the shell mounts it — references resolve against `RefLinks` or `<Ref>` throws. */
const render = (v: CockpitView): string =>
  renderToStaticMarkup(
    createElement(RefLinks, {
      refUrls: v.state.refUrls,
      openGoal: () => undefined,
      hasGoal: (ref: string) => goalIssue(v.state, ref) !== undefined,
      children: createElement(Overview, { view: v, actions }),
    }),
  );

/**
 * The two grammars are two readings of one model, so neither may drop a row.
 *
 * The failure this pins is the one a screenshot hides: a card that renders under
 * one grammar and silently short-lists under the other reads as a quiet fleet
 * rather than as a bug, on whichever grammar nobody was looking at.
 */
test('both grammars draw the same cards and the same rows', () => {
  const rows = (html: string): number => html.split(ROW).length - 1;
  const cards = (html: string): number => html.split('class="cn-card').length - 1;

  const facts = render(view('facts'));
  const claim = render(view('claim'));

  assert.equal(cards(facts), cards(claim));
  assert.equal(rows(facts), rows(claim));
  assert.ok(rows(facts) > 10, 'the fixtures carry rows on every card — this test is about them');
});

/**
 * The rule the model exists to enforce, checked from the sharp end.
 *
 * A pull request row names a pull request, so it offers a way to one: before the
 * model that was a convention each card kept or forgot, and the row that forgot
 * it read exactly like the rows that did not.
 */
test('every pull-request row carries a way to the pull request it names', () => {
  for (const grammar of ['facts', 'claim'] as const) {
    const html = render(view(grammar));
    const rack = html.slice(html.indexOf('Pull requests'), html.indexOf('Up next'));
    const rows = rack.split(ROW).slice(1);
    assert.ok(rows.length > 0, `no pull-request rows rendered under ${grammar}`);
    for (const row of rows) {
      const slot = row.slice(row.indexOf('cn-refs'));
      // The number, not the token: `<Ref>` draws a reference the provider could
      // not resolve as plain text on purpose, and the demo's fake provider
      // resolves only some of them. What the row owes is the reference in the
      // slot every card keeps them in — whether it became a link is the
      // provider's answer and not this rule's.
      assert.match(slot, /#\d+/, `a pull-request row's refs slot is empty under ${grammar}`);
    }
  }
});

/**
 * The marker holds a sentence and nothing else.
 *
 * A reason naming `#412` is prose about a pull request, not a way to one — the
 * way there is the row's own refs slot. A ref rendered inside the bubble would be
 * a destination that only exists while a tooltip is open, which is a link nobody
 * can click and a keyboard user cannot reach at all.
 */
test('the why marker holds prose, never a reference and never a control', () => {
  for (const grammar of ['facts', 'claim'] as const) {
    const html = render(view(grammar));
    const tips = html
      .split('class="cn-why-tip"')
      .slice(1)
      .map((part) => part.slice(0, part.indexOf('</span>')));
    assert.ok(tips.length > 0, `no reason was drawn at all under ${grammar}`);
    for (const tip of tips) {
      assert.ok(!tip.includes('<a '), 'a reason must not carry a link');
      assert.ok(!tip.includes('<button'), 'a reason must not carry a control');
    }
  }
});

/** The grammar is a place, so both readings are a link somebody can send. */
test('the row grammar round-trips through the query string', () => {
  assert.equal(placeQuery(NOWHERE), '', 'the default grammar is a bare URL');
  assert.equal(placeQuery({ ...NOWHERE, panelGrammar: 'claim' }), '?grammar=claim');
  assert.equal(readPlace('?grammar=claim').panelGrammar, 'claim');
  // An unknown value is the default rather than a blank overview — the same rule
  // every other parameter here follows.
  assert.equal(readPlace('?grammar=nonsense').panelGrammar, 'facts');
});
