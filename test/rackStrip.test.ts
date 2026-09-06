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
const { goalIssue } = await import('../web/src/view/goalPage.js');
const { hasPrPage } = await import('../web/src/view/prPage.js');

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

const ROW = /class="cn-row[ "]/g;

test('every pull-request row is cut in two, and no other card is', () => {
  const html = render(view());
  const rows = rack(html).split(ROW).slice(1);
  assert.ok(rows.length > 0, 'no pull-request rows rendered');
  for (const row of rows) assert.match(row, /cn-srow/, 'a pull-request row was drawn on one line');

  const elsewhere = html.split('class="cn-card').filter((card) => !card.includes('Pull requests'));
  for (const card of elsewhere) {
    assert.ok(!card.includes('cn-srow'), 'another card took the rack’s two-line cut');
  }
});

const RAILS = ['--cn-cols-stacked', '--cn-cols-line', '--cn-strip-cols', '--cn-subject'];

test('the row carries both rails, and the strip stops at the refs rule', () => {
  const html = render(view());
  const rows = rack(html)
    .split(ROW)
    .slice(1)
    .filter((row) => row.includes('cn-rowreads'));
  assert.ok(rows.length > 0, 'no row drew a strip');
  for (const row of rows) {
    const rails = /style="([^"]*--cn-subject[^"]*)"/.exec(row)?.[1] ?? '';
    for (const prop of RAILS) assert.ok(rails.includes(prop), `the row carries no ${prop}`);
    assert.match(rails, /--cn-subject:\s*[1-9]/, 'the subject’s column was not counted');
    const between = row.slice(row.indexOf('cn-rowreads'), row.indexOf('class="cn-refs"'));
    assert.ok(between.length > 0, 'the refs are drawn before the strip');
    const opened = between.match(/<span/g)?.length ?? 0;
    const closed = between.match(/<\/span>/g)?.length ?? 0;
    assert.equal(opened, closed, 'the refs are drawn inside the strip');
  }
});

test('the stacked cut is a ceiling, off the card’s own width', async () => {
  const { readFile } = await import('node:fs/promises');
  const sheet = await readFile(new URL('../web/src/console/console.css', import.meta.url), 'utf8');
  assert.match(sheet, /\.cn-rows\s*\{[^}]*container:\s*cn-rows\s*\/\s*inline-size/, 'the rows are not a container');
  const query = /@container cn-rows \(min-width: \d+px\) \{([\s\S]*?)\n\}/.exec(sheet);
  assert.ok(query, 'the sheet carries no ceiling for the stacked cut');
  assert.match(query[1] ?? '', /--cn-cols-line/, 'the wide shape does not take the one-line rail');
  assert.match(query[1] ?? '', /display:\s*contents/, 'the strip’s slots do not rejoin the row’s grid');
});

test('the checks lead the strip, and the marks behind them hold their boxes', () => {
  const html = render(view());
  const rows = rack(html)
    .split(ROW)
    .slice(1)
    .map((row) => {
      const at = row.indexOf('cn-slot-read');
      assert.ok(at > 0, 'a pull-request row drew no reading slot');
      return row.slice(at, row.indexOf('cn-refs') > at ? row.indexOf('cn-refs') : undefined);
    });
  assert.ok(rows.length > 0, 'no pull-request rows rendered');
  for (const read of rows) {
    const checks = Math.min(...[/class="ck /, /class="ck-slot"/].map((re) => at(read, re)));
    const review = Math.min(...[/class="rv /, /class="rv rv-none"/].map((re) => at(read, re)));
    const pack = Math.min(...[/class="pk /, /class="pk pk-none"/].map((re) => at(read, re)));
    assert.ok(checks < Infinity, 'a row kept nothing in the checks’ place');
    assert.ok(review < Infinity, 'a row closed the review mark’s box up');
    assert.ok(pack < Infinity, 'a row closed the pack mark’s box up');
    assert.ok(checks < review, 'the review mark is drawn ahead of the checks');
    assert.ok(review < pack, 'the pack mark is drawn ahead of the review');
  }
});

function at(text: string, re: RegExp): number {
  const found = re.exec(text);
  return found === null ? Infinity : found.index;
}
