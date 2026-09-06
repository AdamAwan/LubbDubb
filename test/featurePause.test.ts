import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleDispatcher } from '../src/dispatcher/ruleDispatcher.js';
import type { DispatchContext } from '../src/dispatcher/dispatcher.js';
import { issuePickupStatus, type IssuePickupContext } from '../src/dispatcher/issuePickup.js';
import { buildFeatureBoard } from '../src/features/featureBoard.js';
import { pausedIssueNumbers, goalPauseOrigin } from '../src/goalPause.js';
import { DEFAULT_COOLDOWN } from '../src/dispatcher/dispatchCooldown.js';
import { Store } from '../src/store/store.js';
import type { GoalPause, Issue } from '../src/types.js';
import type { MirroredTicket } from '../src/store/tickets.js';
import { pastTheFunnel } from './support/plans.js';

const NOW = '2026-09-06T12:00:00.000Z';
const WATCH = 'lubbdubb-watch';

function feature(): Issue {
  return {
    id: 'i900',
    number: 900,
    title: 'Environments',
    body: '',
    labels: [WATCH],
    state: 'open',
    linkedPrNumber: null,
    issueType: 'Feature',
    children: [{ number: 12, title: 'Add the thing', issueType: 'User Story', workItemState: 'Active', state: 'open' }],
  };
}

function story(): Issue {
  return {
    id: 'i12',
    number: 12,
    title: 'Add the thing',
    body: 'please add the thing',
    labels: [WATCH],
    state: 'open',
    linkedPrNumber: null,
    issueType: 'User Story',
    parent: { number: 900, title: 'Environments', issueType: 'Feature', workItemState: 'Active', state: 'open' },
  };
}

function ctx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    world: { takenAt: NOW, pullRequests: [], issues: [feature(), story()] },
    plans: [],
    tasks: [],
    agents: [],
    openEscalations: [],
    queuedJobs: [],
    recentDecisions: pastTheFunnel(12),
    agentHeadroom: 3,
    ...over,
  };
}

function dispatcher(): RuleDispatcher {
  return new RuleDispatcher({ watchLabel: WATCH, containerTypes: ['Feature', 'Epic'] });
}

function origins(actions: { type: string; originRef?: string | null }[]): string[] {
  return actions.filter((a) => a.type.startsWith('dispatch_')).map((a) => a.originRef ?? '');
}

const pause = (number: number): GoalPause => ({ originRef: goalPauseOrigin(number), since: NOW });

test('pausing a Feature withholds the work under it, and resuming hands it straight back', async () => {
  const before = await dispatcher().decide(ctx());
  assert.ok(
    origins(before.actions).some((o) => o.startsWith('issue:12')),
    'the story is ordinary work while nothing is paused',
  );

  const paused = await dispatcher().decide(ctx({ goalPauses: [pause(900)] }));
  assert.deepEqual(
    origins(paused.actions).filter((o) => o.startsWith('issue:12')),
    [],
    'a pause on the parent reaches the child, which is where the work actually is',
  );
  assert.deepEqual(
    (paused.upcoming ?? []).filter((u) => u.origin.startsWith('issue:12')),
    [],
    'and it is not queued behind headroom either — a pause withholds, it does not defer',
  );

  const resumed = await dispatcher().decide(ctx({ goalPauses: [] }));
  assert.deepEqual(
    origins(resumed.actions),
    origins(before.actions),
    'the tags were never touched, so resuming restores exactly the work that was there',
  );
});

test('the pause set is read every cycle, never snapshotted at construction', async () => {
  const d = dispatcher();
  assert.deepEqual(origins(await d.decide(ctx({ goalPauses: [pause(900)] })).then((r) => r.actions)), []);
  assert.ok(
    origins(await d.decide(ctx()).then((r) => r.actions)).some((o) => o.startsWith('issue:12')),
    'the same dispatcher instance sees the pause lifted',
  );
});

test('a pause reads as its own standing, never as "nobody watched this"', () => {
  const base: IssuePickupContext = {
    policy: { watchLabel: WATCH, priorityLabels: {}, defaultPriority: 0, containerTypes: ['Feature'] },
    cooldown: DEFAULT_COOLDOWN,
    now: NOW,
    tasks: [],
    recentDecisions: pastTheFunnel(12),
    openPrs: [],
    headroom: 3,
    paused: false,
  };

  assert.equal(issuePickupStatus(story(), base).status, 'eligible');

  const held = issuePickupStatus(story(), {
    ...base,
    policy: { ...base.policy, pausedIssues: new Set([12]) },
  });
  assert.equal(held.status, 'paused', 'not "unwatched" — the operator opted in and then said "not now"');
  assert.equal(held.eligible, false);
  assert.match(held.reasons[0] ?? '', /paused/);
});

test('the cascade covers descendants, and an issue the world no longer holds still pauses itself', () => {
  const world = [feature(), story()];
  assert.deepEqual([...pausedIssueNumbers([pause(900)], world, ['Feature'])], [900, 12]);
  assert.deepEqual([...pausedIssueNumbers([pause(404)], world, ['Feature'])], [404], 'no hierarchy, still paused');
  assert.deepEqual([...pausedIssueNumbers([], world, ['Feature'])], []);
});

test('a paused Feature keeps its place on the board and sinks below the rest', () => {
  const ticket = (number: number, parent: number): MirroredTicket => ({
    number,
    title: `Item ${number}`,
    labels: [WATCH],
    state: 'open',
    workItemState: 'Active',
    url: null,
    createdAt: NOW,
    changedAt: NOW,
    firstSeenAt: NOW,
    tracking: 'live',
    issueType: 'User Story',
    parent: { number: parent, title: `Feature ${parent}` },
    lastReadAt: null,
  });

  const board = buildFeatureBoard({
    items: [ticket(1, 900), ticket(2, 901)],
    outcomes: new Map(),
    costs: new Map(),
    featureSlots: new Map(),
    sequences: new Map(),
    running: new Map(),
    deliveries: [],
    shortfalls: [],
    escalations: [],
    reach: [],
    landings: [],
    environments: [],
    containerTypes: ['Feature', 'Epic'],
    watchLabel: WATCH,
    summaries: new Map(),
    standingKeys: new Map(),
    pauses: new Map([['issue:900', pause(900)]]),
  });

  assert.deepEqual(
    board.features.map((f) => f.number),
    [901, 900],
    'the paused Feature is still drawn — it sinks, it does not disappear',
  );
  assert.equal(board.features.find((f) => f.number === 900)?.paused?.since, NOW);
  assert.equal(board.features.find((f) => f.number === 901)?.paused, null);
});

test('a pause is a row of the fleet’s own, and survives a restart', () => {
  const store = new Store(':memory:');
  assert.deepEqual(store.listGoalPauses(), []);

  store.setGoalPause('issue:900', true);
  const since = store.listGoalPauses()[0]?.since;
  assert.equal(store.listGoalPauses().length, 1);

  store.setGoalPause('issue:900', true);
  assert.equal(store.listGoalPauses()[0]?.since, since, 'pausing twice is one statement, not a reset clock');

  store.setGoalPause('issue:900', false);
  assert.deepEqual(store.listGoalPauses(), []);
  store.close?.();
});
