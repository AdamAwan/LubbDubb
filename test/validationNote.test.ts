import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { CockpitView } from '../web/src/view/viewModel.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';
import type { ValidationVerdict } from '../src/wire.js';

(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { ConsoleRoot } = await import('../web/src/console/ConsoleRoot.js');
const { RefLinks } = await import('../web/src/components/refs.js');
const { goalIssue } = await import('../web/src/view/goalPage.js');
const { hasPrPage } = await import('../web/src/view/prPage.js');
const { api } = await import('../web/src/api.js');

const FLAGGED: ValidationVerdict = {
  state: 'flagged',
  total: 4,
  passed: 1,
  failed: 0,
  unrun: 3,
  deferred: 0,
  waived: 0,
};
const CLEAR: ValidationVerdict = { state: 'clear', total: 4, passed: 4, failed: 0, unrun: 0, deferred: 0, waived: 0 };

const actions = new Proxy({}, { get: () => () => undefined }) as CockpitActions;

function closeOutGoal(state: CockpitView['state']): string {
  const task = (state.humanTasks ?? []).find((t) => t.kind === 'close_out' && t.status === 'open');
  assert.ok(task?.originRef, 'the demo fixtures must carry an open close-out on a goal');
  return task.originRef;
}

function goalView(mutate: (state: CockpitView['state']) => void): CockpitView {
  const state = buildDemoState().state;
  const target = closeOutGoal(state);
  mutate(state);
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
    selectedGoal: target,
    consolePanel: null,
    tab: 'overview',
  });
}

const render = (v: CockpitView) =>
  renderToStaticMarkup(
    createElement(RefLinks, {
      refUrls: v.state.refUrls,
      openGoal: () => undefined,
      hasGoal: (r: string) => goalIssue(v.state, r) !== undefined,
      openPr: () => undefined,
      hasPr: (n: number) => hasPrPage(v.state, n),
      children: createElement(ConsoleRoot, { view: v, actions }),
    }),
  );

function goalWith(verdict: ValidationVerdict | null): CockpitView {
  return goalView((state) => {
    const issue = goalIssue(state, closeOutGoal(state));
    assert.ok(issue, 'the close-out goal must be in the world the page draws from');
    issue.validation = verdict;
    issue.run = {
      startedAt: new Date(Date.now() - 86_400_000).toISOString(),
      completedAt: null,
      outcome: null,
      dismissed: false,
    };
  });
}

test('a close-out on a flagged goal asks for the note before posting, not after the 400', () => {
  const flagged = render(goalWith(FLAGGED));
  assert.ok(
    flagged.includes('Done…'),
    'the bench verdict must offer the box the route requires, not a bare Done the route refuses',
  );

  const clear = render(goalWith(CLEAR));
  assert.ok(!clear.includes('Done…'), 'a clear plan costs nothing to say, so it stays one click');
  assert.ok(clear.includes('>Done<'), 'and the one click is still there');

  const none = render(goalWith(null));
  assert.ok(!none.includes('Done…'), 'no plan is not a flagged plan');
});

test('ending the run is one destructive control that confirms on every goal', () => {
  for (const verdict of [FLAGGED, CLEAR, null]) {
    const html = render(goalWith(verdict));
    assert.ok(html.includes('Abandon…'), 'the control always says it will ask first');
    assert.ok(!html.includes('>Abandon<'), 'and never posts on the click itself');
    assert.match(html, /cn-ctlsegb cn-danger/, 'it is drawn as the destructive control it is');
  }
});

test('the note the cockpit sends is the one the routes read, and a refusal survives the round trip', async () => {
  const calls: { url: string; body: unknown }[] = [];
  const original = globalThis.fetch;
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    if (calls.length === 3) return reply(400, { error: 'note is required — Validation is not clear on this goal.' });
    return reply(200, { ok: true });
  }) as typeof fetch;

  try {
    await api.completeHumanTask('hum_1', 'closed it; A and C run on Monday');
    await api.dismissRun(12, 'shipping it anyway');
    await assert.rejects(api.completeHumanTask('hum_1'), /Validation is not clear/);
  } finally {
    globalThis.fetch = original;
  }

  assert.deepEqual(calls[0], {
    url: '/api/human-tasks/hum_1/done',
    body: { note: 'closed it; A and C run on Monday' },
  });
  assert.deepEqual(calls[1], { url: '/api/issues/12/dismiss-run', body: { note: 'shipping it anyway' } });
  assert.deepEqual(calls[2], { url: '/api/human-tasks/hum_1/done', body: undefined });
});
