import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { CockpitView } from '../web/src/view/viewModel.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';
import type { NeedRow } from '../web/src/view/needsYou.js';

(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { needBody } = await import('../web/src/console/NeedsBand.js');
const { RefLinks } = await import('../web/src/components/refs.js');
const { goalIssue } = await import('../web/src/view/goalPage.js');
const { hasPrPage } = await import('../web/src/view/prPage.js');

function view(): CockpitView {
  return buildViewModel({
    state: buildDemoState().state,
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

function askBody(v: CockpitView, row: NeedRow): string {
  return renderToStaticMarkup(
    createElement(RefLinks, {
      refUrls: v.state.refUrls,
      openGoal: () => undefined,
      hasGoal: (ref: string) => goalIssue(v.state, ref) !== undefined,
      openPr: () => undefined,
      hasPr: (n: number) => hasPrPage(v.state, n),
      children: needBody(row, v, actions),
    }),
  );
}

function validateRow(v: CockpitView): NeedRow {
  const row = v.needsYou.find((n) => n.kind === 'validate');
  assert.ok(row !== undefined, 'the demo state has no validate bench row to draw');
  return row;
}

test('a validate ask draws the goal’s own check rows, not only the sentence naming them', () => {
  const v = view();
  const html = askBody(v, validateRow(v));
  const checks = v.state.validationChecks?.filter((c) => c.originRef === 'issue:395' && c.supersededReason === null);
  assert.ok(checks !== undefined && checks.length > 0, 'the goal the row is about has no checks');
  for (const check of checks) {
    assert.ok(html.includes(check.id), `check ${check.letter} is not drawn on the ask at all`);
  }
});

test('a validate ask opens every check still owed, and leaves the settled ones closed', () => {
  const v = view();
  const html = askBody(v, validateRow(v));
  const live = v.state.validationChecks!.filter((c) => c.originRef === 'issue:395' && c.supersededReason === null);
  const owed = live.filter((c) => c.state !== 'passed' && c.state !== 'waived');
  assert.ok(owed.length > 0 && owed.length < live.length, 'the goal must owe some checks and not all of them');
  /* Counted off the row's own disclosure rather than matched on its prose: what an
     open row draws is its `do`, its `expect` and its steps, and every one of those
     is markdown by the time it reaches the page. */
  const open = html.split('aria-expanded="true"').length - 1;
  assert.equal(open, owed.length, 'the rows drawn open are not the rows still owed');
});

test('a validate ask still carries the row’s own verbs', () => {
  const v = view();
  const html = askBody(v, validateRow(v));
  assert.match(html, /Done/, 'the bench row cannot be settled from the ask');
  assert.match(html, /Decline/, 'the bench row cannot be declined from the ask');
});
