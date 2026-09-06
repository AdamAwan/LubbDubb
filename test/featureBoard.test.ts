import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFeatureBoard,
  FEATURE_BRIEFING_ROWS,
  FEATURE_CHILDREN,
  FEATURE_LANDINGS,
} from '../src/features/featureBoard.js';
import { featureBoardOn } from '../src/features/featureBoard.js';
import type { MirroredTicket } from '../src/store/tickets.js';
import type { Escalation, GoalEnvironmentReach, GoalLanding, IssueDelivery, IssueShortfall } from '../src/types.js';

const WATCH = 'lubbdubb-watch';

function item(over: Partial<MirroredTicket> & { number: number }): MirroredTicket {
  return {
    title: `Item ${over.number}`,
    labels: [WATCH],
    state: 'open',
    workItemState: 'Active',
    url: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    changedAt: '2026-01-01T00:00:00.000Z',
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    tracking: 'live',
    issueType: 'User Story',
    parent: { number: 900, title: 'Environments' },
    lastReadAt: null,
    ...over,
  };
}

function build(over: Partial<Parameters<typeof buildFeatureBoard>[0]> = {}) {
  return buildFeatureBoard({
    items: [],
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
    ...over,
  });
}

test('a Feature counts its children by the verdicts the harness already reached', () => {
  const board = build({
    items: [item({ number: 1 }), item({ number: 2 }), item({ number: 3 }), item({ number: 4 })],
    outcomes: new Map([
      [1, 'delivered'],
      [2, 'fell short'],
      [3, 'concluded'],
    ]),
  });

  const feature = board.features[0];
  assert.ok(feature);
  assert.equal(feature.number, 900);
  assert.equal(feature.title, 'Environments');
  assert.deepEqual(feature.counts, {
    delivered: 1,
    inFlight: 0,
    queued: 1,
    fellShort: 1,
    settled: 1,
    unwatched: 0,
    total: 4,
  });
});

test('an unwatched child is unseen, never queued — the fleet has not looked at it', () => {
  const board = build({ items: [item({ number: 1, labels: [] }), item({ number: 2 })] });

  const feature = board.features[0];
  assert.ok(feature);
  assert.equal(feature.counts.unwatched, 1);
  assert.equal(feature.counts.queued, 1);
  assert.equal(feature.children.find((c) => c.number === 1)?.standing, 'unwatched');
});

test('a live run outranks the verdict of the last attempt — the board is a reading of now', () => {
  const board = build({
    items: [item({ number: 1 })],
    outcomes: new Map([[1, 'fell short']]),
    running: new Map([[1, '2026-02-01T00:00:00.000Z']]),
  });

  const child = board.features[0]?.children[0];
  assert.ok(child);
  assert.equal(child.standing, 'inFlight');
  assert.equal(child.outcome, 'fell short');
});

test('a container is never its own child', () => {
  const board = build({
    items: [
      item({ number: 1 }),
      item({ number: 2, issueType: 'Feature', parent: { number: 900, title: 'Environments' } }),
      item({ number: 3, issueType: 'epic', parent: { number: 900, title: 'Environments' } }),
    ],
  });

  assert.equal(board.features[0]?.counts.total, 1);
});

test('a flat tracker has no containers at all, so nothing is mistaken for one', () => {
  const board = build({ items: [item({ number: 1, issueType: null, parent: null })] });

  assert.equal(board.features.length, 0);
  assert.equal(board.orphans?.counts.total, 1);
});

test('an unresolved parent link is neither a Feature’s nor an orphan’s', () => {
  const board = build({
    items: [item({ number: 1 }), item({ number: 2, parent: null }), item({ number: 3, parent: undefined })],
  });

  assert.equal(board.features[0]?.counts.total, 1);
  assert.equal(board.orphans?.counts.total, 1);
  assert.equal(board.unresolved, 1);
});

test('no orphan bucket at all where every item has a parent', () => {
  assert.equal(build({ items: [item({ number: 1 })] }).orphans, null);
});

test('spend is null where the fleet never ran, and zero only where it ran for nothing', () => {
  assert.equal(build({ items: [item({ number: 1 })] }).features[0]?.costUsd, null);

  const measured = build({ items: [item({ number: 1 }), item({ number: 2 })], costs: new Map([[1, 0]]) });
  assert.equal(measured.features[0]?.costUsd, 0);

  const spent = build({
    items: [item({ number: 1 }), item({ number: 2 })],
    costs: new Map([
      [1, 1.005],
      [2, 2.5],
    ]),
  });
  assert.equal(spent.features[0]?.costUsd, 3.51);
});

function reachRow(
  number: number,
  status: GoalEnvironmentReach['status'],
): { goalRef: string; environments: GoalEnvironmentReach[] } {
  return {
    goalRef: `issue:${number}`,
    environments: [{ environment: 'prod', status, landed: 0, total: 1, at: null, opens: [] }],
  };
}

test('a Feature’s reach folds its goals’ the way a goal folds its landings', () => {
  const items = [item({ number: 1 }), item({ number: 2 })];

  const all = build({ items, environments: ['prod'], reach: [reachRow(1, 'reached'), reachRow(2, 'reached')] });
  assert.equal(all.features[0]?.reach[0]?.status, 'reached');
  assert.deepEqual(
    { goals: all.features[0]?.reach[0]?.goals, total: all.features[0]?.reach[0]?.total },
    { goals: 2, total: 2 },
  );

  const some = build({ items, environments: ['prod'], reach: [reachRow(1, 'reached'), reachRow(2, 'absent')] });
  assert.equal(some.features[0]?.reach[0]?.status, 'partial');
});

test('unknown never folds to absent, one tier up as much as one tier down', () => {
  const board = build({
    items: [item({ number: 1 }), item({ number: 2 })],
    environments: ['prod'],
    reach: [reachRow(1, 'absent'), reachRow(2, 'unknown')],
  });
  assert.equal(board.features[0]?.reach[0]?.status, 'unknown');

  const half = build({
    items: [item({ number: 1 }), item({ number: 2 })],
    environments: ['prod'],
    reach: [reachRow(1, 'absent'), reachRow(2, 'partial')],
  });
  assert.equal(half.features[0]?.reach[0]?.status, 'unknown');
});

test('a goal with nothing merged is not counted as absent everywhere', () => {
  const board = build({
    items: [item({ number: 1 }), item({ number: 2 })],
    environments: ['prod'],
    reach: [reachRow(1, 'reached')],
  });
  assert.deepEqual(board.features[0]?.reach[0], { environment: 'prod', status: 'reached', goals: 1, total: 1 });
});

test('no environments configured means no reach column at all', () => {
  assert.deepEqual(build({ items: [item({ number: 1 })] }).features[0]?.reach, []);
});

test('the last landing is the newest under any of the Feature’s goals', () => {
  const landings: GoalLanding[] = [
    { prNumber: 1, goalRef: 'issue:1', sha: 'a', recordedAt: '2026-02-01T00:00:00.000Z' },
    { prNumber: 2, goalRef: 'issue:2', sha: 'b', recordedAt: '2026-03-01T00:00:00.000Z' },
    { prNumber: 3, goalRef: 'issue:99', sha: 'c', recordedAt: '2026-04-01T00:00:00.000Z' },
  ];
  const board = build({ items: [item({ number: 1 }), item({ number: 2 })], landings });

  assert.equal(board.features[0]?.lastLandingAt, '2026-03-01T00:00:00.000Z');
  assert.equal(build({ items: [item({ number: 1 })] }).features[0]?.lastLandingAt, null);
});

test('the landings are quoted newest first, each carrying its goal, and cut at FEATURE_LANDINGS', () => {
  const landings: GoalLanding[] = [
    { prNumber: 10, goalRef: 'issue:1', sha: 'a', recordedAt: '2026-02-01T00:00:00.000Z' },
    { prNumber: 30, goalRef: 'issue:2', sha: 'c', recordedAt: '2026-04-01T00:00:00.000Z' },
    { prNumber: 20, goalRef: 'issue:1', sha: 'b', recordedAt: '2026-03-01T00:00:00.000Z' },
    { prNumber: 99, goalRef: 'issue:99', sha: 'z', recordedAt: '2026-05-01T00:00:00.000Z' },
  ];
  const board = build({ items: [item({ number: 1 }), item({ number: 2 })], landings });

  assert.deepEqual(board.features[0]?.landings, [
    { goal: 2, prNumber: 30, at: '2026-04-01T00:00:00.000Z' },
    { goal: 1, prNumber: 20, at: '2026-03-01T00:00:00.000Z' },
    { goal: 1, prNumber: 10, at: '2026-02-01T00:00:00.000Z' },
  ]);

  const many: GoalLanding[] = Array.from({ length: FEATURE_LANDINGS + 5 }, (_, i) => ({
    prNumber: i + 1,
    goalRef: 'issue:1',
    sha: `s${i}`,
    recordedAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
  }));
  const busy = build({ items: [item({ number: 1 })], landings: many });
  assert.equal(busy.features[0]?.landings.length, FEATURE_LANDINGS);
  assert.equal(busy.features[0]?.landings[0]?.prNumber, FEATURE_LANDINGS + 5);
  assert.equal(busy.features[0]?.landings.at(-1)?.prNumber, 6);
});

test('the orphan bucket carries its own landings', () => {
  const landings: GoalLanding[] = [
    { prNumber: 1, goalRef: 'issue:1', sha: 'a', recordedAt: '2026-02-01T00:00:00.000Z' },
    { prNumber: 2, goalRef: 'issue:7', sha: 'b', recordedAt: '2026-03-01T00:00:00.000Z' },
  ];
  const board = build({ items: [item({ number: 1 }), item({ number: 7, parent: null })], landings });

  assert.deepEqual(board.orphans?.landings, [{ goal: 7, prNumber: 2, at: '2026-03-01T00:00:00.000Z' }]);
  assert.deepEqual(board.features[0]?.landings, [{ goal: 1, prNumber: 1, at: '2026-02-01T00:00:00.000Z' }]);
});

test('the standing key is quoted from the digest handed in, and empty where none was', () => {
  const board = build({
    items: [item({ number: 1 }), item({ number: 2, parent: { number: 901, title: 'Bare' } })],
    standingKeys: new Map([[900, 'abc123']]),
  });

  const keyed = board.features.find((f) => f.number === 900);
  const bare = board.features.find((f) => f.number === 901);
  assert.equal(keyed?.standingKey, 'abc123');
  assert.equal(bare?.standingKey, '');
});

test('features wanting a person sort first, and the ordering is not a verdict', () => {
  const board = build({
    items: [
      item({ number: 1, parent: { number: 100, title: 'Quiet' } }),
      item({ number: 2, parent: { number: 100, title: 'Quiet' } }),
      item({ number: 3, parent: { number: 200, title: 'Wants you' } }),
    ],
    outcomes: new Map([[3, 'fell short']]),
  });

  assert.deepEqual(
    board.features.map((f) => f.number),
    [200, 100],
  );
  assert.equal(Object.keys(board.features[0] ?? {}).includes('status'), false);
});

test('a large Feature ships a bounded slice, and keeps what wants attention in it', () => {
  const items = Array.from({ length: FEATURE_CHILDREN + 5 }, (_, i) => item({ number: i + 1 }));
  const board = build({ items, outcomes: new Map([[FEATURE_CHILDREN + 5, 'fell short']]) });

  const feature = board.features[0];
  assert.ok(feature);
  assert.equal(feature.counts.total, FEATURE_CHILDREN + 5);
  assert.equal(feature.children.length, FEATURE_CHILDREN);
  assert.equal(feature.children[0]?.standing, 'fellShort');
});

function delivery(number: number, over: Partial<IssueDelivery> = {}): IssueDelivery {
  return {
    originRef: `issue:${number}`,
    summary: `Shipped ${number}`,
    detail: null,
    by: 'assessor',
    agentId: null,
    taskId: null,
    decidedAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    ...over,
  };
}

function shortfall(number: number, over: Partial<IssueShortfall> = {}): IssueShortfall {
  return {
    originRef: `issue:${number}`,
    cause: null,
    partSlug: null,
    summary: `Still missing on ${number}`,
    detail: null,
    by: 'assessor',
    agentId: null,
    taskId: null,
    decidedAt: '2026-02-02T00:00:00.000Z',
    updatedAt: '2026-02-02T00:00:00.000Z',
    ...over,
  };
}

function escalation(over: Partial<Escalation> = {}): Escalation {
  return {
    id: 'esc_1',
    type: 'answer_question',
    status: 'open',
    prompt: 'Which tenant should this migrate first?',
    context: { originRef: 'issue:1' },
    agentId: 'agent_1',
    taskId: 'task_1',
    response: null,
    createdAt: '2026-02-03T00:00:00.000Z',
    answeredAt: null,
    ...over,
  };
}

test('the briefing quotes the sentences their authors wrote, never a paraphrase', () => {
  const board = build({
    items: [item({ number: 1 }), item({ number: 2 }), item({ number: 3 })],
    outcomes: new Map([
      [1, 'delivered'],
      [2, 'fell short'],
    ]),
    running: new Map([[3, '2026-02-04T00:00:00.000Z']]),
    deliveries: [delivery(1)],
    shortfalls: [shortfall(2)],
  });

  const briefing = board.features[0]?.briefing;
  assert.ok(briefing);
  assert.deepEqual(briefing.delivered, [
    { number: 1, title: 'Item 1', summary: 'Shipped 1', by: 'assessor', at: '2026-02-01T00:00:00.000Z' },
  ]);
  assert.deepEqual(briefing.working, [{ number: 3, title: 'Item 3', since: '2026-02-04T00:00:00.000Z' }]);
  assert.deepEqual(briefing.blocking, [
    {
      number: 2,
      title: 'Item 2',
      kind: 'fellShort',
      summary: 'Still missing on 2',
      since: '2026-02-02T00:00:00.000Z',
    },
  ]);
});

test('an open question about a goal blocks it, and outranks a shortfall of any age', () => {
  const board = build({
    items: [item({ number: 1 }), item({ number: 2 })],
    outcomes: new Map([[2, 'fell short']]),
    shortfalls: [shortfall(2)],
    escalations: [escalation()],
  });

  const briefing = board.features[0]?.briefing;
  assert.ok(briefing);
  assert.deepEqual(
    briefing.blocking.map((b) => b.kind),
    ['question', 'fellShort'],
  );
  assert.equal(briefing.blocking[0]?.summary, 'Which tenant should this migrate first?');
});

test('an answered or dismissed escalation blocks nothing', () => {
  const board = build({
    items: [item({ number: 1 })],
    escalations: [
      escalation({ id: 'esc_a', status: 'answered', answeredAt: '2026-02-04T00:00:00.000Z' }),
      escalation({ id: 'esc_b', status: 'dismissed' }),
    ],
  });

  assert.deepEqual(board.features[0]?.briefing.blocking, []);
});

test('a question raised against a pull request is counted under no Feature', () => {
  const board = build({
    items: [item({ number: 1 })],
    escalations: [escalation({ context: { originRef: 'pr:42:ci' } }), escalation({ id: 'esc_c', context: {} })],
  });

  assert.deepEqual(board.features[0]?.briefing.blocking, []);
  assert.equal(board.features[0]?.briefing.blockingTotal, 0);
});

test('a re-picked goal keeps its delivery in the briefing while the next attempt runs', () => {
  const board = build({
    items: [item({ number: 1 })],
    outcomes: new Map([[1, 'delivered']]),
    running: new Map([[1, '2026-02-05T00:00:00.000Z']]),
    deliveries: [delivery(1)],
  });

  const briefing = board.features[0]?.briefing;
  assert.ok(briefing);
  assert.equal(board.features[0]?.children[0]?.standing, 'inFlight');
  assert.equal(briefing.delivered.length, 1);
  assert.equal(briefing.working.length, 1);
});

test('each briefing list is bounded, and says how many it stood for', () => {
  const count = 8;
  const items = Array.from({ length: count }, (_, i) => item({ number: i + 1 }));
  const board = build({
    items,
    outcomes: new Map(items.map((i) => [i.number, 'fell short'])),
    shortfalls: items.map((i) => shortfall(i.number)),
  });

  const briefing = board.features[0]?.briefing;
  assert.ok(briefing);
  assert.equal(briefing.blockingTotal, count);
  assert.equal(briefing.blocking.length, FEATURE_BRIEFING_ROWS);
});

test('the orphan card gets a briefing too — the work under no Feature is still work', () => {
  const board = build({
    items: [item({ number: 1, parent: null })],
    outcomes: new Map([[1, 'delivered']]),
    deliveries: [delivery(1)],
  });

  assert.equal(board.orphans?.briefing.delivered[0]?.summary, 'Shipped 1');
});

test('the board needs the flag and a provider that can place a work item', () => {
  const azure = { canPlaceWorkItem: () => true };
  const github = { canPlaceWorkItem: () => false };

  assert.equal(featureBoardOn({ featureBoard: true }, azure), true);
  assert.equal(featureBoardOn({ featureBoard: true }, github), false);
  assert.equal(featureBoardOn({ featureBoard: false }, azure), false);
  assert.equal(featureBoardOn({ featureBoard: false }, github), false);
});
