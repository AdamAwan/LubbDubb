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

const actions = new Proxy({}, { get: () => () => undefined }) as CockpitActions;

function askBody(v: CockpitView, row: NeedRow, checksBelow = false): string {
  return renderToStaticMarkup(
    createElement(RefLinks, {
      refUrls: v.state.refUrls,
      openGoal: () => undefined,
      hasGoal: (ref: string) => goalIssue(v.state, ref) !== undefined,
      openPr: () => undefined,
      hasPr: (n: number) => hasPrPage(v.state, n),
      children: needBody(row, v, actions, checksBelow),
    }),
  );
}

function rowOfKind(v: CockpitView, kind: NeedRow['kind']): NeedRow {
  const row = v.needsYou.find((n) => n.kind === kind);
  assert.ok(row !== undefined, `the demo state has no ${kind} row to draw`);
  return row;
}

const validateRow = (v: CockpitView): NeedRow => rowOfKind(v, 'validate');

test('a validate ask draws the goal’s own check rows, not only the sentence naming them', () => {
  const v = view();
  const html = askBody(v, validateRow(v));
  const checks = v.state.validationChecks?.filter((c) => c.originRef === 'issue:395' && c.supersededReason === null);
  assert.ok(checks !== undefined && checks.length > 0, 'the goal the row is about has no checks');
  /* Matched on the title rather than the id: the sheet draws one check in full and the rest as a
     line each, and the title is what every check carries either way. The id is on the open row's
     own meta line, so asserting it would only ever find the one check being answered. */
  for (const check of checks) {
    assert.ok(html.includes(check.title), `check ${check.letter} is not drawn on the ask at all`);
  }
});

test('a validate ask draws one check in full — the first still owed — and the rest as a line each', () => {
  const v = view();
  const html = askBody(v, validateRow(v));
  const live = v.state.validationChecks!.filter((c) => c.originRef === 'issue:395' && c.supersededReason === null);
  const owed = live.filter((c) => c.state !== 'passed' && c.state !== 'waived');
  assert.ok(owed.length > 1 && owed.length < live.length, 'the goal must owe several checks and not all of them');
  /* The sheet is a queue, not a table: nine checks drawn open together is nine checks' worth of
     prose and controls competing for a decision that is always about one of them. So exactly one
     row is full, and it is the head of the queue rather than whichever the operator last touched.
     → docs/spec/17-cockpit.md#a-sheet-of-checks-is-a-queue */
  const full = html.split('pm-vrow open').length - 1;
  assert.equal(full, 1, 'the ask draws more than one check in full');
  const lines = html.split('class="vq-line ').length - 1;
  assert.equal(lines, live.length - 1, 'every check the sheet is not answering should be drawn as a line');
  /* Only the check being answered draws its own detail, so its id is the one that reaches the page. */
  assert.ok(html.includes(owed[0]!.id), `the open row should be ${owed[0]!.letter}, the first still owed`);
  assert.ok(!html.includes(owed[1]!.id), `${owed[1]!.letter} should be a line, not a second open row`);
});

test('a validate ask still carries the row’s own verbs', () => {
  const v = view();
  const html = askBody(v, validateRow(v));
  assert.match(html, /Done/, 'the bench row cannot be settled from the ask');
  assert.match(html, /Decline/, 'the bench row cannot be declined from the ask');
});

test('the close-out ask draws the checks its own note is about', () => {
  const v = view();
  const row = rowOfKind(v, 'close_out');
  const html = askBody(v, row);
  const live = (v.state.validationChecks ?? []).filter(
    (c) => c.originRef === row.goalRef && c.supersededReason === null,
  );
  assert.ok(live.length > 0, 'the goal being closed out has no checks, so there is nothing to assert');
  for (const check of live) {
    assert.ok(html.includes(check.title), `check ${check.letter} is not drawn on the close-out ask`);
  }
  /* The note on `Done` says the outstanding checks are listed above it. It is the
     sentence this body has to keep honest, so the rows it names are drawn before
     the verbs, and waiving one is a control here rather than a trip to the goal. */
  assert.ok(html.indexOf('pm-vrow') < html.indexOf('>Decline<'), 'the checks are drawn below the verbs');
});

test('on the goal page an ask that is about the checks does not draw them a second time', () => {
  const v = view();
  for (const kind of ['validate', 'close_out'] as const) {
    const row = rowOfKind(v, kind);
    const html = askBody(v, row, true);
    const live = v.state.validationChecks!.filter((c) => c.originRef === row.originRef && c.supersededReason === null);
    assert.ok(live.length > 0, `the goal the ${kind} row is about has no checks`);
    /* The rows are a pane away on this surface, and drawn here too they are a second live copy of
       one control — above the tab row, pushing it off the screen.
       → docs/spec/17-cockpit.md#an-ask-that-asks-for-work-draws-the-work */
    assert.ok(!html.includes('pm-vrow'), `the ${kind} ask redraws the check sheet on the goal page`);
    assert.ok(
      html.includes(`The ${live.length} check`) || html.includes('The 1 check'),
      `the ${kind} ask should say how many checks it is about`,
    );
    assert.match(html, /go to them/, `the ${kind} ask should offer the way to the checks it names`);
  }
});

test('the same ask off the goal page still draws the work', () => {
  const v = view();
  const html = askBody(v, validateRow(v));
  assert.ok(html.includes('pm-vrow'), 'the rail and the panel are the surfaces the sheet has to be on');
});

test('the runway ask lists the items it is asking to be put in play, with the control that does it', () => {
  const v = view();
  const state = {
    ...v.state,
    humanTasks: [
      ...(v.state.humanTasks ?? []),
      {
        id: 'hum-supply',
        title: 'The fleet is waiting on you, not on work',
        detail: 'Nothing is eligible for pickup and 2 of 4 slots are empty. 4 open issues nobody has watched.',
        originRef: null,
        partId: null,
        kind: 'supply' as const,
        agentId: null,
        taskId: null,
        status: 'open' as const,
        resolution: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        resolvedAt: null,
        dismissedAt: null,
      },
    ],
  };
  const withAsk = view(state);
  const row = rowOfKind(withAsk, 'supply');
  const html = askBody(withAsk, row);
  /* The list is the server's own verdict — `pickup.status` — never a label read
     here, so what the ask names and what the count behind it counted are one set. */
  const unwatched = withAsk.state.world.issues.filter((i) => i.pickup.status === 'unwatched');
  assert.ok(unwatched.length > 0, 'the demo has nothing unwatched, so there is nothing to assert');
  for (const issue of unwatched.slice(0, 8)) {
    assert.ok(html.includes(issue.title), `issue #${String(issue.number)} is not drawn on the runway ask`);
  }
  assert.match(html, />Watch</, 'the ask offers no way to put anything in play');
});

test('an assigned pull request draws its waiting threads and its reasons apart', () => {
  const v = view();
  const row = rowOfKind(v, 'assigned');
  const html = askBody(v, row);
  const number = Number(/^assigned:pr:(\d+)$/.exec(row.id)?.[1]);
  const pr = v.state.world.pullRequests.find((p) => p.number === number);
  assert.ok(pr !== undefined, 'the assigned row names a pull request the snapshot does not carry');
  const waiting = (pr.reviewThreads ?? []).filter((t) => t.state === 'open' || t.state === 'reopened');
  assert.ok(waiting.length > 0, 'the assigned pull request has no waiting thread to draw');
  for (const thread of waiting) {
    assert.ok(html.includes(thread.author), `the thread from ${thread.author} is not drawn`);
  }
  const resolved = (pr.reviewThreads ?? []).filter((t) => t.state === 'resolved');
  for (const thread of resolved) {
    assert.ok(!html.includes(thread.body), 'a resolved thread is drawn as something still waiting');
  }
  /* Each reason is its own line. Joined with a separator they read as one sentence
     nobody wrote, and they are separate facts: who put this on you, and what the
     harness is not doing about it. */
  assert.ok(!html.includes((pr.attention?.reasons ?? []).join(' · ')), 'the reasons are drawn as one joined line');
});

/* The three below were assertions on the goal page's own band. The goal page
   draws a row per ask now and the whole of one is the ask panel's, drawn by this
   same `needBody` — so the rules they are about are asserted here, where the
   body is, rather than lost with the band.
   → docs/spec/17-cockpit.md#an-ask-that-asks-for-work-draws-the-work */

test('a profile proposal is answered on the ask, both ways', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues.find((i) => i.number === 395);
  assert.ok(issue, 'the fixture goal must be in the world');
  issue.appraisal = {
    verdict: 'workable',
    summary: 'Three subsystems and an auth guard between them.',
    missing: [],
    by: 'appraiser',
    decidedAt: new Date(Date.now() - 3600_000).toISOString(),
    commentRef: null,
    proposedProfile: 'deep',
    awaitingProfileAnswer: true,
    placement: [],
    parentSettledAt: null,
  };
  const v = view(state);
  const html = askBody(v, rowOfKind(v, 'profile'));
  assert.ok(html.includes('The goal appraisal wants this run on “deep”'), 'the ask says what is being asked');
  assert.ok(html.includes('Use “deep”'), 'and offers the proposal');
  assert.ok(html.includes('Leave it unpinned') || /Keep “/.test(html), 'and the way to keep what is standing');
});

test('an escalation’s offered choices stay one click on the ask', () => {
  const state = buildDemoState().state;
  const row = view(state).needsYou.find((n) => n.goalRef !== null && n.kind === 'escalation');
  assert.ok(row, 'the demo fixtures must carry a goal-scoped question an agent is parked on');
  const asked = state.escalations.find((e) => e.id === row.id);
  assert.ok(asked, 'the escalation the row names must be in the state');
  asked.context = { ...asked.context, options: ['Take ours', 'Take theirs'] };
  const html = askBody(view(state), row);
  assert.match(html, /class="esc-quick"/, 'offered choices stay one click');
  assert.match(html, />Take theirs</);
});

test('a decision on an escalation reads as one, and is never free text', () => {
  const state = buildDemoState().state;
  const row = view(state).needsYou.find((n) => n.goalRef !== null && n.kind === 'escalation');
  assert.ok(row, 'the demo fixtures must carry a goal-scoped question an agent is parked on');
  state.escalations = state.escalations.filter((e) => e.id === row.id);
  state.proposals = [{ ...state.proposals![0]!, id: 'p-band', kind: 'merge', status: 'pending', escalationId: row.id }];
  const html = askBody(view(state), row);
  assert.match(html, /needs your decision/, 'a decision must read as one');
  assert.match(html, />Approve merge</);
  assert.doesNotMatch(html, /placeholder="Your answer…"/, 'a proposal is never answered with free text');
});
