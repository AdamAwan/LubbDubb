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

/**
 * The view model over the demo world, or over a doctored one.
 *
 * Doctoring goes in here rather than onto the finished view, because the readings
 * the fleet row's state is drawn from — `limitParked`, `escalationByAgent`,
 * `stallExpiryByAgent` — are *derived* by `buildViewModel`. A test that replaced
 * `view.state` alone would leave every one of them answering about the world it
 * was built from, and its assertions would be about nothing.
 */
function view(grammar: 'facts' | 'columns', over: Partial<CockpitView['state']> = {}): CockpitView {
  const state = { ...buildDemoState().state, ...over };
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
const ROW = /class="cn-(?:row|drow)[ "]/g;

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
  const rows = (html: string): number => (html.match(ROW) ?? []).length;
  const cards = (html: string): number => html.split('class="cn-card').length - 1;

  const facts = render(view('facts'));
  const columns = render(view('columns'));

  assert.equal(cards(facts), cards(columns));
  assert.equal(rows(facts), rows(columns));
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
  for (const grammar of ['facts', 'columns'] as const) {
    const html = render(view(grammar));
    const rack = html.slice(html.indexOf('Pull requests'), html.indexOf('Up next'));
    const rows = rack.split(ROW).slice(1);
    assert.ok(rows.length > 0, `no pull-request rows rendered under ${grammar}`);
    for (const row of rows) {
      // `cn-refs` in the list grammar, `cn-drefs` in the table: the slot has a
      // different shape in each and the same job in both.
      const at = Math.max(row.indexOf('cn-refs'), row.indexOf('cn-drefs'));
      assert.ok(at > 0, `a pull-request row has no refs slot at all under ${grammar}`);
      const slot = row.slice(at);
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
  for (const grammar of ['facts', 'columns'] as const) {
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

/**
 * The rail is a grid, and every row of a card is on the same one.
 *
 * Pinned because the way this breaks is invisible: the template was set on the
 * row *container* — a flex column, where `grid-template-columns` applies to
 * nothing — and every row went on rendering as the flex line it had always been.
 * Nothing errored, no test failed, and the only symptom was that the slots did
 * not line up, which is what the rail exists for and what a screenshot of a card
 * with two similar rows does not show.
 */
test('every row of a card sits on that card’s own grid', () => {
  const html = render(view('facts'));
  // Per card, because the subject column differs between them: what has to agree
  // is the rows of one card, which is what "always look here" means on a page of
  // five different-shaped cards.
  const cards = html.split('class="cn-card').slice(1);
  let checked = 0;
  for (const card of cards) {
    const templates = card
      .split('class="cn-row cn-frow')
      .slice(1)
      .map((chunk) => /style="grid-template-columns:([^"]+)"/.exec(chunk.slice(0, 400)));
    if (templates.length === 0) continue;
    for (const found of templates) {
      assert.ok(found, 'a facts row carries no grid template — the rail is a flex line again');
      assert.match(found[1] ?? '', /var\(--cn-w-/, 'the rail’s widths come from the sheet, not from a literal here');
    }
    const first = templates[0]?.[1];
    for (const found of templates) {
      assert.equal(found?.[1], first, 'two rows of one card are on different grids');
    }
    checked += 1;
  }
  assert.ok(checked >= 4, `only ${checked} cards drew rows — this test is about the ones that do`);
});

/**
 * The fleet row's state, as a word rather than a marker to hover.
 *
 * Ranked, not merged: the four come from four different facts — an escalation
 * naming the agent, the limit park, the stall park and a plain wait — and an
 * agent can be in more than one at once. A row can wear one word, so which one it
 * is has to be decided somewhere, and this is the decision.
 */
test('a fleet row wears the state it is in, and the strongest one it is in', () => {
  const base = buildDemoState().state;
  const live = base.agents.filter((a) => a.endedAt === null);
  const waiting = live.find((a) => a.status === 'waiting');
  assert.ok(live[0] && waiting, 'the fixtures must carry a live agent and a waiting one');

  const chips = (over: Partial<CockpitView['state']>): string[] => {
    const html = render(view('facts', over));
    const fleet = html.slice(html.indexOf('Fleet'), html.indexOf('Goals in flight'));
    return [...fleet.matchAll(/cn-why-chip cn-t-(\w+)"[^>]*>([^<]+)</g)].map((m) => `${m[2]}:${m[1]}`);
  };

  // The world as it ships: every live agent has an open escalation, which is the
  // top of the ranking and is your move whatever else is true of the row.
  assert.ok(chips({}).includes('question:ask'), 'an agent with an open escalation asks you something');

  const noAsks = { escalations: [] };
  assert.ok(chips({ ...noAsks, parkedOnLimit: [live[0].id] }).includes('limit:hold'), 'a limit park says so');
  assert.ok(
    chips({
      ...noAsks,
      stallParks: [{ agentId: live[0].id, expiresAt: new Date(Date.now() + 9e5).toISOString() }],
    }).includes('stalled:hold'),
    'a stall park says so',
  );
  assert.ok(chips(noAsks).includes('blocked:hold'), 'a plain wait says so');

  // The ranking itself: the waiting agent is *also* parked on the limit, and the
  // row wears the park. Both are true; only one is what to do about it.
  const ranked = chips({ ...noAsks, parkedOnLimit: [waiting.id] });
  assert.ok(ranked.includes('limit:hold'), `the park outranks the wait — got ${ranked.join(', ')}`);
  assert.ok(!ranked.includes('blocked:hold'), 'and the row wears one word, not both');
});

/**
 * The rack's state column is the server's court verdict, quoted.
 *
 * The card drew it twice before — a `?` holding `attention.reasons` and a chip
 * holding the same reasons in a `title`, one column apart — and a second reading
 * of one verdict is how the two come to disagree. What this pins is that there is
 * one: the word in the state column is `attention.status` itself, not a word the
 * cockpit chose for it.
 */
test('a pull-request row wears the court the server put it in', () => {
  const state = buildDemoState().state;
  const html = render(view('facts'));
  const rack = html.slice(html.indexOf('Pull requests'), html.indexOf('Up next'));
  const rows = rack.split(ROW).slice(1);
  assert.equal(rows.length, state.world.pullRequests.length, 'every open pull request is drawn');
  for (const [i, row] of rows.entries()) {
    const pr = state.world.pullRequests[i];
    assert.ok(pr, 'the fixtures line up with the rows');
    assert.ok(
      row.includes(`>${pr.attention.status}</button>`),
      `#${pr.number} should wear "${pr.attention.status}" in its state column`,
    );
    // And the switch that takes it off the harness's books is pinned left of the
    // subject, ahead of the name: the same control in the same place on every
    // row, which is what lets an eye skip it.
    const eye = row.indexOf('cn-eye');
    assert.ok(eye > 0 && eye < row.indexOf('cn-grow'), `#${pr.number} draws no watch switch left of its subject`);
  }
});

/** The grammar is a place, so both readings are a link somebody can send. */
test('the row grammar round-trips through the query string', () => {
  assert.equal(placeQuery(NOWHERE), '', 'the default grammar is a bare URL');
  assert.equal(placeQuery({ ...NOWHERE, panelGrammar: 'columns' }), '?grammar=columns');
  assert.equal(readPlace('?grammar=columns').panelGrammar, 'columns');
  // An unknown value is the default rather than a blank overview — the same rule
  // every other parameter here follows.
  assert.equal(readPlace('?grammar=nonsense').panelGrammar, 'facts');
});
