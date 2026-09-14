import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { CockpitView } from '../web/src/view/viewModel.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';
import { buildLeads } from '../web/src/console/overviews/leads.js';

(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { NextOverview } = await import('../web/src/console/overviews/NextOverview.js');
const { RefLinks } = await import('../web/src/components/refs.js');
const { goalIssue } = await import('../web/src/view/goalPage.js');
const { hasPrPage } = await import('../web/src/view/prPage.js');

const actions = new Proxy({}, { get: () => () => undefined }) as CockpitActions;

function view(over: Partial<CockpitView> = {}): CockpitView {
  const state = buildDemoState().state;
  return {
    ...buildViewModel({
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
      overviewShape: 'next',
    }),
    needsYou: [],
    ...over,
  };
}

function markup(v: CockpitView): string {
  return renderToStaticMarkup(
    createElement(RefLinks, {
      refUrls: v.state.refUrls,
      openGoal: () => undefined,
      hasGoal: (ref: string) => goalIssue(v.state, ref) !== undefined,
      openPr: () => undefined,
      hasPr: (n: number) => hasPrPage(v.state, n),
      children: createElement(NextOverview, { view: v, actions }),
    }),
  );
}

/* The clear state is the whole point of the leads: an empty ask queue is not an
   empty deployment, and the sentence on its own left the operator nothing to do
   on the surface that exists to say what to do. */
test('an empty ask queue draws the leads rather than a sentence alone', () => {
  const v = view();
  const leads = buildLeads(v);
  assert.ok(leads.length > 0, 'the demo deployment has something worth a look');

  const html = markup(v);
  assert.match(html, /Nothing needs you\./);
  assert.match(html, /Worth a look/);
  for (const lead of leads) assert.ok(html.includes(lead.title), `${lead.key} is drawn`);
});

test('no lead is ever built with nothing in it', () => {
  for (const lead of buildLeads(view())) assert.ok(lead.count > 0, `${lead.key} counts something`);
});

/* Every lead and every thing it names has somewhere to go — a name with no way
   to it is the cockpit's most repeated bug. */
test('every lead and every named item carries a way there', () => {
  for (const lead of buildLeads(view())) {
    assert.ok(lead.go.length > 0, `${lead.key} has a control word`);
    assert.ok(lead.where.kind.length > 0, `${lead.key} has a where`);
    for (const item of lead.items) assert.ok(item.ref.length > 0 && item.where.kind.length > 0);
  }
});

test('the reservoir lead counts the unwatched and nothing else', () => {
  const v = view();
  const lead = buildLeads(v).find((l) => l.key === 'reservoir');
  const unwatched = v.state.world.issues.filter((i) => i.pickup.status === 'unwatched').length;
  if (unwatched === 0) {
    assert.equal(lead, undefined);
    return;
  }
  assert.equal(lead?.count, unwatched);
  assert.ok((lead?.items.length ?? 0) <= 3, 'it names a few, not the list');
});

/* A goal an agent is out on is not a lead: it is the fleet working, which the
   surface has already said in its own first line. */
test('a goal with an agent on it is not a quiet goal', () => {
  const v = view();
  const quiet = buildLeads(v).find((l) => l.key === 'quiet');
  for (const item of quiet?.items ?? []) assert.equal(v.agentOnGoal.has(item.ref), false);
});

/* Nothing queued, nothing unwatched, nothing open, nothing recorded: the answer
   is to give the fleet work, not another reading. */
test('with nothing to find at all, the clear state offers the launch desk', () => {
  const base = view();
  const v: CockpitView = {
    ...base,
    upNext: [],
    state: {
      ...base.state,
      world: { ...base.state.world, issues: [], pullRequests: [] },
      errors: [],
    },
  };
  assert.deepEqual(buildLeads(v), []);

  const html = markup(v);
  assert.match(html, /Nothing to look at either/);
  assert.match(html, /Write a brief/);
  assert.doesNotMatch(html, /Worth a look/);
});
