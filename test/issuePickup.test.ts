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
import { pastTheFunnel } from './support/plans.js';

const SCHEME: IssuePickupPolicy = {
  priorityLabels: { 'priority:high': 3, 'priority:medium': 2, 'priority:low': 1 },
  defaultPriority: 2,
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

// -- openPrForIssue: the "does this issue still have a PR open?" predicate -----

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
  // The `linkedPrNumber` from the timeline is sticky, so this is the whole point:
  // an issue whose PR merged without closing it must re-enter pickup.
  assert.equal(openPrForIssue(issue({ linkedPrNumber: 41 }), [pr({ number: 41, merged: true })]), null);
});

test('openPrForIssue: an unwatched PR still parks its issue', () => {
  // The harness hides untagged PRs from the dispatch world, so callers pass them
  // back in — otherwise "absent" reads as "merged" and a second agent lands on the
  // very branch nobody opted in.
  const hidden = pr({ number: 41, branch: 'issue/1', labels: [] });
  assert.equal(openPrForIssue(issue({ linkedPrNumber: 41 }), [hidden])?.number, 41);
});

test('issueBranch is the branch rule `issue-pickup` dispatches onto', () => {
  assert.equal(issueBranch(12), 'issue/12');
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
    policy: { priorityLabels: {}, defaultPriority: 0 },
    cooldown: { maxAttempts: 3, cooldownMs: 60_000 },
    now: NOW,
    tasks: [],
    // The funnel has failed open on this issue, which is the one arm pickup still
    // works: it is unconditional, so an issue it is still working — or has planned
    // — is one pickup is narrowed away from. Every case below is about what
    // happens after that.
    recentDecisions: pastTheFunnel(1),
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

// The other half of #234 in the chip: a close is the tracker's answer, and the run
// it does not end is still something the operator has to dismiss.
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

// A run on a *different* goal must not answer for this one.
test('issuePickupStatus: a run at another issue leaves the close alone', () => {
  const v = issuePickupStatus(issue({ state: 'closed' }), ctx({ runs: [run({ issueNumber: 99 })] }));
  assert.deepEqual(v, { eligible: false, status: 'done', reasons: ['closed'] });
});

test('issuePickupStatus: an issue with a live PR reports it', () => {
  const v = issuePickupStatus(issue({ linkedPrNumber: 41 }), ctx({ openPrs: [pr({ number: 41 })] }));
  assert.deepEqual(v, { eligible: false, status: 'has_pr', reasons: ['has open PR #41'] });
});

test('issuePickupStatus: "has open PR" is never claimed for a PR that merged', () => {
  // The reason said "open" without checking; the issue is eligible again instead.
  const v = issuePickupStatus(issue({ linkedPrNumber: 41 }), ctx({ openPrs: [pr({ number: 41, merged: true })] }));
  assert.deepEqual(v, { eligible: true, status: 'eligible', reasons: [] });
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

test('issuePickupStatus: the watch tag is the whole gate — no other label overrides it', () => {
  // The retired `-ignore` tag was the third state and is read nowhere now. An item
  // carrying it and the watch tag is watched: the operator's live answer is the tag
  // that is there, not the one left over from before.
  const policy = { watchLabel: 'agent-ready', priorityLabels: {}, defaultPriority: 0 };
  const both = issuePickupStatus(issue({ labels: ['agent-ready', 'agent-ignore'] }), ctx({ policy }));
  assert.deepEqual(both, { eligible: true, status: 'eligible', reasons: [] });
  const neither = issuePickupStatus(issue({ labels: ['agent-ignore'] }), ctx({ policy }));
  assert.deepEqual(neither, { eligible: false, status: 'unwatched', reasons: ['no watch label "agent-ready"'] });
});

test('issuePickupStatus: a recent attempt puts the issue on cooldown', () => {
  const v = issuePickupStatus(
    issue(),
    ctx({ recentDecisions: [...pastTheFunnel(1), dispatched('issue:1', '2026-07-21T00:59:30Z')] }),
  );
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
  const v = issuePickupStatus(issue(), ctx({ recentDecisions: [...pastTheFunnel(1), ...attempts] }));
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

// --------------------------------------------------------------------------
// The in-progress state, folded into the pickup set.
// --------------------------------------------------------------------------

test('effectivePickupStates folds the in-progress state into the operator list', () => {
  assert.deepEqual(effectivePickupStates({ ...SCHEME, pickupStates: ['Ready'], inProgressState: 'Doing' }), [
    'Ready',
    'Doing',
  ]);
  // The operator listing it themselves — today's documented arrangement — is not
  // a second entry.
  assert.deepEqual(effectivePickupStates({ ...SCHEME, pickupStates: ['Ready', 'Doing'], inProgressState: 'Doing' }), [
    'Ready',
    'Doing',
  ]);
  // The first pickup state is where `work-item-back-to-pickup` returns an item:
  // the fold appends, so it cannot become the state the harness writes.
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
  // The whole point of the fold: an agent that died without opening a PR left the
  // item in "Doing", and it must be picked up again rather than stranded there by
  // the harness's own write.
  assert.equal(isIssuePickupEligible(issue({ workItemState: 'Doing' }), policy).eligible, true);
  assert.equal(isIssuePickupEligible(issue({ workItemState: 'Ready' }), policy).eligible, true);
  // And the states outside both lists are refused exactly as before.
  assert.deepEqual(isIssuePickupEligible(issue({ workItemState: 'In Review' }), policy).reasons, ['in review']);
  assert.deepEqual(isIssuePickupEligible(issue({ workItemState: 'New' }), policy).reasons, [
    'state "New" not in pickup states',
  ]);
});
