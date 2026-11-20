import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { CockpitView } from '../web/src/view/viewModel.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';
import { repoPath } from './support/paths.js';

(globalThis as { React?: typeof React }).React = React;

const { buildFixtureState } = await import('./support/cockpitFixtures.js');
const { Overview } = await import('../web/src/console/Overview.js');
const { RefLinks } = await import('../web/src/components/refs.js');
const { goalIssue } = await import('../web/src/view/goalRefs.js');
const { hasPrPage } = await import('../web/src/view/prPage.js');

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

const actions = new Proxy({}, { get: () => () => undefined }) as CockpitActions;

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

const rack = (html: string): string => html.slice(html.indexOf('Pull requests'), html.indexOf('Build'));

const CARD = /class="cn-prcard[ "]/g;

test('every open pull request on the rack is a card, and no overview row takes the stacked cut', () => {
  const v = view();
  const html = render(v);
  const cards = rack(html).split(CARD).slice(1);
  assert.equal(cards.length, v.state.world.pullRequests.length, 'a pull request is not drawn as a card');
  assert.ok(!html.includes('cn-srow'), 'a row on the overview took the stacked cut');
});

test('a card’s references sit beside its title, never inside it', () => {
  const cards = rack(render(view())).split(CARD).slice(1);
  for (const card of cards) {
    const at = card.indexOf('cn-prcard-title');
    assert.ok(at > 0, 'a card has no title control');
    const title = card.slice(at, card.indexOf('</button>', at));
    assert.ok(!title.includes('ref-goal'), 'a reference was drawn inside the title control');
  }
});

test('the stacked cut is a ceiling, off the card’s own width', async () => {
  const { readFile } = await import('node:fs/promises');
  const sheet = await readFile(repoPath('web/src/console/console.css'), 'utf8');
  assert.match(sheet, /\.cn-rows\s*\{[^}]*container:\s*cn-rows\s*\/\s*inline-size/, 'the rows are not a container');
  const query = /@container cn-rows \(min-width: \d+px\) \{([\s\S]*?)\n\}/.exec(sheet);
  assert.ok(query, 'the sheet carries no ceiling for the stacked cut');
  assert.match(query[1] ?? '', /--cn-cols-line/, 'the wide shape does not take the one-line rail');
  assert.match(query[1] ?? '', /display:\s*contents/, 'the strip’s slots do not rejoin the row’s grid');
});

test('the checks lead the marks, and the marks behind them hold their boxes', () => {
  const reads = rack(render(view()))
    .split(CARD)
    .slice(1)
    .map((card) => {
      const at = card.indexOf('cn-prcard-marks');
      assert.ok(at > 0, 'a pull-request card drew no marks');
      return card.slice(at, card.indexOf('cn-prcard-head'));
    });
  assert.ok(reads.length > 0, 'no pull-request cards rendered');
  for (const read of reads) {
    const checks = Math.min(...[/class="ck /, /cn-onit/].map((re) => at(read, re)));
    const review = Math.min(...[/class="rv /, /class="rv rv-none"/].map((re) => at(read, re)));
    assert.ok(checks < Infinity, 'a card kept nothing in the checks’ place');
    assert.ok(review < Infinity, 'a card closed the review mark’s box up');
    assert.ok(checks < review, 'the review mark is drawn ahead of the checks');
  }
});

function at(text: string, re: RegExp): number {
  const found = re.exec(text);
  return found === null ? Infinity : found.index;
}
