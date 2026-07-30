import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliveryHold, deliverySignalQuery } from '../src/delivery/delivery.js';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import { issuePickupStatus } from '../src/dispatcher/issuePickup.js';
import { DEFAULT_COOLDOWN } from '../src/dispatcher/dispatchCooldown.js';
import type { Issue, IssueDelivery, WorldEvent } from '../src/types.js';

// The pure hold predicate: what a `delivered` verdict holds, and what ends it.
// No store, no world snapshot — the two arms are decidable from a row, an issue
// and a list of transitions, which is what lets the rule and the cockpit chip
// ask the same question and get the same answer.

function delivery(over: Partial<IssueDelivery> = {}): IssueDelivery {
  return {
    originRef: 'issue:12',
    summary: 'PR #40 merged and covers every acceptance criterion',
    by: 'assessor',
    agentId: 'a1',
    taskId: 't1',
    decidedAt: '2026-07-28T10:00:00.000Z',
    updatedAt: '2026-07-28T10:00:00.000Z',
    ...over,
  };
}

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i12',
    number: 12,
    title: 'Add the thing',
    body: 'please',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    ...over,
  };
}

function event(over: Partial<WorldEvent> = {}): WorldEvent {
  return {
    id: 'e1',
    kind: 'issue_linked',
    ref: 'issue:12',
    summary: 'Issue #12 linked to PR #41',
    createdAt: '2026-07-28T11:00:00.000Z',
    ...over,
  };
}

test('no verdict holds nothing', () => {
  assert.equal(deliveryHold(null, issue()), null);
});

test('a standing verdict holds, and names who cast it', () => {
  const held = deliveryHold(delivery(), issue());
  assert.ok(held, 'a standing verdict with no signal and no state change still holds');
  assert.match(held, /the assessor marked it delivered/);
  assert.match(held, /covers every acceptance criterion/, 'the summary is quoted so the reason is reviewable');

  const byOperator = deliveryHold(delivery({ by: 'operator' }), issue());
  assert.match(byOperator ?? '', /^you marked it delivered/);
});

// -- arm 1: the tracker move -------------------------------------------------

test('the operator moving the ticket back to a pickup state clears it', () => {
  const held = deliveryHold(delivery(), issue({ workItemState: 'Ready' }), { pickupStates: ['Ready', 'Doing'] });
  assert.equal(held, null, 'moving the ticket in the tracker is the override');
});

test('the review state is not a pickup state, so the verdict still stands there', () => {
  const held = deliveryHold(delivery(), issue({ workItemState: 'In Review' }), { pickupStates: ['Ready', 'Doing'] });
  assert.ok(held);
});

test('a provider with no work-item states leaves arm 1 unable to fire', () => {
  // GitHub: `workItemState` is undefined, so only the signal arm can clear it.
  assert.ok(deliveryHold(delivery(), issue(), { pickupStates: ['Ready'] }));
  assert.ok(deliveryHold(delivery(), issue({ workItemState: 'Ready' })), 'no configured pickup states, no arm 1');
});

// -- arm 2: world signal -----------------------------------------------------

test('any transition on the issue after the verdict clears it', () => {
  assert.equal(deliveryHold(delivery(), issue(), { signals: [event()] }), null);
  assert.equal(
    deliveryHold(delivery(), issue(), { signals: [event({ kind: 'issue_opened', summary: 'reopened' })] }),
    null,
    'any kind counts — a filter here would be a second opinion about which changes matter',
  );
});

test('a transition older than the verdict does not clear it', () => {
  const stale = event({ createdAt: '2026-07-28T09:00:00.000Z' });
  assert.ok(deliveryHold(delivery(), issue(), { signals: [stale] }));
});

test('a transition on a different issue does not clear it', () => {
  const elsewhere = event({ ref: 'issue:13' });
  assert.ok(deliveryHold(delivery(), issue(), { signals: [elsewhere] }));
  assert.ok(deliveryHold(delivery(), issue(), { signals: [event({ ref: null })] }), 'a global event names no item');
});

test('there is no timer arm — an untouched issue is held indefinitely', () => {
  // The asymmetry with `proposalHold`'s settle window is deliberate: an accepted
  // act waits on the world to reflect something done (a duration), a delivered
  // issue waits on it to become something else (an event).
  const ancient = delivery({ decidedAt: '2020-01-01T00:00:00.000Z' });
  assert.ok(deliveryHold(ancient, issue(), { signals: [] }));
});

// -- the query ---------------------------------------------------------------

test('the signal query is null when nothing stands, so no read happens at all', () => {
  assert.equal(deliverySignalQuery([]), null);
});

test('the query names every held issue and the oldest verdict', () => {
  const q = deliverySignalQuery([
    delivery({ originRef: 'issue:12', decidedAt: '2026-07-28T10:00:00.000Z' }),
    delivery({ originRef: 'issue:13', decidedAt: '2026-07-27T10:00:00.000Z' }),
  ]);
  assert.ok(q);
  assert.equal(q.since, '2026-07-27T10:00:00.000Z', 'bounded by time, so the oldest verdict sets the window');
  assert.deepEqual(q.refs.sort(), ['issue:12', 'issue:13']);
});

test('an off-vocabulary origin is never expired by a signal it cannot be matched against', () => {
  assert.equal(deliverySignalQuery([delivery({ originRef: 'job:7' })]), null);
  assert.ok(
    deliveryHold(delivery({ originRef: 'job:7' }), issue(), { signals: [event({ ref: 'job:7' })] }),
    'the ask and the match narrow identically, which is why one private mapping owns both',
  );
});

// -- the gate, asked in both places off the one predicate ---------------------

test('a standing verdict stops rule 4, and lifting it lets pickup through', async () => {
  const world = {
    takenAt: '2026-07-28T12:00:00.000Z',
    pullRequests: [],
    issues: [issue()],
    stories: [],
  };
  // The retrospective is pinned off: this test is about rule 4 standing down for a
  // parked issue, and rule 3h legitimately writes a delivered goal up (covered in
  // test/retrospective.test.ts). Leaving it on would assert two rules at once.
  const d = new RuleDispatcher({}, {}, undefined, 'main', {}, {}, {}, {}, { enabled: false });

  const parked = await d.decide({
    world,
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: [],
    steeringPriorities: [],
    agentHeadroom: 3,
    deliveries: [delivery()],
  });
  // Idleness is still a decision, so the cycle records a no_op — what must not be
  // there is a dispatch.
  assert.deepEqual(
    parked.actions.map((a) => a.type),
    ['no_op'],
    'the issue is parked, so no pickup agent',
  );

  // The same world with a transition after the verdict: the park is over.
  const released = await d.decide({
    world,
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: [],
    steeringPriorities: [],
    agentHeadroom: 3,
    deliveries: [delivery()],
    deliverySignals: [event()],
  });
  assert.equal(released.actions[0]?.type, 'dispatch_code_agent');
  assert.equal((released.actions[0] as { originRef: string }).originRef, 'issue:12');
});

test('the chip and the rule answer the same question', () => {
  const base = {
    policy: { priorityLabels: {}, defaultPriority: 0 },
    cooldown: DEFAULT_COOLDOWN,
    now: '2026-07-28T12:00:00.000Z',
    tasks: [],
    recentDecisions: [],
    openPrs: [],
    headroom: 3,
    paused: false,
  };

  const parked = issuePickupStatus(issue(), { ...base, deliveries: [delivery()] });
  assert.equal(parked.eligible, false);
  assert.equal(parked.status, 'delivered');
  assert.match(parked.reasons[0] ?? '', /the assessor marked it delivered/);

  const released = issuePickupStatus(issue(), { ...base, deliveries: [delivery()], deliverySignals: [event()] });
  assert.equal(released.eligible, true, 'the same signal that un-holds the rule un-holds the chip');
});

test('an open PR or a live agent outranks the park — the honest reason wins', () => {
  const base = {
    policy: { priorityLabels: {}, defaultPriority: 0 },
    cooldown: DEFAULT_COOLDOWN,
    now: '2026-07-28T12:00:00.000Z',
    tasks: [],
    recentDecisions: [],
    headroom: 3,
    paused: false,
    deliveries: [delivery()],
  };

  // A delivered issue that somehow has an open PR belongs to the PR rules, and
  // saying "delivered" would send the operator looking in the wrong place.
  const withPr = issuePickupStatus(issue(), {
    ...base,
    openPrs: [{ id: 'p', number: 40, title: 'X', branch: 'issue/12', ciStatus: 'passing', unresolvedComments: [] }],
  });
  assert.equal(withPr.status, 'has_pr');
});
