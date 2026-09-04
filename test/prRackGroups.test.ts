import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { CockpitView } from '../web/src/view/viewModel.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';

// `tsx` compiles JSX with the classic runtime, which emits bare
// `React.createElement`; the console's own modules load after this so they see
// the same global the rest of the cockpit tests install.
(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { Overview } = await import('../web/src/console/Overview.js');
const { RefLinks } = await import('../web/src/components/refs.js');
const { goalIssue } = await import('../web/src/view/goalPage.js');
const { hasPrPage } = await import('../web/src/view/prPage.js');
const { initials } = await import('../web/src/components/who.js');

const actions = new Proxy({}, { get: () => () => undefined }) as CockpitActions;

function view(over: Partial<CockpitView['state']> = {}): CockpitView {
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
      children: createElement(Overview, { view: v, actions }),
    }),
  );

/** The rack alone: a pull request's title is drawn on its goal's row as well. */
const rack = (html: string): string => html.slice(html.indexOf('Pull requests'), html.indexOf('Environments'));

/**
 * The band exists, and the pull requests somebody handed you are above it.
 *
 * The card's question is *is anything waiting on me*, and it used to be answered
 * one row at a time in a column of words — a reading an operator has to take
 * down the whole card before they know the answer is no. What this pins is the
 * order, not the heading's wording: yours are first, so the answer is at the top
 * of the card or it is nowhere.
 */
test('the rack puts the pull requests a person handed you above the fleet’s', () => {
  const state = buildDemoState().state;
  const yours = state.world.pullRequests.filter((pr) => pr.attention.assignedToYou !== undefined);
  assert.ok(yours.length > 0, 'the fixtures must carry a pull request somebody assigned to the operator');

  const card = rack(render(view()));
  const mine = card.indexOf('cn-group cn-group-ask');
  const fleet = card.indexOf('class="cn-group"');
  assert.ok(mine > 0, 'no band for the pull requests that are yours');
  assert.ok(fleet > mine, 'the fleet’s band is drawn above yours');
  for (const pr of yours) {
    const at = card.indexOf(pr.title);
    assert.ok(at > mine && at < fleet, `#${pr.number} is not drawn under the "Assigned to review" band`);
  }
});

/**
 * The mark says who asked, in the tracker's own name for them.
 *
 * `Who` draws initials, and initials are not a name: what makes the mark
 * readable at all is the label behind it, which has to be the person the
 * provider reported and not a word the cockpit chose. A mark labelled anything
 * else is a row claiming an identity nothing on the board has.
 */
test('the mark on an assigned row carries the tracker’s own name for the person', () => {
  const state = buildDemoState().state;
  const assigned = state.world.pullRequests.find((pr) => pr.attention.assignedToYou !== undefined);
  assert.ok(assigned, 'the fixtures must carry an assigned pull request');
  const author = assigned.author;
  assert.ok(author !== undefined && author !== '', 'and the provider must have reported who asked');

  const card = rack(render(view()));
  assert.ok(card.includes(`aria-label="${author}"`), 'the mark does not name the person who asked');
  assert.ok(card.includes(`>${initials(author) ?? ''}</span>`), 'the mark draws no initials');
  // And the fleet's own rows wear the absence of a person rather than a second
  // kind of one — a login repeated down the column tells no two rows apart.
  assert.ok(card.includes('cn-who-none'), 'the fleet’s rows draw no mark at all');
});

/**
 * With nothing assigned, the card is the card it was.
 *
 * A single band over every row separates nothing, and the column beside it is
 * then the same hollow mark on every row — two pieces of furniture that say
 * there is no news, drawn at the weight of news. The grouping appears exactly
 * when it has something to separate.
 */
test('the rack draws no band and no marks when nothing is yours', () => {
  const state = buildDemoState().state;
  const world = {
    ...state.world,
    pullRequests: state.world.pullRequests.map((pr) => ({
      ...pr,
      attention: { ...pr.attention, assignedToYou: undefined },
    })),
  };
  const card = rack(render(view({ world })));
  assert.ok(!card.includes('cn-group'), 'a band was drawn with nothing to separate');
  assert.ok(!card.includes('cn-who'), 'a column of who-asked marks was drawn with nobody in it');
  assert.ok(card.includes('cn-row cn-frow'), 'and the rows themselves are still drawn');
});

/**
 * The three shapes a provider calls a person by, all off the same field.
 *
 * A GitHub login is one word, an Azure display name is two, and an Azure unique
 * name is an address — so a rule written for any one of them draws a domain, half
 * a surname, or nothing at all on the other two.
 */
test('initials read a login, a display name and an address', () => {
  assert.equal(initials('adamawan'), 'AD', 'a one-word login gives up two letters, not one');
  assert.equal(initials('Priya Raman'), 'PR');
  assert.equal(initials('priya.raman@corp.example'), 'PR', 'the domain is not part of the name');
  assert.equal(initials('  jo  '), 'JO');
  assert.equal(initials('Ada Byron King'), 'AK', 'the first and the last, never the middle');
  assert.equal(initials('a-b_c'), 'AC');
  assert.equal(initials(''), null);
  assert.equal(initials('   '), null);
  assert.equal(initials('@@'), null, 'a name with no letter in it draws no mark rather than an empty one');
});
