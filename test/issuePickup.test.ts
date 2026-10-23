import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectivePickupStates,
  issueBranch,
  issuePriority,
  isIssuePickupEligible,
  issuePickupStatus,
  openPrForIssue,
} from '../src/dispatcher/issuePickup.js';
import type { IssuePickupPolicy, IssuePickupContext } from '../src/dispatcher/issuePickup.js';
import type { Decision, Issue, IssueRun, PullRequest, Task } from '../src/types.js';
import { planOrigin } from '../src/plans/planning.js';
import { spentAppraisalAttempts } from './support/plans.js';

const SCHEME: IssuePickupPolicy = {
  priorityLabels: { 'priority:high': 3, 'priority:medium': 2, 'priority:low': 1 },
  defaultPriority: 2,
  investigateLabel: 'investigate',
};

function issue(over: Partial<Issue> = {}): Issue {
  return { id: 'i', number: 1, title: 'X', body: '', labels: [], state: 'open', linkedPrNumber: null, ...over };
}

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return { id: 'p', number: 41, title: 'P', branch: 'issue/1', ciStatus: 'pending', unresolvedComments: [], ...over };
}

test('issuePriority returns the mapped weight for a matching label', () => {
  assert.equal(issuePriority(['priority:high'], SCHEME), 3);
  assert.equal(issuePriority(['priority:low'], SCHEME), 1);
});

test('issuePriority falls back to the default weight when no label matches', () => {
  assert.equal(issuePriority([], SCHEME), 2);
  assert.equal(issuePriority(['bug', 'wontfix'], SCHEME), 2);
});

test('issuePriority takes the highest weight when several priority labels are present', () => {
  assert.equal(issuePriority(['priority:low', 'priority:high'], SCHEME), 3);
});

test('isIssuePickupEligible: without a pickup label every issue is eligible, with no reasons', () => {
  const policy: IssuePickupPolicy = { priorityLabels: {}, defaultPriority: 0, investigateLabel: 'investigate' };
  assert.deepEqual(isIssuePickupEligible(issue({ labels: [] }), policy), { eligible: true, reasons: [] });
  assert.deepEqual(isIssuePickupEligible(issue({ labels: ['bug'] }), policy), { eligible: true, reasons: [] });
});

test('isIssuePickupEligible: with a pickup label only labelled issues are eligible', () => {
  const policy: IssuePickupPolicy = {
    watchLabel: 'agent-ready',
    priorityLabels: {},
    defaultPriority: 0,
    investigateLabel: 'investigate',
  };
  assert.equal(isIssuePickupEligible(issue({ labels: ['agent-ready'] }), policy).eligible, true);
  assert.deepEqual(isIssuePickupEligible(issue({ labels: ['bug'] }), policy), {
    eligible: false,
    reasons: ['no watch label "agent-ready"'],
  });
  assert.equal(isIssuePickupEligible(issue({ labels: [] }), policy).eligible, false);
});

test('isIssuePickupEligible: requireOwnLabel counts only the viewer-added tag', () => {
  const policy: IssuePickupPolicy = {
    watchLabel: 'agent-ready',
    requireOwnLabel: true,
    priorityLabels: {},
    defaultPriority: 0,
    investigateLabel: 'investigate',
  };
  assert.equal(
    isIssuePickupEligible(issue({ labels: ['agent-ready'], labelsAddedByViewer: ['agent-ready'] }), policy).eligible,
    true,
  );
  assert.deepEqual(isIssuePickupEligible(issue({ labels: ['agent-ready'], labelsAddedByViewer: [] }), policy), {
    eligible: false,
    reasons: ['watch label "agent-ready" not added by you'],
  });
  assert.deepEqual(isIssuePickupEligible(issue({ labels: ['agent-ready'] }), policy), {
    eligible: false,
    reasons: ['watch label "agent-ready" not added by you'],
  });
});

test('isIssuePickupEligible: requireOwnLabel is ignored when no pickup label is set', () => {
  const policy: IssuePickupPolicy = {
    requireOwnLabel: true,
    priorityLabels: {},
    defaultPriority: 0,
    investigateLabel: 'investigate',
  };
  assert.equal(isIssuePickupEligible(issue({ labels: ['bug'] }), policy).eligible, true);
});

test('isIssuePickupEligible: state gate only picks up items in an allowed workItemState', () => {
  const policy: IssuePickupPolicy = {
    priorityLabels: {},
    defaultPriority: 0,
    investigateLabel: 'investigate',
    pickupStates: ['Ready', 'Doing'],
  };
  assert.equal(isIssuePickupEligible(issue({ workItemState: 'Ready' }), policy).eligible, true);
  assert.equal(isIssuePickupEligible(issue({ workItemState: 'Doing' }), policy).eligible, true);
  assert.deepEqual(isIssuePickupEligible(issue({ workItemState: 'New' }), policy), {
    eligible: false,
    reasons: ['state "New" not in pickup states'],
  });
});

test('isIssuePickupEligible: an item parked in the review state says "in review"', () => {
  const policy: IssuePickupPolicy = {
    priorityLabels: {},
    defaultPriority: 0,
    investigateLabel: 'investigate',
    pickupStates: ['Ready'],
    inReviewState: 'In Review',
  };
  assert.deepEqual(isIssuePickupEligible(issue({ workItemState: 'In Review' }), policy), {
    eligible: false,
    reasons: ['in review'],
  });
});

test('isIssuePickupEligible: the state gate is a no-op for issues with no workItemState', () => {
  const policy: IssuePickupPolicy = {
    priorityLabels: {},
    defaultPriority: 0,
    investigateLabel: 'investigate',
    pickupStates: ['Ready'],
  };
  assert.equal(isIssuePickupEligible(issue({ workItemState: undefined }), policy).eligible, true);
});

test('isIssuePickupEligible: an empty pickupStates list leaves the state gate off', () => {
  const policy: IssuePickupPolicy = {
    priorityLabels: {},
    defaultPriority: 0,
    investigateLabel: 'investigate',
    pickupStates: [],
  };
  assert.equal(isIssuePickupEligible(issue({ workItemState: 'Anything' }), policy).eligible, true);
});

test('isIssuePickupEligible: the state and label gates both report their reasons together', () => {
  const policy: IssuePickupPolicy = {
    watchLabel: 'agent-ready',
    priorityLabels: {},
    defaultPriority: 0,
    investigateLabel: 'investigate',
    pickupStates: ['Ready'],
  };
  assert.equal(
    isIssuePickupEligible(issue({ workItemState: 'Ready', labels: ['agent-ready'] }), policy).eligible,
    true,
  );
  assert.equal(isIssuePickupEligible(issue({ workItemState: 'Ready', labels: [] }), policy).eligible, false);
  assert.deepEqual(isIssuePickupEligible(issue({ workItemState: 'New', labels: [] }), policy), {
    eligible: false,
    reasons: ['state "New" not in pickup states', 'no watch label "agent-ready"'],
  });
});

test('openPrForIssue: no PRs at all means no open PR', () => {
  assert.equal(openPrForIssue(issue({ linkedPrNumber: 41 }), []), null);
});

test('openPrForIssue: a linked PR that is still open is found by number', () => {
  const found = openPrForIssue(issue({ linkedPrNumber: 41 }), [pr({ number: 41, branch: 'other' })]);
  assert.equal(found?.number, 41);
});

test('openPrForIssue: a PR on the issue branch counts before the provider links it', () => {
  const found = openPrForIssue(issue({ number: 12, linkedPrNumber: null }), [pr({ number: 99, branch: 'issue/12' })]);
  assert.equal(found?.number, 99);
});

test('openPrForIssue: a merged linked PR no longer parks the issue', () => {
  assert.equal(openPrForIssue(issue({ linkedPrNumber: 41 }), [pr({ number: 41, merged: true })]), null);
});

test('openPrForIssue: an unwatched PR still parks its issue', () => {
  const hidden = pr({ number: 41, branch: 'issue/1', labels: [] });
  assert.equal(openPrForIssue(issue({ linkedPrNumber: 41 }), [hidden])?.number, 41);
});

test("issueBranch is an issue's flat, unplanned branch", () => {
  assert.equal(issueBranch(12), 'issue/12');
});

const NOW = '2026-07-21T01:00:00Z';

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    kind: 'code',
    title: 'T',
    prompt: 'p',
    branch: 'issue/1',
    originRef: 'issue:1',
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'running',
    agentId: 'a1',
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function dispatched(origin: string, createdAt: string): Decision {
  return {
    id: `d_${createdAt}`,
    cycleId: 'c',
    outcome: 'executed',
    detail: '',
    rule: null,
    admission: null,
    createdAt,
    action: { type: 'dispatch_code_agent', reason: 'r', originRef: origin },
  };
}

function run(over: Partial<IssueRun> = {}): IssueRun {
  return {
    originRef: 'issue:1',
    issueNumber: 1,
    title: 'X',
    body: '',
    labels: [],
    linkedPrNumber: null,
    workItemState: null,
    startedAt: NOW,
    completedAt: null,
    outcome: null,
    dismissedAt: null,
    dismissNote: null,
    updatedAt: NOW,
    ...over,
  };
}

function ctx(over: Partial<IssuePickupContext> = {}): IssuePickupContext {
  return {
    policy: { priorityLabels: {}, defaultPriority: 0, investigateLabel: 'investigate' },
    cooldown: { maxAttempts: 3, cooldownMs: 60_000 },
    now: NOW,
    tasks: [],
    recentDecisions: spentAppraisalAttempts(1),
    openPrs: [],
    plans: [],
    headroom: 2,
    paused: false,
    ...over,
  };
}

test('issuePickupStatus: a closed issue the harness never ran at is done', () => {
  const v = issuePickupStatus(issue({ state: 'closed' }), ctx());
  assert.deepEqual(v, { eligible: false, status: 'done', reasons: ['closed'] });
});

test('issuePickupStatus: a closed issue whose run still lives is retained, not done', () => {
  const abandoned = issuePickupStatus(issue({ state: 'closed' }), ctx({ runs: [run({ completedAt: null })] }));
  assert.deepEqual(abandoned, {
    eligible: false,
    status: 'retained',
    reasons: ['closed mid-run; kept until you dismiss it'],
  });

  const judged = issuePickupStatus(issue({ state: 'closed' }), ctx({ runs: [run({ completedAt: NOW })] }));
  assert.deepEqual(judged, {
    eligible: false,
    status: 'retained',
    reasons: ['closed; run kept until you dismiss it'],
  });
});

test('issuePickupStatus: a dismissed run gives the close back its plain done', () => {
  const v = issuePickupStatus(
    issue({ state: 'closed' }),
    ctx({ runs: [run({ dismissedAt: NOW, outcome: 'judged' })] }),
  );
  assert.deepEqual(v, { eligible: false, status: 'done', reasons: ['closed'] });
});

test('issuePickupStatus: a run at another issue leaves the close alone', () => {
  const v = issuePickupStatus(issue({ state: 'closed' }), ctx({ runs: [run({ issueNumber: 99 })] }));
  assert.deepEqual(v, { eligible: false, status: 'done', reasons: ['closed'] });
});

test('issuePickupStatus: an issue with a live PR reports it', () => {
  const v = issuePickupStatus(issue({ linkedPrNumber: 41 }), ctx({ openPrs: [pr({ number: 41 })] }));
  assert.deepEqual(v, { eligible: false, status: 'has_pr', reasons: ['has open PR #41'] });
});

test('issuePickupStatus: "has open PR" is never claimed for a PR that merged', () => {
  const v = issuePickupStatus(issue({ linkedPrNumber: 41 }), ctx({ openPrs: [pr({ number: 41, merged: true })] }));
  assert.deepEqual(v, { eligible: false, status: 'planning', reasons: ['awaiting a planning agent'] });
});

test('issuePickupStatus: an active task on the origin reports the agent state', () => {
  assert.deepEqual(issuePickupStatus(issue(), ctx({ tasks: [task({ status: 'running' })] })), {
    eligible: false,
    status: 'active',
    reasons: ['agent running'],
  });
  assert.deepEqual(issuePickupStatus(issue(), ctx({ tasks: [task({ status: 'queued' })] })).reasons, ['agent queued']);
  assert.deepEqual(issuePickupStatus(issue(), ctx({ tasks: [task({ status: 'waiting' })] })).reasons, [
    'agent waiting on you',
  ]);
});

test('issuePickupStatus: a finished task on the origin does not count as active', () => {
  const v = issuePickupStatus(issue(), ctx({ tasks: [task({ status: 'done' })] }));
  assert.equal(v.status, 'planning');
});

test('issuePickupStatus: an un-watched issue surfaces as unwatched with the intrinsic reasons', () => {
  const v = issuePickupStatus(
    issue({ labels: ['bug'] }),
    ctx({
      policy: { watchLabel: 'agent-ready', priorityLabels: {}, defaultPriority: 0, investigateLabel: 'investigate' },
    }),
  );
  assert.deepEqual(v, { eligible: false, status: 'unwatched', reasons: ['no watch label "agent-ready"'] });
});

test('issuePickupStatus: the watch tag is the whole gate — no other label overrides it', () => {
  const policy = { watchLabel: 'agent-ready', priorityLabels: {}, defaultPriority: 0, investigateLabel: 'investigate' };
  const both = issuePickupStatus(issue({ labels: ['agent-ready', 'agent-ignore'] }), ctx({ policy }));
  assert.deepEqual(both, { eligible: false, status: 'planning', reasons: ['awaiting a planning agent'] });
  const neither = issuePickupStatus(issue({ labels: ['agent-ignore'] }), ctx({ policy }));
  assert.deepEqual(neither, { eligible: false, status: 'unwatched', reasons: ['no watch label "agent-ready"'] });
});

test('issuePickupStatus: a recent planner attempt puts planning on cooldown', () => {
  const v = issuePickupStatus(
    issue(),
    ctx({ recentDecisions: [...spentAppraisalAttempts(1), dispatched(planOrigin(1), '2026-07-21T00:59:30Z')] }),
  );
  assert.deepEqual(v, { eligible: false, status: 'planning', reasons: ['planning on cooldown'] });
});

test('issuePickupStatus: a planner that spent its attempt cap with no plan surfaces as escalated', () => {
  const attempts = [
    dispatched(planOrigin(1), '2026-07-21T00:00:00Z'),
    dispatched(planOrigin(1), '2026-07-21T00:20:00Z'),
    dispatched(planOrigin(1), '2026-07-21T00:40:00Z'),
  ];
  const v = issuePickupStatus(issue(), ctx({ recentDecisions: [...spentAppraisalAttempts(1), ...attempts] }));
  assert.deepEqual(v, {
    eligible: false,
    status: 'escalated',
    reasons: ['3 planner attempts wrote no plan — escalated to a human'],
  });
});

test('issuePickupStatus: an unimpeded open issue awaits a planning agent', () => {
  const v = issuePickupStatus(issue(), ctx());
  assert.deepEqual(v, { eligible: false, status: 'planning', reasons: ['awaiting a planning agent'] });
});

test('issuePickupStatus: a planner owed while dispatch is paused, or with no capacity, is blocked', () => {
  assert.deepEqual(issuePickupStatus(issue(), ctx({ paused: true })), {
    eligible: false,
    status: 'blocked',
    reasons: ['dispatch paused'],
  });
  assert.deepEqual(issuePickupStatus(issue(), ctx({ headroom: 0 })), {
    eligible: false,
    status: 'blocked',
    reasons: ['no agent capacity'],
  });
});

test('effectivePickupStates folds the in-progress state into the operator list', () => {
  assert.deepEqual(effectivePickupStates({ ...SCHEME, pickupStates: ['Ready'], inProgressState: 'Doing' }), [
    'Ready',
    'Doing',
  ]);
  assert.deepEqual(effectivePickupStates({ ...SCHEME, pickupStates: ['Ready', 'Doing'], inProgressState: 'Doing' }), [
    'Ready',
    'Doing',
  ]);
  assert.equal(effectivePickupStates({ ...SCHEME, pickupStates: ['Ready'], inProgressState: 'Doing' })?.[0], 'Ready');
});

test('effectivePickupStates leaves the gate off: an in-progress state alone is not a pickup list', () => {
  assert.equal(effectivePickupStates({ ...SCHEME, inProgressState: 'Doing' }), undefined);
  assert.deepEqual(effectivePickupStates({ ...SCHEME, pickupStates: [], inProgressState: 'Doing' }), []);
  assert.deepEqual(effectivePickupStates({ ...SCHEME, pickupStates: ['Ready'] }), ['Ready']);
});

test('an item in the in-progress state is still pickup-eligible', () => {
  const policy: IssuePickupPolicy = {
    ...SCHEME,
    pickupStates: ['Ready'],
    inProgressState: 'Doing',
    inReviewState: 'In Review',
  };
  assert.equal(isIssuePickupEligible(issue({ workItemState: 'Doing' }), policy).eligible, true);
  assert.equal(isIssuePickupEligible(issue({ workItemState: 'Ready' }), policy).eligible, true);
  assert.deepEqual(isIssuePickupEligible(issue({ workItemState: 'In Review' }), policy).reasons, ['in review']);
  assert.deepEqual(isIssuePickupEligible(issue({ workItemState: 'New' }), policy).reasons, [
    'state "New" not in pickup states',
  ]);
});
