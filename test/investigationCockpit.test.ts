import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { issuePickupStatus } from '../src/dispatcher/issuePickup.js';
import { DEFAULT_COOLDOWN } from '../src/dispatcher/dispatchCooldown.js';
import { goalFingerprint } from '../src/intake/appraisal.js';
import { investigationStandings } from '../src/intake/investigation.js';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { CockpitView } from '../web/src/view/viewModel.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';
import type { Issue as WireIssue } from '../web/src/types.js';
import type { Decision, Issue, IssueAppraisal, IssueInvestigation, Task } from '../src/types.js';
import { withAsks } from './support/asks.js';
import { decode } from './support/html.js';

(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { needBody } = await import('../web/src/console/NeedsBand.js');
const { RefLinks } = await import('../web/src/components/refs.js');
const { goalIssue } = await import('../web/src/view/goalRefs.js');
const { hasPrPage } = await import('../web/src/view/prPage.js');

const NOW = '2026-10-14T12:00:00.000Z';
const FINDINGS_WAITING = 'the investigation findings are waiting on you';

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
    recommendation: 'close',
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

function standing(i: Issue, ...investigations: IssueInvestigation[]) {
  return investigationStandings([i], investigations, { investigateLabel: 'investigate' });
}

test('an issue held for investigation says so, never that it awaits a planning agent', () => {
  const awaiting = issuePickupStatus(issue(), pickupCtx({ investigations: standing(issue()) }));
  assert.equal(awaiting.eligible, false);
  assert.equal(awaiting.status, 'investigation');
  assert.equal(awaiting.reasons[0], 'awaiting an investigation before it is planned');

  const running = issuePickupStatus(issue(), pickupCtx({ tasks: [task()], investigations: standing(issue()) }));
  assert.equal(running.status, 'investigation');
  assert.equal(running.reasons[0], 'being investigated before it is planned');

  const waiting = issuePickupStatus(issue(), pickupCtx({ investigations: standing(issue(), findings(issue())) }));
  assert.equal(waiting.eligible, false);
  assert.equal(waiting.status, 'investigation');
  assert.equal(waiting.reasons[0], FINDINGS_WAITING);
});

function attempts(n: number, at: string): Decision[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `d${i}`,
    cycleId: `c${i}`,
    action: {
      type: 'dispatch_code_agent',
      branch: 'investigate/issue/12',
      title: 'x',
      prompt: 'x',
      originRef: 'issue:12:investigate',
      reason: 'x',
    },
    outcome: 'executed',
    rule: 'issue-investigate',
    admission: null,
    detail: '',
    createdAt: at,
  })) as Decision[];
}

test('the investigator shares the appraiser’s cooldown and cap reading', () => {
  const cooling = issuePickupStatus(
    issue(),
    pickupCtx({ investigations: standing(issue()), recentDecisions: attempts(1, NOW) }),
  );
  assert.equal(cooling.status, 'investigation');
  assert.equal(cooling.reasons[0], 'investigation on cooldown');

  const capped = issuePickupStatus(
    issue(),
    pickupCtx({ investigations: standing(issue()), recentDecisions: attempts(3, '2026-07-27T00:00:00.000Z') }),
  );
  assert.notEqual(capped.status, 'investigation', 'a capped investigator fails open, as the rule does');
});

test('answered findings, or no label, fall back to the ordinary planning reason', () => {
  const planned = issuePickupStatus(
    issue(),
    pickupCtx({ investigations: standing(issue(), findings(issue(), { resolution: 'plan', resolvedAt: NOW })) }),
  );
  assert.equal(planned.status, 'planning');
  assert.equal(planned.reasons[0], 'awaiting a planning agent');

  const bare = issue({ labels: [] });
  const unlabelled = issuePickupStatus(bare, pickupCtx({ investigations: standing(bare, findings(bare)) }));
  assert.equal(unlabelled.reasons[0], 'awaiting a planning agent', 'the label is the only switch on the hold');

  const closing = issuePickupStatus(
    issue(),
    pickupCtx({ investigations: standing(issue(), findings(issue(), { resolution: 'close', resolvedAt: NOW })) }),
  );
  assert.equal(closing.status, 'investigation');
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

function investigated(
  over: Partial<IssueInvestigation> = {},
  hold: string | null = FINDINGS_WAITING,
  pickup: { status: 'investigation' | 'planning' | 'blocked'; reasons: string[] } = {
    status: hold === null ? 'planning' : 'investigation',
    reasons: [hold ?? 'awaiting a planning agent'],
  },
) {
  const state = buildDemoState().state;
  const target = state.world.issues.find((i) => i.state === 'open') as WireIssue;
  const issues = state.world.issues.map((i) =>
    i === target
      ? {
          ...i,
          investigation: findings(i, { originRef: `issue:${i.number}`, ...over }),
          investigationHold: hold,
          pickup: { eligible: false, ...pickup },
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
    'Close',
    'Ask for info',
    'Investigate again',
  ]) {
    assert.ok(html.includes(text), `the ask does not draw “${text}”`);
  }
  assert.match(html, /Close · recommended/, 'the recommended answer is marked');
  assert.doesNotMatch(html, /pickup/i, 'no answer sends a fix straight to pickup');
  assert.doesNotMatch(html, /Plan it · recommended/, 'only the recommended answer is marked');
});

test('the ask stands exactly while the findings hold the goal', () => {
  const answered = investigated({ resolution: 'plan', resolvedAt: NOW });
  assert.equal(
    view(answered.state).needsYou.some((n) => n.kind === 'findings'),
    false,
    'answered findings still ask',
  );
  const unheld = investigated({}, null);
  assert.equal(
    view(unheld.state).needsYou.some((n) => n.kind === 'findings'),
    false,
    'findings with the label off hold nothing, so they ask nothing',
  );
  const outranked = investigated({}, FINDINGS_WAITING, { status: 'blocked', reasons: ['blocked by #7'] });
  assert.equal(
    view(outranked.state).needsYou.some((n) => n.kind === 'findings'),
    true,
    'a higher-ranked pickup status hid findings that still hold the goal',
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
    [number, 'close'],
    [number, 'ask'],
    [number, null],
  ]);
});

test('the header says findings wait on you only while they hold the goal', async () => {
  const { investigationChip } = await import('../web/src/view/issueAsks.js');
  const goal = (s: ReturnType<typeof investigated>) => s.state.world.issues.find((i) => i.number === s.number)!;
  const chip = (s: ReturnType<typeof investigated>) => {
    const c = investigationChip(goal(s));
    return c === null ? null : { text: c.text, tone: c.tone };
  };
  assert.deepEqual(chip(investigated()), { text: 'waiting on you', tone: 'amber' });
  assert.equal(chip(investigated({}, null)), null, 'with the label off there is no ask to wait on');
  const answered = investigated({ resolution: 'close', resolvedAt: NOW }, 'you marked the investigation for closing');
  assert.deepEqual(chip(answered), { text: 'close', tone: 'green' });
});
