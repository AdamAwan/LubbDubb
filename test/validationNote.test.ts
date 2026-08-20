import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { CockpitView } from '../web/src/view/viewModel.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';
import type { ValidationVerdict } from '../src/wire.js';

/**
 * The sentence the flag costs, and the fact that there is somewhere to say it.
 *
 * Two routes refuse a close with no note while a goal's validation plan is
 * flagged — `POST /api/human-tasks/:id/done` on a `close_out`, and
 * `POST /api/issues/:number/dismiss-run` ([20](../docs/spec/20-validation.md#where-it-lands)).
 * Both refusals were correct and both were unreachable: the cockpit's Done posted
 * no note and had no box to type one in, End the run posted none either, and the
 * 400 came back to a `catch` that dropped it and an unhandled rejection. The
 * operator saw two controls that did nothing when clicked — which is the one
 * outcome a rule stated as "it costs a sentence" must not have.
 *
 * So the assertions are in two halves: the browser can *say* it (the note reaches
 * the route as the route asks for it), and the browser *asks* for it at the
 * moment the route would refuse — mirrored in its condition only, the counts
 * staying the server's fold.
 *
 * `tsx` compiles JSX with the classic runtime, which emits bare
 * `React.createElement`; the global goes in before the console's modules load so
 * the test exercises the same sources the bundle does.
 */
(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { ConsoleRoot } = await import('../web/src/console/ConsoleRoot.js');
const { RefLinks } = await import('../web/src/components/refs.js');
const { goalIssue } = await import('../web/src/view/goalPage.js');
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

/** The goal the demo's close-out obligation hangs off — the row both halves are about. */
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
    selected: null,
    liveOutput: new Map(),
    tails: new Map(),
    lastPulseAt: Date.now(),
    viewingPlan: null,
    viewingRetro: null,
    hatching: null,
    viewingScratchpad: null,
    spendOpen: false,
    reliabilityOpen: false,
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
      children: createElement(ConsoleRoot, { view: v, actions }),
    }),
  );

/** Give the goal a verdict, and a run for the header's End-the-run control to end. */
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

  // The other polarity, `validationFlag.test.ts`'s discipline: a guard that asked
  // either way is friction, and friction is what gets the flag ignored.
  const clear = render(goalWith(CLEAR));
  assert.ok(!clear.includes('Done…'), 'a clear plan costs nothing to say, so it stays one click');
  assert.ok(clear.includes('>Done<'), 'and the one click is still there');

  // A goal nobody wrote a plan for is not "flagged" — null is "no checks", and
  // the route reads it that way too.
  const none = render(goalWith(null));
  assert.ok(!none.includes('Done…'), 'no plan is not a flagged plan');
});

test('ending the run on a flagged goal asks for the same sentence, and on a clear one does not', () => {
  const flagged = render(goalWith(FLAGGED));
  assert.ok(flagged.includes('End the run…'), 'the control that refuses without a note must offer one');

  const clear = render(goalWith(CLEAR));
  assert.ok(clear.includes('>End the run<'), 'a clear goal keeps the one click the route keeps');
  assert.ok(!clear.includes('End the run…'), 'and is asked for nothing');
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
    // The refusal reaches the caller as the server's own words rather than a
    // status line: that string is what the button now draws, and dropping it is
    // the whole failure this file is about.
    await assert.rejects(api.completeHumanTask('hum_1'), /Validation is not clear/);
  } finally {
    globalThis.fetch = original;
  }

  assert.deepEqual(calls[0], {
    url: '/api/human-tasks/hum_1/done',
    body: { note: 'closed it; A and C run on Monday' },
  });
  assert.deepEqual(calls[1], { url: '/api/issues/12/dismiss-run', body: { note: 'shipping it anyway' } });
  // Absent rather than empty on the arm that has nothing to say: the routes read
  // absence, and `''` would be that absence spelled a second way.
  assert.deepEqual(calls[2], { url: '/api/human-tasks/hum_1/done', body: undefined });
});
