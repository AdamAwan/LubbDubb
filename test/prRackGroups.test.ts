import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { CockpitView } from '../web/src/view/viewModel.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';

(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { Overview } = await import('../web/src/console/Overview.js');
const { RefLinks } = await import('../web/src/components/refs.js');
const { goalIssue } = await import('../web/src/view/goalRefs.js');
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

const rack = (html: string): string => html.slice(html.indexOf('Pull requests'), html.indexOf('Environments'));

test('the rack puts the pull requests a person handed you above the fleet’s', () => {
  const state = buildDemoState().state;
  const yours = state.world.pullRequests.filter((pr) => pr.attention.assignedToYou !== undefined);
  assert.ok(yours.length > 0, 'the fixtures must carry a pull request somebody assigned to the operator');

  const card = rack(render(view()));
  const mine = card.indexOf('cn-group cn-group-ask');
  const rest = card.indexOf('Assigned, not waiting on you');
  assert.ok(mine > 0, 'no band for the pull requests that are waiting on you');
  assert.ok(rest > mine, 'a band the operator has answered is drawn above one they have not');
  for (const pr of yours) {
    const at = card.indexOf(pr.title);
    assert.ok(at > mine && at < rest, `#${pr.number} is not drawn under the "Assigned to review" band`);
  }
});

test('the mark on an assigned row carries the tracker’s own name for the person', () => {
  const state = buildDemoState().state;
  const assigned = state.world.pullRequests.find((pr) => pr.attention.assignedToYou !== undefined);
  assert.ok(assigned, 'the fixtures must carry an assigned pull request');
  const author = assigned.author;
  assert.ok(author !== undefined && author !== '', 'and the provider must have reported who asked');

  const card = rack(render(view()));
  assert.ok(card.includes(`aria-label="${author}"`), 'the mark does not name the person who asked');
  assert.ok(card.includes(`>${initials(author) ?? ''}</span>`), 'the mark draws no initials');
  assert.ok(card.includes('cn-who-none'), 'the fleet’s rows draw no mark at all');
});

test('an assignment the operator has answered keeps its band and its mark', () => {
  const state = buildDemoState().state;
  // What the provider reports once the operator votes: the assignment stands, the court does not.
  const world = {
    ...state.world,
    pullRequests: state.world.pullRequests.map((pr) =>
      pr.viewerAssignment === undefined
        ? pr
        : { ...pr, viewerApproved: true, attention: { ...pr.attention, assignedToYou: undefined } },
    ),
  };
  const answered = world.pullRequests.filter((pr) => pr.viewerAssignment !== undefined);
  assert.ok(answered.length > 0, 'the fixtures must carry an assigned pull request');

  const card = rack(render(view({ world })));
  assert.ok(!card.includes('cn-group-ask'), 'an answered request still wears the ask red');
  const band = card.indexOf('Assigned, not waiting on you');
  const fleet = card.indexOf('The fleet');
  assert.ok(band > 0, 'the band went with the court');
  assert.ok(fleet > band, 'the fleet’s band is drawn above the assigned one');
  for (const pr of answered) {
    const author = pr.author;
    assert.ok(author !== undefined && author !== '', 'and the provider must have reported who asked');
    assert.ok(card.includes(`aria-label="${author}"`), `#${pr.number} lost the name of the person who asked`);
    const at = card.indexOf(pr.title);
    assert.ok(at > band && at < fleet, `#${pr.number} is not drawn under the assigned band`);
  }
});

test('the rack draws no band and no marks when nothing is anybody else’s', () => {
  const state = buildDemoState().state;
  const world = {
    ...state.world,
    pullRequests: state.world.pullRequests.map((pr) => ({
      ...pr,
      viewerAssignment: undefined,
      viewerAuthored: undefined,
      attention: { ...pr.attention, assignedToYou: undefined },
    })),
  };
  const card = rack(render(view({ world })));
  assert.ok(!card.includes('cn-group'), 'a band was drawn with nothing to separate');
  assert.ok(!card.includes('cn-who'), 'a column of who-asked marks was drawn with nobody in it');
  assert.ok(card.includes('cn-row cn-frow'), 'and the rows themselves are still drawn');
});

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
