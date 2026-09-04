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

/** The rack's markup alone: the card between its own heading and the next card's. */
const rack = (html: string): string => html.slice(html.indexOf('Pull requests'), html.indexOf('Up next'));

/** Where a row starts. The boundary keeps `cn-rows`, the container, out of the count. */
const ROW = /class="cn-row[ "]/g;

/**
 * The rack is the one card cut in two, and every one of its rows is cut the same
 * way.
 *
 * The shape is the point: a row that kept its readings on the identity line while
 * its neighbours dropped them onto a strip would be the packed flex line the rail
 * replaced, one card down. So the cut is a fact about the card — `layout` on
 * `PanelRows` — and never a per-row decision.
 */
test('every pull-request row is cut in two, and no other card is', () => {
  const html = render(view());
  const rows = rack(html).split(ROW).slice(1);
  assert.ok(rows.length > 0, 'no pull-request rows rendered');
  for (const row of rows) assert.match(row, /cn-srow/, 'a pull-request row was drawn on one line');

  // And only there: the stacked cut is the answer to *this* card being
  // over-subscribed, not a second way to draw a row that other cards may pick up.
  const elsewhere = html.split('class="cn-card').filter((card) => !card.includes('Pull requests'));
  for (const card of elsewhere) {
    assert.ok(!card.includes('cn-srow'), 'another card took the rack’s two-line cut');
  }
});

/**
 * The strip's readings sit under the **subject**, and the refs stay out of it.
 *
 * Stopping at the refs rule is what keeps the card's one vertical edge unbroken
 * from top to bottom — the edge between what a row *is* and what it *names*. A
 * strip running the full width crosses it on every row, and the rule stops
 * reading as a rule.
 *
 * **Placement is the sheet's now, and the row carries the values it places
 * with.** The cut is a ceiling rather than a shape — a card wide enough for the
 * whole rail draws the row on one line — and an inline `grid-template-columns` is
 * the one declaration a container query cannot outrank. So what the markup has to
 * carry is both rails, the strip's own, and the subject's column index, which only
 * `slotsUsed` can count. A row missing one of them renders as an unplaced strip
 * with no error anywhere.
 */
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
    // The strip is the refs' *sibling*, never their parent — on either shape. Its
    // span has to have closed before the refs group opens, which is the one thing
    // about the edge that is still readable out of the markup.
    const between = row.slice(row.indexOf('cn-rowreads'), row.indexOf('class="cn-refs"'));
    assert.ok(between.length > 0, 'the refs are drawn before the strip');
    const opened = between.match(/<span/g)?.length ?? 0;
    const closed = between.match(/<\/span>/g)?.length ?? 0;
    assert.equal(opened, closed, 'the refs are drawn inside the strip');
  }
});

/**
 * The ceiling itself, read out of the sheet.
 *
 * `layout="stacked"` is the card saying it is over-subscribed, which is true of
 * the rack at a quarter of the page and false of it at 1400px — where the second
 * line cost 105px a row to leave both lines two-thirds gutter. Only a **container**
 * query can tell those apart: a media query measures the window, which on this
 * page is four different card widths at once. Nothing else in the sheet asserts
 * it, and a stacked card that lost the query looks exactly like one that never had
 * it.
 */
test('the stacked cut is a ceiling, off the card’s own width', async () => {
  const { readFile } = await import('node:fs/promises');
  const sheet = await readFile(new URL('../web/src/console/console.css', import.meta.url), 'utf8');
  assert.match(sheet, /\.cn-rows\s*\{[^}]*container:\s*cn-rows\s*\/\s*inline-size/, 'the rows are not a container');
  const query = /@container cn-rows \(min-width: \d+px\) \{([\s\S]*?)\n\}/.exec(sheet);
  assert.ok(query, 'the sheet carries no ceiling for the stacked cut');
  assert.match(query[1] ?? '', /--cn-cols-line/, 'the wide shape does not take the one-line rail');
  assert.match(query[1] ?? '', /display:\s*contents/, 'the strip’s slots do not rejoin the row’s grid');
});

/**
 * The readings run left to right by how often they exist, and the checks lead.
 *
 * A strip is a short run of boxes with a ragged end, and where the gaps fall is
 * the whole of whether the card reads as a column or as a scatter: a provider
 * reports checks on nearly every pull request, the fleet reviews most, and a pack
 * exists for a handful. Ordered the other way round — which is how the slot was
 * built, review first — the one reading almost every row has sat at a different x
 * on each of them.
 */
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
    // Something is always in the checks' place: the chip, or the gap the width of
    // one where this row has no reading or is withholding it.
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

/** Where a pattern first matches, or `Infinity` where it does not match at all. */
function at(text: string, re: RegExp): number {
  const found = re.exec(text);
  return found === null ? Infinity : found.index;
}
