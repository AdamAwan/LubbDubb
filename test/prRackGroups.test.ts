import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { prHeadline } from '../web/src/view/prHeadline.js';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { CockpitView } from '../web/src/view/viewModel.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';

(globalThis as { React?: typeof React }).React = React;

const { buildFixtureState } = await import('./support/cockpitFixtures.js');
const { Overview } = await import('../web/src/console/Overview.js');
const { RefLinks } = await import('../web/src/components/refs.js');
const { goalIssue, goalOfPr } = await import('../web/src/view/goalRefs.js');
const { hasPrPage } = await import('../web/src/view/prPage.js');
const { initials } = await import('../web/src/components/who.js');
const { rackByGoal } = await import('../web/src/view/prRack.js');

const actions = new Proxy({}, { get: () => () => undefined }) as CockpitActions;

function view(over: Partial<CockpitView['state']> = {}): CockpitView {
  const state = { ...buildFixtureState(), ...over };
  return buildViewModel({
    state,
    now: Date.now(),
    connected: true,
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
  const state = buildFixtureState();
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
  const state = buildFixtureState();
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
  const state = buildFixtureState();
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
  const fleet = card.indexOf('cn-group cn-group-title');
  assert.ok(band > 0, 'the band went with the court');
  assert.ok(fleet > band, 'the fleet’s goals are drawn above the assigned band');
  for (const pr of answered) {
    const author = pr.author;
    assert.ok(author !== undefined && author !== '', 'and the provider must have reported who asked');
    assert.ok(card.includes(`aria-label="${author}"`), `#${pr.number} lost the name of the person who asked`);
    const at = card.indexOf(pr.title);
    assert.ok(at > band && at < fleet, `#${pr.number} is not drawn under the assigned band`);
  }
});

test('the rack draws no assignment band and no marks when nothing is anybody else’s', () => {
  const state = buildFixtureState();
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
  assert.ok(!card.includes('cn-group-ask'), 'an ask band was drawn with nothing in it');
  assert.ok(!card.includes('Assigned'), 'an assignment band was drawn with nothing in it');
  assert.ok(!card.includes('cn-who'), 'a column of who-asked marks was drawn with nobody in it');
  assert.ok(card.includes('cn-prcard'), 'and the cards themselves are still drawn');
});

test('the fleet’s pull requests are grouped under their goal, a stack drawn top first', () => {
  const state = buildFixtureState();
  const payment = state.world.pullRequests.find((pr) => pr.branch === 'issue/390/payment');
  const refunds = state.world.pullRequests.find((pr) => pr.branch === 'issue/390/refunds');
  const loose = state.world.pullRequests.find(
    (pr) => goalOfPr(state, pr.number) === null && pr.viewerAssignment === undefined,
  );
  assert.ok(payment && refunds && loose, 'the fixtures must carry a two-PR stack on #390 and a PR with no goal');

  const card = rack(render(view()));
  const goal = goalIssue(state, 'issue:390');
  assert.ok(goal, 'the fixtures must carry goal #390');
  const head = card.indexOf(`<span class="cn-group-t">${goal.title}</span>`);
  assert.ok(head > 0, 'no heading names goal #390');
  const top = card.indexOf(prHeadline(refunds.title));
  assert.ok(top > head, 'the stack is not drawn under its goal');
  const bottom = card.indexOf(prHeadline(payment.title));
  assert.ok(bottom > top, 'the stack is not drawn top first, base at the bottom');
  assert.ok(card.slice(head, top).includes('cn-prstack'), 'the stack is not drawn as one block');
  const none = card.indexOf('No goal');
  assert.ok(
    none > bottom && card.indexOf(prHeadline(loose.title)) > none,
    'a PR with no goal is not drawn under "No goal", last',
  );
});

test('rackByGoal nests a stack under its base and orders goals by number, no goal last', () => {
  const state = buildFixtureState();
  const fleet = state.world.pullRequests.filter((pr) => pr.viewerAssignment === undefined);
  const groups = rackByGoal(state, fleet);
  assert.equal(groups[groups.length - 1]?.goal, null, 'the PRs with no goal are not last');
  const numbers = groups.flatMap((g) => (g.goal === null ? [] : [Number(g.goal.slice('issue:'.length))]));
  assert.deepEqual(
    numbers,
    [...numbers].sort((a, b) => a - b),
    'goals are not in number order',
  );
  const g390 = groups.find((g) => g.goal === 'issue:390');
  assert.ok(g390, 'goal #390 has no group');
  const refunds = g390.rungs.find((r) => r.pr.branch === 'issue/390/refunds');
  const payment = g390.rungs.find((r) => r.pr.branch === 'issue/390/payment');
  assert.equal(payment?.depth, 0);
  assert.equal(refunds?.depth, 1);
  assert.equal(refunds?.base, payment?.pr.number);
  assert.ok(g390.rungs.indexOf(payment!) < g390.rungs.indexOf(refunds!), 'the base is not first');
  assert.equal(groups.flatMap((g) => g.rungs).length, fleet.length, 'a pull request went missing or was drawn twice');
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
