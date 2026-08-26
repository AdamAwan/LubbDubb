import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFeatureBoard, FEATURE_CHILDREN } from '../src/features/featureBoard.js';
import { featureBoardOn } from '../src/server/routes/features.js';
import type { MirroredTicket } from '../src/store/tickets.js';
import type { GoalEnvironmentReach, GoalLanding } from '../src/types.js';

// --- fixtures --------------------------------------------------------------

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
    running: new Set(),
    reach: [],
    landings: [],
    environments: [],
    containerTypes: ['Feature', 'Epic'],
    watchLabel: WATCH,
    ...over,
  });
}

// --- the standings ---------------------------------------------------------

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
  // The failure this precedence exists to refuse: drawn as `queued`, an item
  // carrying no watch tag reports a fleet working through a backlog it cannot see.
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
    running: new Set([1]),
  });

  const child = board.features[0]?.children[0];
  assert.ok(child);
  assert.equal(child.standing, 'inFlight');
  // And the verdict is still carried beside it, rather than erased by the run.
  assert.equal(child.outcome, 'fell short');
});

test('a container is never its own child', () => {
  // A Feature under an Epic would otherwise land in the Epic's bar as one item
  // weighing the same as a story — a whole Feature's work counted once.
  const board = build({
    items: [
      item({ number: 1 }),
      item({ number: 2, issueType: 'Feature', parent: { number: 900, title: 'Environments' } }),
      // Case-insensitively, the way every type comparison in `issueRelations` is made.
      item({ number: 3, issueType: 'epic', parent: { number: 900, title: 'Environments' } }),
    ],
  });

  assert.equal(board.features[0]?.counts.total, 1);
});

test('a flat tracker has no containers at all, so nothing is mistaken for one', () => {
  // `issueType: null` is GitHub and the fake. Every item is its own orphan, which
  // is exactly why the tab is gated on the provider as well as on the flag.
  const board = build({ items: [item({ number: 1, issueType: null, parent: null })] });

  assert.equal(board.features.length, 0);
  assert.equal(board.orphans?.counts.total, 1);
});

// --- the three buckets a parent link can land in ---------------------------

test('an unresolved parent link is neither a Feature’s nor an orphan’s', () => {
  const board = build({
    items: [
      item({ number: 1 }),
      // `null` — the tracker says there is no parent.
      item({ number: 2, parent: null }),
      // Absent — the link was never resolved. Counting it as an orphan would tell
      // a reader the tracker says it has no parent when nobody could tell.
      item({ number: 3, parent: undefined }),
    ],
  });

  assert.equal(board.features[0]?.counts.total, 1);
  assert.equal(board.orphans?.counts.total, 1);
  assert.equal(board.unresolved, 1);
});

test('no orphan bucket at all where every item has a parent', () => {
  assert.equal(build({ items: [item({ number: 1 })] }).orphans, null);
});

// --- money -----------------------------------------------------------------

test('spend is null where the fleet never ran, and zero only where it ran for nothing', () => {
  // PTY agents report no usage, so a Feature worked entirely that way has no spend
  // row anywhere — `$0.00` would report free work where the truth is unmeasured.
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

// --- reach -----------------------------------------------------------------

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
  // An expired credential and work that genuinely has not shipped read identically
  // on the glass, and only one of them is about deployment.
  const board = build({
    items: [item({ number: 1 }), item({ number: 2 })],
    environments: ['prod'],
    reach: [reachRow(1, 'absent'), reachRow(2, 'unknown')],
  });
  assert.equal(board.features[0]?.reach[0]?.status, 'unknown');

  // A goal only half-there is unresolved up here: half a goal in an environment is
  // not a goal in it.
  const half = build({
    items: [item({ number: 1 }), item({ number: 2 })],
    environments: ['prod'],
    reach: [reachRow(1, 'absent'), reachRow(2, 'partial')],
  });
  assert.equal(half.features[0]?.reach[0]?.status, 'unknown');
});

test('a goal with nothing merged is not counted as absent everywhere', () => {
  // `allGoalReach` drops such a goal, and widening the denominator here would put
  // every never-started story in it — a shipped Feature reading as a third
  // deployed, for good.
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

// --- movement, ordering and the cap ----------------------------------------

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
  // Nothing on the row says "at risk" — the sort says which to read first and the
  // counts say why. No verdict about a Feature is shipped at all.
  assert.equal(Object.keys(board.features[0] ?? {}).includes('status'), false);
});

test('a large Feature ships a bounded slice, and keeps what wants attention in it', () => {
  const items = Array.from({ length: FEATURE_CHILDREN + 5 }, (_, i) => item({ number: i + 1 }));
  const board = build({ items, outcomes: new Map([[FEATURE_CHILDREN + 5, 'fell short']]) });

  const feature = board.features[0];
  assert.ok(feature);
  // The counts are over everything; only the rows are cut.
  assert.equal(feature.counts.total, FEATURE_CHILDREN + 5);
  assert.equal(feature.children.length, FEATURE_CHILDREN);
  // An arrival ordering would have cut exactly this row.
  assert.equal(feature.children[0]?.standing, 'fellShort');
});

// --- the gate --------------------------------------------------------------

test('the board needs the flag and a provider that can place a work item', () => {
  const azure = { canPlaceWorkItem: () => true };
  const github = { canPlaceWorkItem: () => false };

  assert.equal(featureBoardOn({ featureBoard: true }, azure), true);
  // The flag alone is not enough: a flat tracker has no hierarchy to roll up, so
  // the tab is absent rather than empty.
  assert.equal(featureBoardOn({ featureBoard: true }, github), false);
  assert.equal(featureBoardOn({ featureBoard: false }, azure), false);
  assert.equal(featureBoardOn({ featureBoard: false }, github), false);
});
