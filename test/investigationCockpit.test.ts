import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { issuePickupStatus } from '../src/dispatcher/issuePickup.js';
import { DEFAULT_COOLDOWN } from '../src/dispatcher/dispatchCooldown.js';
import { goalFingerprint } from '../src/intake/appraisal.js';
import { FINDINGS_WAITING_REASON } from '../src/intake/investigationHold.js';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { CockpitView } from '../web/src/view/viewModel.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';
import type { Issue as WireIssue } from '../web/src/types.js';
import type { Issue, IssueAppraisal, IssueInvestigation, Task } from '../src/types.js';
import { withAsks } from './support/asks.js';
import { decode } from './support/html.js';

(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { needBody } = await import('../web/src/console/NeedsBand.js');
const { RefLinks } = await import('../web/src/components/refs.js');
const { goalIssue } = await import('../web/src/view/goalRefs.js');
const { hasPrPage } = await import('../web/src/view/prPage.js');

const NOW = '2026-10-14T12:00:00.000Z';

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i12',
    number: 12,
    title: 'Export crashes',
    body: 'Exporting an empty report throws.',
    labels: ['investigate'],
    state: 'open',
    linkedPrNumber: null,
    ...over,
  };
}

function findings(i: Pick<Issue, 'title' | 'body'>, over: Partial<IssueInvestigation> = {}): IssueInvestigation {
  return {
    originRef: 'issue:12',
    goalRef: goalFingerprint(i.title, i.body),
    by: 'a1',
    reproduction: 'Export a report with no rows.',
    rootCause: 'reduce() with no initial value on an empty array',
    confidence: 'high',
    locations: 'src/export/csv.ts:42',
    blastRadius: 'Only the CSV export.',
    recommendation: 'pickup',
    decidedAt: NOW,
    resolution: null,
    resolvedAt: null,
    ...over,
  };
}

function workable(): IssueAppraisal {
  const i = issue();
  return {
    originRef: 'issue:12',
    verdict: 'workable',
    summary: 'A crash on an empty export.',
    missing: [],
    goalRef: goalFingerprint(i.title, i.body),
    by: 'appraiser',
    proposedProfile: null,
    profileAnsweredAt: null,
    proposedParent: null,
    parentSettledAt: null,
    proposedAreaPath: null,
    areaPathSettledAt: null,
    investigate: true,
    agentId: null,
    taskId: null,
    commentRef: null,
    decidedAt: NOW,
    updatedAt: NOW,
  };
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    kind: 'code',
    title: 'Investigate issue #12',
    prompt: 'look',
    branch: 'investigate/issue/12',
    originRef: 'issue:12:investigate',
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'running',
    agentId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function pickupCtx(over: Partial<Parameters<typeof issuePickupStatus>[1]> = {}) {
  return {
    policy: { priorityLabels: {}, defaultPriority: 0, investigateLabel: 'investigate' },
    cooldown: DEFAULT_COOLDOWN,
    now: NOW,
    tasks: [],
    recentDecisions: [],
    openPrs: [],
    headroom: 3,
    paused: false,
    appraisals: [workable()],
    ...over,
  };
}

test('an issue held for investigation says so, never that it awaits a planning agent', () => {
  const awaiting = issuePickupStatus(issue(), pickupCtx());
  assert.equal(awaiting.eligible, false);
  assert.equal(awaiting.reasons[0], 'awaiting an investigation before it is planned');

  const running = issuePickupStatus(issue(), pickupCtx({ tasks: [task()] }));
  assert.equal(running.reasons[0], 'being investigated before it is planned');

  const waiting = issuePickupStatus(issue(), pickupCtx({ investigations: [findings(issue())] }));
  assert.equal(waiting.eligible, false);
  assert.equal(waiting.reasons[0], FINDINGS_WAITING_REASON);
});

test('answered findings, or no label, fall back to the ordinary planning reason', () => {
  const planned = issuePickupStatus(
    issue(),
    pickupCtx({ investigations: [findings(issue(), { resolution: 'plan', resolvedAt: NOW })] }),
  );
  assert.equal(planned.reasons[0], 'awaiting a planning agent');

  const unlabelled = issuePickupStatus(issue({ labels: [] }), pickupCtx({ investigations: [findings(issue())] }));
  assert.equal(unlabelled.reasons[0], 'awaiting a planning agent', 'the label is the only switch on the hold');

  const closing = issuePickupStatus(
    issue(),
    pickupCtx({ investigations: [findings(issue(), { resolution: 'close', resolvedAt: NOW })] }),
  );
  assert.equal(closing.reasons[0], 'you marked the investigation for closing');
});

function view(state: CockpitView['state']): CockpitView {
  return buildViewModel({
    state: withAsks(state),
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

function investigated(over: Partial<IssueInvestigation> = {}, reasons = [FINDINGS_WAITING_REASON]) {
  const state = buildDemoState().state;
  const target = state.world.issues.find((i) => i.state === 'open') as WireIssue;
  const issues = state.world.issues.map((i) =>
    i === target
      ? {
          ...i,
          investigation: findings(i, { originRef: `issue:${i.number}`, ...over }),
          pickup: { eligible: false, status: 'planning' as const, reasons },
        }
      : i,
  );
  return { state: { ...state, world: { ...state.world, issues } }, number: target.number };
}

function render(v: CockpitView, row: CockpitView['needsYou'][number], actions: CockpitActions): string {
  return decode(
    renderToStaticMarkup(
      createElement(RefLinks, {
        refUrls: v.state.refUrls,
        openGoal: () => undefined,
        hasGoal: (ref: string) => goalIssue(v.state, ref) !== undefined,
        openPr: () => undefined,
        hasPr: (n: number) => hasPrPage(v.state, n),
        children: needBody(row, v, actions),
      }),
    ),
  );
}

const noActions = new Proxy({}, { get: () => () => undefined }) as CockpitActions;

test('unanswered findings are an ask that draws them, the four answers and a re-run', () => {
  const { state, number } = investigated();
  const v = view(state);
  const row = v.needsYou.find((n) => n.kind === 'findings');
  assert.ok(row !== undefined, 'the findings raise no ask');
  assert.equal(row.goalRef, `issue:${number}`);
  const html = render(v, row, noActions);
  for (const text of [
    'Export a report with no rows.',
    'reduce() with no initial value on an empty array',
    'high confidence',
    'src/export/csv.ts:42',
    'Only the CSV export.',
    'Plan it',
    'Straight to pickup',
    'Close',
    'Ask for info',
    'Investigate again',
  ]) {
    assert.ok(html.includes(text), `the ask does not draw “${text}”`);
  }
  assert.match(html, /Straight to pickup · recommended/, 'the recommended answer is marked');
  assert.doesNotMatch(html, /Plan it · recommended/, 'only the recommended answer is marked');
});

test('the ask stands only while the pickup status says the findings hold the goal', () => {
  const answered = investigated({ resolution: 'plan', resolvedAt: NOW });
  assert.equal(
    view(answered.state).needsYou.some((n) => n.kind === 'findings'),
    false,
    'answered findings still ask',
  );
  const unheld = investigated({}, ['awaiting a planning agent']);
  assert.equal(
    view(unheld.state).needsYou.some((n) => n.kind === 'findings'),
    false,
    'findings with the label off hold nothing, so they ask nothing',
  );
});

test('each answer resolves the investigation, and Investigate again clears it', () => {
  const { state, number } = investigated();
  const v = view(state);
  const row = v.needsYou.find((n) => n.kind === 'findings')!;
  const calls: [number, string | null][] = [];
  const actions = new Proxy(
    {},
    {
      get: (_t, name) =>
        name === 'resolveInvestigation'
          ? (n: number, r: string | null) => {
              calls.push([n, r]);
              return Promise.resolve();
            }
          : () => undefined,
    },
  ) as CockpitActions;
  const body = needBody(row, v, actions) as React.ReactElement<{ children: React.ReactNode }>;
  const buttons: React.ReactElement<{ onClick: () => void }>[] = [];
  const walk = (node: React.ReactNode): void => {
    React.Children.forEach(node, (child) => {
      if (!React.isValidElement(child)) return;
      const props = child.props as { onClick?: () => void; children?: React.ReactNode };
      if (typeof props.onClick === 'function') buttons.push(child as React.ReactElement<{ onClick: () => void }>);
      walk(props.children);
    });
  };
  walk(body);
  for (const b of buttons) b.props.onClick();
  assert.deepEqual(calls, [
    [number, 'plan'],
    [number, 'pickup'],
    [number, 'close'],
    [number, 'ask'],
    [number, null],
  ]);
});
