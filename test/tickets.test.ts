import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { buildSystem } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/server/app.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildTicketPage, TICKET_PAGE } from '../src/tickets/ticketList.js';
import { ticketOutcomes } from '../src/tickets/outcomes.js';
import { TicketSweep } from '../src/tickets/sweep.js';
import type { LiveTicketFacts, MirroredTicket } from '../src/store/tickets.js';
import type { TicketsPayload } from '../src/wire.js';
import type { TrackerItem } from '../src/types.js';
import { statePick } from '../web/src/cockpit/place.js';

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
/** What a sweep asked from, when a test is not about the mark itself. */
const SINCE = '2026-07-01T00:00:00.000Z';

function item(over: Partial<TrackerItem> & Pick<TrackerItem, 'number'>): TrackerItem {
  return {
    title: `Ticket ${over.number}`,
    labels: [],
    state: 'open',
    workItemState: null,
    url: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    changedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function mirrored(over: Partial<MirroredTicket> & Pick<MirroredTicket, 'number'>): MirroredTicket {
  return {
    ...item(over),
    firstSeenAt: '2026-08-01T00:00:00.000Z',
    tracking: 'live',
    issueType: null,
    lastReadAt: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The mirror
// ---------------------------------------------------------------------------

test('the mirror keeps everything it has seen and never deletes', () => {
  const store = new Store(':memory:');
  store.ensureTrackerSweep(MONTH_MS);

  store.recordSweep(SINCE, [item({ number: 10, title: 'First' }), item({ number: 11 })]);
  // A later sweep that no longer mentions #11 — the tracker stopped returning it,
  // which is what closing, untagging or reassigning an item looks like from here.
  store.recordSweep(SINCE, [item({ number: 10, title: 'Renamed', state: 'closed' })]);

  const rows = store.listTrackerItems();
  assert.deepEqual(
    rows.map((r) => r.number),
    [11, 10],
    'newest tracker id first, and the item the tracker forgot is still here',
  );
  assert.equal(rows.find((r) => r.number === 10)?.title, 'Renamed', 'a row it did return is refreshed');
  assert.equal(rows.find((r) => r.number === 10)?.state, 'closed');
  store.close();
});

test('the backfill anchor is frozen, and the high-water mark only moves forward', () => {
  const store = new Store(':memory:');
  const first = store.ensureTrackerSweep(MONTH_MS);
  // A second call with a *wider* window must not move the floor: rows below it are
  // already kept, and a floor that moved would make "history from" a lie on every
  // screen that states it.
  const again = store.ensureTrackerSweep(MONTH_MS * 12);
  assert.equal(again.anchorAt, first.anchorAt, 'the anchor is stamped once');
  assert.equal(first.sweptTo, null, 'and nothing has been swept yet');

  store.recordSweep(SINCE, [item({ number: 1, changedAt: '2026-08-05T00:00:00.000Z' })]);
  assert.equal(store.readTrackerSweep()?.sweptTo, '2026-08-05T00:00:00.000Z');

  // An unordered batch carrying one older row must not walk the mark backwards —
  // it would re-read the same window forever.
  store.recordSweep(SINCE, [item({ number: 2, changedAt: '2026-08-02T00:00:00.000Z' })]);
  assert.equal(store.readTrackerSweep()?.sweptTo, '2026-08-05T00:00:00.000Z', 'the mark is a maximum');
  store.close();
});

test('the sweep asks from the anchor first and from its own mark after', async () => {
  const store = new Store(':memory:');
  const asked: string[] = [];
  const sweep = new TicketSweep({
    store,
    backfillMs: MONTH_MS,
    source: {
      tracksTicketHistory: true,
      async listTicketHistory(since) {
        asked.push(since);
        return [item({ number: 7, changedAt: '2026-08-09T00:00:00.000Z' })];
      },
    },
  });

  assert.equal(sweep.backfilling, true, 'a capable provider with nothing swept yet is still filling');
  await sweep.run();
  const anchor = store.readTrackerSweep()?.anchorAt;
  assert.equal(asked[0], anchor, 'the first read starts at the frozen floor');
  assert.equal(
    sweep.backfilling,
    false,
    'and the tab stops saying so once one lands — an empty list mid-backfill and an empty tracker are different facts',
  );

  await sweep.run();
  assert.equal(asked[1], '2026-08-09T00:00:00.000Z', 'the next reads from what was actually taken in');
  store.close();
});

test('a fresh mirror is restated by its own first read', async () => {
  const store = new Store(':memory:');
  const sweep = new TicketSweep({
    store,
    backfillMs: MONTH_MS,
    source: {
      tracksTicketHistory: true,
      listTicketHistory: () => Promise.resolve([]),
    },
  });
  await sweep.run();
  assert.notEqual(
    store.readTrackerSweep()?.restatedAt,
    null,
    'so an upgrade pays for the re-read and a new deployment does not',
  );
  store.close();
});

test('a mirror written before the history carried states re-reads itself once', async () => {
  // The database an upgrade actually finds: swept by a build whose history read
  // dropped the provider's own word, so every row that had already closed carries
  // no state and no state filter can reach it. The column does not exist yet
  // either — which is what makes its absence mean *not restated*.
  const path = join(mkdtempSync(join(tmpdir(), 'lubbdubb-tickets-')), 'db.sqlite');
  const raw = new Database(path);
  raw.exec(`CREATE TABLE tracker_sweep (
    id INTEGER PRIMARY KEY CHECK (id = 1), anchor_at TEXT NOT NULL, swept_to TEXT, updated_at TEXT NOT NULL);
    INSERT INTO tracker_sweep VALUES (1, '${SINCE}', '2026-08-08T00:00:00.000Z', '${SINCE}');`);
  raw.close();

  const store = new Store(path);
  const asked: string[] = [];
  const sweep = new TicketSweep({
    store,
    backfillMs: MONTH_MS,
    source: {
      tracksTicketHistory: true,
      async listTicketHistory(since: string) {
        asked.push(since);
        return [item({ number: 7, changedAt: '2026-08-09T00:00:00.000Z', state: 'closed', workItemState: 'Closed' })];
      },
    },
  });

  await sweep.run();
  assert.equal(asked[0], SINCE, 'the sweep asks from the floor again rather than from its own mark');
  assert.equal(store.listTrackerItems()[0]?.workItemState, 'Closed', 'and every row is re-upserted with its state');

  await sweep.run();
  assert.equal(asked[1], '2026-08-09T00:00:00.000Z', 'then it is incremental again — the re-read happens once');
  store.close();
});

test('a provider that cannot list history mints no anchor and records no fault', async () => {
  const store = new Store(':memory:');
  const errors: string[] = [];
  const sweep = new TicketSweep({
    store,
    source: {
      tracksTicketHistory: false,
      async listTicketHistory() {
        throw new Error('never called');
      },
    },
    errors: { record: (e: { message: string }) => errors.push(e.message) } as never,
  });
  await sweep.run();
  assert.equal(store.readTrackerSweep(), null, 'no floor is stamped for a history that was never read');
  assert.deepEqual(errors, [], 'and a provider without the capability is not a failure');
  store.close();
});

test('a failed sweep is recorded, leaves the mark behind, and is retried whole', async () => {
  const store = new Store(':memory:');
  const errors: string[] = [];
  let fail = true;
  const sweep = new TicketSweep({
    store,
    backfillMs: MONTH_MS,
    source: {
      tracksTicketHistory: true,
      async listTicketHistory() {
        if (fail) throw new Error('tracker refused');
        return [item({ number: 3, changedAt: '2026-08-07T00:00:00.000Z' })];
      },
    },
    errors: { record: (e: { message: string }) => errors.push(e.message) } as never,
  });

  await sweep.run();
  assert.match(errors[0] ?? '', /ticket sweep failed: tracker refused/);
  assert.equal(store.readTrackerSweep()?.sweptTo, null, 'the mark never moved past rows nobody wrote');

  fail = false;
  await sweep.run();
  assert.equal(store.listTrackerItems().length, 1, 'the next sweep picks up what the failed one missed');
  store.close();
});

test('a completed sweep that found nothing still stops the tab saying it is filling', async () => {
  const store = new Store(':memory:');
  const sweep = new TicketSweep({
    store,
    backfillMs: MONTH_MS,
    source: {
      tracksTicketHistory: true,
      // An empty tracker, or a month with nothing in it.
      async listTicketHistory() {
        return [];
      },
    },
  });

  await sweep.run();
  const mark = store.readTrackerSweep();
  assert.equal(mark?.sweptTo, mark?.anchorAt, 'the mark records the sweep without advancing past it');
  assert.equal(
    sweep.backfilling,
    false,
    'an empty tracker is an empty list, not a tab that says "reading the last month" forever',
  );
  store.close();
});

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

const LABELS = { watchLabel: 'lubbdubb-watch', ignoreLabel: 'lubbdubb-ignore' };

function page(
  items: MirroredTicket[],
  query: Partial<Parameters<typeof buildTicketPage>[0]['query']> = {},
  costs = new Map<number, number>(),
) {
  return buildTicketPage({
    items,
    costs,
    outcomes: new Map(),
    featureSlots: new Map(),
    pickupStates: [],
    ...LABELS,
    query: { watch: 'any', tracking: 'any', state: 'any', feature: null, order: 'added', cursor: null, ...query },
  });
}

test('the axes are independent, and an untagged item is unwatched rather than ignored', () => {
  const items = [
    mirrored({ number: 4, labels: ['lubbdubb-watch'], state: 'open', tracking: 'live' }),
    mirrored({ number: 3, labels: ['lubbdubb-watch'], state: 'closed', tracking: 'frozen' }),
    mirrored({ number: 2, labels: [], state: 'open', tracking: 'live' }),
    mirrored({ number: 1, labels: ['lubbdubb-ignore'], state: 'closed', tracking: 'frozen' }),
  ];

  // The four questions the ticket asks, in the order it asks them. `tracking` is
  // the harness's reading and `watch` the operator's, and neither narrows the other.
  assert.deepEqual(
    page(items, { watch: 'watched', tracking: 'live' }).rows.map((r) => r.number),
    [4],
  );
  assert.deepEqual(
    page(items, { tracking: 'frozen' }).rows.map((r) => r.number),
    [3, 1],
  );
  assert.deepEqual(
    page(items, { watch: 'unwatched', tracking: 'live' }).rows.map((r) => r.number),
    [2],
    'an item nobody has opted in is unwatched — folding it into ignored would report a triage nobody made',
  );
  assert.deepEqual(
    page(items).rows.map((r) => r.number),
    [4, 3, 2, 1],
    'and all of them, newest tracker id first',
  );
  assert.deepEqual(
    page(items, { watch: 'ignored' }).rows.map((r) => r.number),
    [1],
    'leave-alone is its own answer',
  );
});

test('cost orders the list, ties break on the number, and no spend is null rather than zero', () => {
  const items = [mirrored({ number: 3 }), mirrored({ number: 2 }), mirrored({ number: 1 })];
  const costs = new Map([
    [1, 12.5],
    [2, 12.5],
  ]);
  const built = page(items, { order: 'cost' }, costs);

  assert.deepEqual(
    built.rows.map((r) => r.number),
    [2, 1, 3],
    'costliest first, ties by number, and the unworked ticket last',
  );
  assert.equal(built.rows[2]?.costUsd, null, 'never worked is null — $0.00 would state the wrong fact');
  assert.equal(built.totalCostUsd, 25, 'the total is the filtered set, not the page');
});

test('paging is keyset, so a row arriving mid-scroll cannot hide one', () => {
  const items = Array.from({ length: TICKET_PAGE + 5 }, (_, i) => mirrored({ number: 100 - i }));
  const first = page(items);
  assert.equal(first.rows.length, TICKET_PAGE);
  assert.equal(first.total, TICKET_PAGE + 5, 'the total is the whole filtered set — what makes "40 of 45" sayable');
  assert.ok(first.nextCursor !== null);

  // A newer ticket lands between the two reads. An offset would shift the window
  // and drop the row at the boundary; a key names the row the last page stopped at.
  const grown = [mirrored({ number: 101 }), ...items];
  const second = page(grown, { cursor: first.nextCursor });
  assert.equal(second.rows.length, 5, 'exactly the tail, with nothing repeated and nothing skipped');
  assert.deepEqual(
    second.rows.map((r) => r.number),
    items.slice(TICKET_PAGE).map((r) => r.number),
  );
  assert.equal(second.nextCursor, null, 'and the foot of the list says so');
});

test('a cursor whose row has left the filtered set restarts rather than guessing', () => {
  const items = [mirrored({ number: 2 }), mirrored({ number: 1 })];
  const built = page(items, { cursor: '999' });
  assert.deepEqual(
    built.rows.map((r) => r.number),
    [2, 1],
    'repeating rows is a failure a reader can see; silently skipping a page is not',
  );
});

// ---------------------------------------------------------------------------
// The outcome word
// ---------------------------------------------------------------------------

test('a shortfall outranks a delivery, so a re-judged goal reads as fell short', () => {
  const outcomes = ticketOutcomes({
    runs: [],
    conclusions: [],
    deliveries: [{ originRef: 'issue:5', by: 'assessor' } as never],
    shortfalls: [{ originRef: 'issue:5', by: 'assessor' } as never],
    plans: [],
    planParts: [],
  });
  assert.equal(outcomes.get(5), 'fell short');
});

test('a delivery reads delivered, an agent’s own done reads concluded, and a dropped run reads abandoned', () => {
  const outcomes = ticketOutcomes({
    runs: [{ issueNumber: 8, originRef: 'issue:8', outcome: 'abandoned' } as never],
    conclusions: [{ originRef: 'issue:7', verdict: 'done', by: 'agent' } as never],
    deliveries: [{ originRef: 'issue:6', by: 'assessor' } as never],
    shortfalls: [],
    plans: [],
    planParts: [],
  });
  assert.equal(outcomes.get(6), 'delivered');
  assert.equal(outcomes.get(7), 'concluded');
  assert.equal(outcomes.get(8), 'abandoned');
  assert.equal(outcomes.get(99), undefined, 'and a ticket nobody judged has no word at all');
});

// ---------------------------------------------------------------------------
// The route, at the buildSystem seam
// ---------------------------------------------------------------------------

test('GET /api/tickets ships the mirror, filtered, ordered and paged', async () => {
  const config = loadConfig({
    auth: { enabled: false } as never,
    dbPath: ':memory:',
    labelPrefix: 'lubbdubb',
    agentMode: 'raw',
    heartbeatIntervalMs: 999_999,
    startPaused: true,
  });
  const system = buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });

  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Watched work', labels: ['lubbdubb-watch'] });
  system.connector.inject({ kind: 'new_issue', number: 13, title: 'Nobody triaged this' });
  system.connector.inject({ kind: 'new_issue', number: 14, title: 'Leave alone', labels: ['lubbdubb-ignore'] });
  await system.harness.runCycle('manual');

  const { app } = await buildApp(system);

  const all = await app.inject({ method: 'GET', url: '/api/tickets' });
  assert.equal(all.statusCode, 200);
  const body = all.json() as TicketsPayload;
  assert.deepEqual(
    body.rows.map((r) => r.number),
    [14, 13, 12],
    'every assigned item, newest tracker id first',
  );
  assert.equal(body.total, 3);
  assert.equal(body.kept, 3, 'the head counts the history itself');
  assert.equal(body.backfilling, false, 'the first sweep has landed');
  assert.notEqual(body.anchorAt, '', 'and the floor under the history is stated');
  assert.deepEqual(
    body.rows.map((r) => r.watch),
    ['ignored', 'unwatched', 'watched'],
    'the harness reading rides on every row',
  );

  const unwatched = await app.inject({ method: 'GET', url: '/api/tickets?watch=unwatched&tracking=live' });
  assert.deepEqual(
    (unwatched.json() as TicketsPayload).rows.map((r) => r.number),
    [13],
  );

  // A closed ticket is in the mirror and out of the world, which is the whole
  // point: the snapshot's issue list can no longer answer for it.
  system.connector.inject({ kind: 'issue_state', number: 12, state: 'closed' });
  await system.harness.runCycle('manual');
  // Spelled the old way on purpose: `state=closed` is the pre-#351 axis, and the
  // alias is what keeps every saved link and bookmark working.
  const closed = await app.inject({ method: 'GET', url: '/api/tickets?state=closed' });
  const closedBody = closed.json() as TicketsPayload;
  assert.deepEqual(
    closedBody.rows.map((r) => r.number),
    [12],
  );
  assert.equal(closedBody.total, 1, 'the filtered set is one');
  assert.equal(closedBody.kept, 3, 'but the history is still three — a filter does not shrink it');

  // A state no item carries is a filter that found nothing, not a place that does
  // not exist: the vocabulary is the tracker's, so this file cannot hold the list to
  // validate against and an empty answer is the honest one.
  const unknown = await app.inject({ method: 'GET', url: '/api/tickets?state=nonsense' });
  assert.equal(unknown.statusCode, 200);
  assert.deepEqual((unknown.json() as TicketsPayload).rows, []);

  const refused = await app.inject({ method: 'GET', url: '/api/tickets?tracking=nonsense' });
  assert.equal(refused.statusCode, 400, 'a hand-edited filter is refused as a value, not thrown');

  await app.close();
  system.store.close();
});

// ---------------------------------------------------------------------------
// Live and frozen (#351)
// ---------------------------------------------------------------------------

/** The live overlay a sweep is handed, narrowed to what these cases care about. */
function fact(number: number, over: Partial<LiveTicketFacts> = {}): LiveTicketFacts {
  return { number, labels: [], workItemState: null, issueType: null, ...over };
}

test('an item that leaves the open set freezes, keeps everything, and thaws if it comes back', () => {
  const store = new Store(':memory:');
  store.ensureTrackerSweep(MONTH_MS);
  store.recordSweep(
    SINCE,
    [item({ number: 1 }), item({ number: 2 })],
    [fact(1, { workItemState: 'Active', issueType: 'Task', parent: { number: 90, title: 'Payments' } }), fact(2)],
  );
  assert.deepEqual(
    store.listTrackerItems().map((r) => [r.number, r.tracking]),
    [
      [2, 'live'],
      [1, 'live'],
    ],
  );

  // #1 is gone from the open set. It freezes, and it keeps every field it was last
  // seen with — the whole reason a frozen row is kept rather than dropped.
  store.recordSweep(SINCE, [], [fact(2)]);
  const frozen = store.listTrackerItems().find((r) => r.number === 1);
  assert.equal(frozen?.tracking, 'frozen');
  assert.equal(frozen?.workItemState, 'Active');
  assert.deepEqual(frozen?.parent, { number: 90, title: 'Payments' });

  // Reopened, so the next sweep says so. Thaw is one condition, not a judgement.
  store.recordSweep(SINCE, [], [fact(1), fact(2)]);
  assert.equal(store.listTrackerItems().find((r) => r.number === 1)?.tracking, 'live');
  store.close();
});

test('a closed item keeps the tracker’s own word for why it closed', () => {
  // The live overlay is the open set by construction, so it is the *history* read
  // that has to carry the native state — otherwise every closed row answers null
  // and no state filter can reach it, which is the silence a discovered state list
  // exists to prevent.
  const store = new Store(':memory:');
  store.ensureTrackerSweep(MONTH_MS);
  store.recordSweep(
    SINCE,
    [item({ number: 1, state: 'closed', workItemState: 'Closed' }), item({ number: 2, workItemState: 'Removed' })],
    [],
  );
  assert.deepEqual(
    store.listTrackerItems().map((r) => [r.number, r.workItemState]),
    [
      [2, 'Removed'],
      [1, 'Closed'],
    ],
    'two ways of closing an item are two facts, and the mirror keeps both',
  );
  store.close();
});

test('a provider with no native states never wipes one the overlay wrote', () => {
  // GitHub and the fake hand back null on every history read. Assigning it would
  // erase what the snapshot knew, silently, on every pulse.
  const store = new Store(':memory:');
  store.ensureTrackerSweep(MONTH_MS);
  store.recordSweep(SINCE, [item({ number: 1 })], [fact(1, { workItemState: 'Active' })]);
  store.recordSweep(SINCE, [item({ number: 1 })], []);
  assert.equal(store.listTrackerItems()[0]?.workItemState, 'Active');
  store.close();
});

test('an empty live set freezes nothing at all', () => {
  // A provider whose snapshot failed hands back its last good read, but one that is
  // down on a first boot hands back nothing — and freezing the whole board off that
  // is the one way this can be wrong at scale.
  const store = new Store(':memory:');
  store.ensureTrackerSweep(MONTH_MS);
  store.recordSweep(SINCE, [item({ number: 1 })], [fact(1)]);
  store.recordSweep(SINCE, [], []);
  assert.equal(store.listTrackerItems()[0]?.tracking, 'live', 'silence is not evidence that the board is closed');
  store.close();
});

test('an orphan and an unreadable parent are never collapsed into each other', () => {
  const store = new Store(':memory:');
  store.ensureTrackerSweep(MONTH_MS);
  store.recordSweep(
    SINCE,
    [item({ number: 1 }), item({ number: 2 })],
    [
      // The tracker says this one hangs off nothing…
      fact(1, { parent: null }),
      // …and this provider reports no hierarchy at all, which is a different fact.
      fact(2),
    ],
  );
  const rows = store.listTrackerItems();
  assert.equal(rows.find((r) => r.number === 1)?.parent, null, 'a resolved absence is an orphan');
  assert.ok(!('parent' in (rows.find((r) => r.number === 2) ?? {})), 'an unresolved one says nothing');

  // And a sweep that could not read the link must not erase one an earlier sweep did.
  store.recordSweep(SINCE, [], [fact(1, { parent: { number: 90, title: 'Payments' } })]);
  store.recordSweep(SINCE, [], [fact(1)]);
  assert.deepEqual(store.listTrackerItems().find((r) => r.number === 1)?.parent, { number: 90, title: 'Payments' });
  store.close();
});

test('a feature keeps its colour, and the ladder is spread rather than piled', () => {
  const store = new Store(':memory:');
  const first = store.ensureFeatureColors([90, 91]);
  assert.notEqual(first.get(90), first.get(91), 'two features do not draw as one');
  // Assigned once and never moved: a colour that changed between sessions is worse
  // than no colour, since the whole value is that it is the same tomorrow.
  const again = store.ensureFeatureColors([91, 90, 92]);
  assert.equal(again.get(90), first.get(90));
  assert.equal(again.get(91), first.get(91));
  assert.equal(new Set([again.get(90), again.get(91), again.get(92)]).size, 3, 'least-used-first spreads them');
  store.close();
});

test('the facets count the whole mirror, not the filtered set', () => {
  // A facet counted after its own filter shows 1 beside whichever value was picked
  // and nothing beside the rest — a control that erases its own alternatives.
  const items = [
    mirrored({ number: 3, workItemState: 'Ready', parent: { number: 90, title: 'Payments' } }),
    mirrored({ number: 2, workItemState: 'New', parent: { number: 90, title: 'Payments' } }),
    mirrored({ number: 1, workItemState: 'New', parent: null }),
  ];
  const narrowed = page(items, { state: 'New' });
  assert.deepEqual(
    narrowed.rows.map((r) => r.number),
    [2, 1],
  );
  assert.deepEqual(
    narrowed.states.map((s) => [s.state, s.count]),
    [
      ['New', 2],
      ['Ready', 1],
    ],
    'every state the mirror carries is still offered, with its own count',
  );
  assert.deepEqual(
    narrowed.features.map((f) => [f.number, f.count]),
    [[90, 2]],
  );
  assert.equal(narrowed.orphanCount, 1);

  // The feature filter, and its orphan bucket — which is the tracker's "no parent",
  // never a parent we failed to read.
  assert.deepEqual(
    page(items, { feature: 90 }).rows.map((r) => r.number),
    [3, 2],
  );
  assert.deepEqual(
    page(items, { feature: 'none' }).rows.map((r) => r.number),
    [1],
  );
});

test('a state facet says how much of itself is still live', () => {
  // `Closed` is on frozen rows by definition. Counting only the total would leave
  // the cockpit no way to tell a pick that narrows from one that returns nothing.
  const facets = page([
    mirrored({ number: 3, workItemState: 'New' }),
    mirrored({ number: 2, workItemState: 'Closed', tracking: 'frozen', state: 'closed' }),
    mirrored({ number: 1, workItemState: 'Closed', tracking: 'frozen', state: 'closed' }),
  ]).states;
  assert.deepEqual(
    facets.map((f) => [f.state, f.count, f.live]),
    [
      ['Closed', 2, 0],
      ['New', 1, 1],
    ],
  );
  // And the rows are there to be had, which is the whole point of carrying the
  // state on a frozen row at all.
  assert.deepEqual(
    page(
      [
        mirrored({ number: 2, workItemState: 'Closed', tracking: 'frozen', state: 'closed' }),
        mirrored({ number: 1, workItemState: 'New' }),
      ],
      { state: 'Closed' },
    ).rows.map((r) => r.number),
    [2],
  );
});

test('picking a state nothing live carries widens the tracking axis rather than emptying the list', () => {
  const closed = { state: 'Closed', count: 68, live: 0, pickup: false };
  const active = { state: 'Active', count: 4, live: 4, pickup: true };
  assert.deepEqual(statePick(closed, 'live'), { state: 'Closed', tracking: 'any' });
  assert.deepEqual(statePick(active, 'live'), { state: 'Active' }, 'a state with live rows narrows as it always did');
  assert.deepEqual(statePick(closed, 'frozen'), { state: 'Closed' }, 'and an axis already wide enough is left alone');
  assert.deepEqual(statePick(null, 'live'), { state: 'any' }, 'Any clears the state and moves nothing else');
});

test('the pickup states config marks the states it lets through', () => {
  const items = [mirrored({ number: 1, workItemState: 'Ready' }), mirrored({ number: 2, workItemState: 'New' })];
  const facets = buildTicketPage({
    items,
    costs: new Map(),
    outcomes: new Map(),
    featureSlots: new Map(),
    pickupStates: ['Ready'],
    ...LABELS,
    query: { watch: 'any', tracking: 'any', state: 'any', feature: null, order: 'added', cursor: null },
  }).states;
  assert.deepEqual(
    facets.map((f) => [f.state, f.pickup]),
    [
      ['New', false],
      ['Ready', true],
    ],
    'read from config, never inferred from what happened to be dispatched',
  );
});
