import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issuePriority, isIssuePickupEligible, issuePickupStatus } from '../src/dispatcher/issuePickup.js';
import type { IssuePickupPolicy, IssuePickupContext } from '../src/dispatcher/issuePickup.js';
import type { Decision, Issue, Task } from '../src/types.js';

const SCHEME: IssuePickupPolicy = {
  priorityLabels: { 'priority:high': 3, 'priority:medium': 2, 'priority:low': 1 },
  defaultPriority: 2,
};

function issue(over: Partial<Issue> = {}): Issue {
  return { id: 'i', number: 1, title: 'X', body: '', labels: [], state: 'open', linkedPrNumber: null, ...over };
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
  const policy: IssuePickupPolicy = { priorityLabels: {}, defaultPriority: 0 };
  assert.deepEqual(isIssuePickupEligible(issue({ labels: [] }), policy), { eligible: true, reasons: [] });
  assert.deepEqual(isIssuePickupEligible(issue({ labels: ['bug'] }), policy), { eligible: true, reasons: [] });
});

test('isIssuePickupEligible: with a pickup label only labelled issues are eligible', () => {
  const policy: IssuePickupPolicy = { watchLabel: 'agent-ready', priorityLabels: {}, defaultPriority: 0 };
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
  };
  // The viewer added the tag → eligible.
  assert.equal(
    isIssuePickupEligible(issue({ labels: ['agent-ready'], labelsAddedByViewer: ['agent-ready'] }), policy).eligible,
    true,
  );
  // The tag is present but someone else added it → not eligible (the abuse case).
  assert.deepEqual(isIssuePickupEligible(issue({ labels: ['agent-ready'], labelsAddedByViewer: [] }), policy), {
    eligible: false,
    reasons: ['watch label "agent-ready" not added by you'],
  });
  // Authorship unknown (provider didn't populate it) → not eligible, fail closed.
  assert.deepEqual(isIssuePickupEligible(issue({ labels: ['agent-ready'] }), policy), {
    eligible: false,
    reasons: ['watch label "agent-ready" not added by you'],
  });
});

test('isIssuePickupEligible: requireOwnLabel is ignored when no pickup label is set', () => {
  const policy: IssuePickupPolicy = { requireOwnLabel: true, priorityLabels: {}, defaultPriority: 0 };
  assert.equal(isIssuePickupEligible(issue({ labels: ['bug'] }), policy).eligible, true);
});

test('isIssuePickupEligible: state gate only picks up items in an allowed workItemState', () => {
  const policy: IssuePickupPolicy = { priorityLabels: {}, defaultPriority: 0, pickupStates: ['Ready', 'Doing'] };
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
    pickupStates: ['Ready'],
    inReviewState: 'In Review',
  };
  assert.deepEqual(isIssuePickupEligible(issue({ workItemState: 'In Review' }), policy), {
    eligible: false,
    reasons: ['in review'],
  });
});

test('isIssuePickupEligible: the state gate is a no-op for issues with no workItemState', () => {
  // GitHub / fake issues carry no native state, so a state gate must not exclude them.
  const policy: IssuePickupPolicy = { priorityLabels: {}, defaultPriority: 0, pickupStates: ['Ready'] };
  assert.equal(isIssuePickupEligible(issue({ workItemState: undefined }), policy).eligible, true);
});

test('isIssuePickupEligible: an empty pickupStates list leaves the state gate off', () => {
  const policy: IssuePickupPolicy = { priorityLabels: {}, defaultPriority: 0, pickupStates: [] };
  assert.equal(isIssuePickupEligible(issue({ workItemState: 'Anything' }), policy).eligible, true);
});

test('isIssuePickupEligible: the state and label gates both report their reasons together', () => {
  const policy: IssuePickupPolicy = {
    watchLabel: 'agent-ready',
    priorityLabels: {},
    defaultPriority: 0,
    pickupStates: ['Ready'],
  };
  // Right state, right label → eligible.
  assert.equal(
    isIssuePickupEligible(issue({ workItemState: 'Ready', labels: ['agent-ready'] }), policy).eligible,
    true,
  );
  // Right state, missing label → not eligible.
  assert.equal(isIssuePickupEligible(issue({ workItemState: 'Ready', labels: [] }), policy).eligible, false);
  // Wrong state *and* missing label → both reasons, state first.
  assert.deepEqual(isIssuePickupEligible(issue({ workItemState: 'New', labels: [] }), policy), {
    eligible: false,
    reasons: ['state "New" not in pickup states', 'no watch label "agent-ready"'],
  });
});

// -- issuePickupStatus: the combined per-item verdict -------------------------

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

/** A dispatch decision for `origin`, executed at `createdAt`. */
function dispatched(origin: string, createdAt: string): Decision {
  return {
    id: `d_${createdAt}`,
    cycleId: 'c',
    outcome: 'executed',
    detail: '',
    rule: null,
    createdAt,
    action: { type: 'dispatch_code_agent', reason: 'r', originRef: origin },
  };
}

function ctx(over: Partial<IssuePickupContext> = {}): IssuePickupContext {
  return {
    policy: { priorityLabels: {}, defaultPriority: 0 },
    cooldown: { maxAttempts: 3, cooldownMs: 60_000 },
    now: NOW,
    tasks: [],
    recentDecisions: [],
    headroom: 2,
    paused: false,
    ...over,
  };
}

test('issuePickupStatus: a closed issue is done', () => {
  const v = issuePickupStatus(issue({ state: 'closed' }), ctx());
  assert.deepEqual(v, { eligible: false, status: 'done', reasons: ['closed'] });
});

test('issuePickupStatus: a linked issue reports its PR', () => {
  const v = issuePickupStatus(issue({ linkedPrNumber: 41 }), ctx());
  assert.deepEqual(v, { eligible: false, status: 'has_pr', reasons: ['has open PR #41'] });
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
  assert.equal(v.status, 'eligible');
});

test('issuePickupStatus: an un-watched issue surfaces as unwatched with the intrinsic reasons', () => {
  const v = issuePickupStatus(
    issue({ labels: ['bug'] }),
    ctx({ policy: { watchLabel: 'agent-ready', priorityLabels: {}, defaultPriority: 0 } }),
  );
  assert.deepEqual(v, { eligible: false, status: 'unwatched', reasons: ['no watch label "agent-ready"'] });
});

test('issuePickupStatus: an ignore-tagged issue surfaces as ignored (ignore wins over the watch tag)', () => {
  const policy = { watchLabel: 'agent-ready', ignoreLabel: 'agent-ignore', priorityLabels: {}, defaultPriority: 0 };
  const v = issuePickupStatus(issue({ labels: ['agent-ready', 'agent-ignore'] }), ctx({ policy }));
  assert.deepEqual(v, { eligible: false, status: 'ignored', reasons: ['ignored ("agent-ignore")'] });
});

test('issuePickupStatus: a recent attempt puts the issue on cooldown', () => {
  const v = issuePickupStatus(issue(), ctx({ recentDecisions: [dispatched('issue:1', '2026-07-21T00:59:30Z')] }));
  assert.equal(v.status, 'cooldown');
  assert.equal(v.eligible, false);
  assert.deepEqual(v.reasons, ['on cooldown after 1 attempt']);
});

test('issuePickupStatus: the spent attempt cap surfaces as escalated', () => {
  const attempts = [
    dispatched('issue:1', '2026-07-21T00:00:00Z'),
    dispatched('issue:1', '2026-07-21T00:20:00Z'),
    dispatched('issue:1', '2026-07-21T00:40:00Z'),
  ];
  const v = issuePickupStatus(issue(), ctx({ recentDecisions: attempts }));
  assert.equal(v.status, 'escalated');
  assert.deepEqual(v.reasons, ['3 failed attempts — escalated to a human']);
});

test('issuePickupStatus: paused dispatch blocks pickup', () => {
  const v = issuePickupStatus(issue(), ctx({ paused: true, headroom: 0 }));
  assert.deepEqual(v, { eligible: false, status: 'blocked', reasons: ['dispatch paused'] });
});

test('issuePickupStatus: no headroom blocks pickup', () => {
  const v = issuePickupStatus(issue(), ctx({ headroom: 0 }));
  assert.deepEqual(v, { eligible: false, status: 'blocked', reasons: ['no agent capacity'] });
});

test('issuePickupStatus: an unimpeded open issue is eligible', () => {
  const v = issuePickupStatus(issue(), ctx());
  assert.deepEqual(v, { eligible: true, status: 'eligible', reasons: [] });
});
