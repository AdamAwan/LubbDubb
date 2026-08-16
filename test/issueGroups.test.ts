import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cascadeNote, featureBlocks, isContainerType } from '../web/src/issueGroups.js';
import type { Issue, TicketRow } from '../web/src/types.js';

/**
 * The tickets tab's arrangement, tested at the same seam the panel calls it — pure
 * over already-filtered rows, so the filters are the caller's business and every
 * case here is about layout alone.
 *
 * It groups the **mirror's** rows off their own parent columns, which is what lets
 * a frozen row keep its heading. The three values of `parent` are the whole subject:
 * a feature, a resolved `null`, and an unresolved absence, which must never be read
 * as each other.
 */

function row(over: Partial<TicketRow> & Pick<TicketRow, 'number'>): TicketRow {
  return {
    title: `Ticket ${over.number}`,
    state: 'open',
    watch: 'watched',
    labels: [],
    costUsd: null,
    outcome: null,
    addedAt: '2026-08-01T00:00:00.000Z',
    changedAt: '2026-08-01T00:00:00.000Z',
    tracking: 'live',
    workItemState: null,
    issueType: null,
    featureSlot: null,
    ...over,
  };
}

const checkout = { number: 812, title: 'Checkout' };

test('a tracker that reports no hierarchy gets no headings at all', () => {
  // The whole GitHub path: `parent` is absent on every row, so there is nothing to
  // arrange and inventing one heading over the lot would claim a tree the tracker
  // never had.
  const blocks = featureBlocks([row({ number: 1 }), row({ number: 2 })]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.key, 'untracked');
  assert.equal(blocks[0]?.feature, null);
  assert.equal(blocks[0]?.rows.length, 2);
});

test('rows are grouped under the feature their parent names, and keep the list order', () => {
  const blocks = featureBlocks([
    row({ number: 9, parent: checkout, featureSlot: 3 }),
    row({ number: 4, parent: checkout, featureSlot: 3 }),
  ]);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0]?.feature, { number: 812, title: 'Checkout', slot: 3 });
  // Not re-sorted: the ordering is the one the operator chose in the header.
  assert.deepEqual(
    blocks[0]?.rows.map((r) => r.number),
    [9, 4],
  );
});

test('a frozen row keeps the feature it was last seen under', () => {
  // The reason the arrangement reads the mirror's own columns rather than the live
  // world: a closed item is no longer in the world, and a world-shaped grouping
  // would drop every one of them into a single nameless pile.
  const blocks = featureBlocks([row({ number: 7, parent: checkout, tracking: 'frozen' })]);
  assert.equal(blocks[0]?.feature?.number, 812);
});

test('an unresolved parent is not an orphan', () => {
  // `null` is the tracker saying "no parent"; absent is it having no opinion. Only
  // the first is an orphan, and conflating them files a GitHub issue under a
  // heading accusing it of a gap its tracker never had.
  const blocks = featureBlocks([row({ number: 1, parent: null }), row({ number: 2 })]);
  const kinds = blocks.map((b) => b.key);
  assert.deepEqual(kinds, ['untracked', 'orphans']);
  assert.equal(blocks.find((b) => b.key === 'orphans')?.orphans, true);
  assert.equal(blocks.find((b) => b.key === 'untracked')?.orphans, false);
});

test('headless rows come first and the parentless group last', () => {
  const blocks = featureBlocks([
    row({ number: 1, parent: null }),
    row({ number: 2, parent: checkout }),
    row({ number: 3 }),
  ]);
  assert.deepEqual(
    blocks.map((b) => b.key),
    ['untracked', 'f812', 'orphans'],
  );
});

test('a container is read from the operator policy, case-insensitively', () => {
  const feature = { issueType: 'Feature' } as Issue;
  assert.equal(isContainerType(feature, ['feature', 'epic']), true);
  assert.equal(isContainerType({ issueType: 'Task' } as Issue, ['Feature']), false);
  // A flat tracker reports no type at all, so the gate is a no-op rather than a guess.
  assert.equal(isContainerType({} as Issue, ['Feature']), false);
});

test('watching a container says what else the click will tag', () => {
  // The invariant is about the words, not the markup: a click that writes eight
  // tags must say eight, or the operator finds out afterwards in the dispatch log.
  const container = { issueType: 'Feature', children: [{}, {}, {}] } as unknown as Issue;
  assert.equal(cascadeNote(container, ['Feature']), ' and its 3 child items');
  assert.equal(
    cascadeNote({ issueType: 'Feature', children: [{}] } as unknown as Issue, ['Feature']),
    ' and its 1 child item',
  );
  // An ordinary item cascades to nothing, and a container holding nothing has
  // nothing to promise either.
  assert.equal(cascadeNote({ issueType: 'Task', children: [{}] } as unknown as Issue, ['Feature']), '');
  assert.equal(cascadeNote({ issueType: 'Feature' } as unknown as Issue, ['Feature']), '');
});
