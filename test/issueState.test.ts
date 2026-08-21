import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import type { TrackerItem, WorldSnapshot } from '../src/types.js';

/**
 * The two halves of one confirmed state write — the baseline `/api/state` serves,
 * and the mirror the Tickets tab is built from.
 *
 * Both are patched for the reason the label pair documents: the baseline is what the
 * cockpit redraws from, and the sweep that would carry the mirror runs last in a
 * cycle that coalesces away while another is in flight. Only ever called for a write
 * the provider took, so each is observed fact arriving early rather than a guess.
 */

const SINCE = '2026-07-01T00:00:00.000Z';
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

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

function world(): WorldSnapshot {
  return {
    takenAt: '2026-08-01T00:00:00.000Z',
    pullRequests: [],
    closedPullRequests: [],
    issues: [
      { id: 'issue_a', number: 5, title: 'Five', body: '', labels: [], state: 'open', linkedPrNumber: null },
      { id: 'issue_b', number: 6, title: 'Six', body: '', labels: [], state: 'open', linkedPrNumber: null },
    ],
  } as unknown as WorldSnapshot;
}

test('a confirmed state lands on the baseline, and only on the item named', () => {
  const store = new Store(':memory:');
  store.setWorldBaseline(world());

  store.patchWorldState({ number: 5, state: 'In Review' });

  const after = store.getWorldBaseline();
  assert.equal(after?.issues.find((i) => i.number === 5)?.workItemState, 'In Review');
  assert.equal(
    after?.issues.find((i) => i.number === 6)?.workItemState,
    undefined,
    'an item nobody moved is untouched',
  );
  store.close();
});

test('an item the baseline no longer holds is skipped rather than invented', () => {
  const store = new Store(':memory:');
  store.setWorldBaseline(world());
  // The world this came from has aged out. Inventing a row would put an issue in
  // the cockpit that no snapshot ever described.
  store.patchWorldState({ number: 99, state: 'Doing' });
  assert.equal(store.getWorldBaseline()?.issues.length, 2);
  store.close();
});

test('the same write lands on the mirror, which is what the board’s columns are built from', () => {
  const store = new Store(':memory:');
  store.ensureTrackerSweep(MONTH_MS);
  store.recordSweep(SINCE, [item({ number: 5, workItemState: 'Ready' }), item({ number: 6 })]);

  store.patchTicketState({ number: 5, state: 'In Review' });

  const rows = store.listTrackerItems();
  assert.equal(rows.find((r) => r.number === 5)?.workItemState, 'In Review');
  assert.equal(rows.find((r) => r.number === 6)?.workItemState, null, 'and nothing else moves');
  store.close();
});

test('a number the mirror does not hold is skipped — the mirror is a record of what was seen', () => {
  const store = new Store(':memory:');
  store.ensureTrackerSweep(MONTH_MS);
  store.recordSweep(SINCE, [item({ number: 5 })]);
  store.patchTicketState({ number: 99, state: 'Doing' });
  assert.deepEqual(
    store.listTrackerItems().map((r) => r.number),
    [5],
  );
  store.close();
});
