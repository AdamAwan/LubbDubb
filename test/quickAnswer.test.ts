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
const { NeedsBand } = await import('../web/src/console/NeedsBand.js');
const { quickAnswer } = await import('../web/src/view/quickAnswer.js');

function view(state: CockpitView['state'] = buildDemoState().state): CockpitView {
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

function rowOfKind(v: CockpitView, kind: NeedRow['kind']): NeedRow {
  const row = v.needsYou.find((n) => n.kind === kind);
  assert.ok(row !== undefined, `the demo state has no ${kind} row`);
  return row;
}

const actions = new Proxy({}, { get: () => () => Promise.resolve() }) as CockpitActions;

function line(v: CockpitView, row: NeedRow): string {
  return renderToStaticMarkup(createElement(NeedsBand, { row, view: v, actions, line: true }));
}

test('a profile ask with a proposal draws accept and change on its row', () => {
  const v = view();
  const row = rowOfKind(v, 'profile');
  const quick = quickAnswer(row, v.state);
  assert.ok(quick !== null);
  assert.equal(quick.field, 'profile');
  assert.equal(quick.proposed, 'deep');
  assert.ok(!quick.others.includes('deep'));
  const html = line(v, row);
  assert.match(html, /cn-needs-quick/);
  assert.match(html, /✓ deep/);
  assert.match(html, /Change…/);
});

test('an area-path ask answers on its row and says Pick a board', () => {
  const base = buildDemoState().state;
  const issue = base.world.issues.find((i) => i.appraisal?.placement.some((p) => p.field === 'parent'));
  assert.ok(issue?.appraisal);
  issue.appraisal.placement = [{ field: 'areaPath', proposedParent: null, proposedAreaPath: 'NXG\\Statements' }];
  const v = view(base);
  const row = v.needsYou.find((n) => n.id === `placement:areaPath:issue:${issue.number}`);
  assert.ok(row);
  assert.equal(row.verb, 'Pick a board');
  const quick = quickAnswer(row, v.state);
  assert.equal(quick?.field, 'areaPath');
  assert.equal(quick?.proposed, 'NXG\\Statements');
  assert.match(line(v, row), /✓ NXG\\Statements/);
});

test('a parent ask gets no quick answer and keeps its verb', () => {
  const v = view();
  const row = rowOfKind(v, 'placement');
  assert.equal(row.placementField, 'parent');
  assert.equal(quickAnswer(row, v.state), null);
  const html = line(v, row);
  assert.doesNotMatch(html, /cn-needs-quick/);
  assert.match(html, /Pick a parent/);
});
