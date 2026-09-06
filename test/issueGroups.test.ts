import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cascadeNote, featureBlocks, isContainerType, issueTypeTone, watchReading } from '../web/src/issueGroups.js';
import type { Issue, TicketRow } from '../web/src/types.js';

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
  assert.deepEqual(
    blocks[0]?.rows.map((r) => r.number),
    [9, 4],
  );
});

test('a frozen row keeps the feature it was last seen under', () => {
  const blocks = featureBlocks([row({ number: 7, parent: checkout, tracking: 'frozen' })]);
  assert.equal(blocks[0]?.feature?.number, 812);
});

test('an unresolved parent is not an orphan', () => {
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
  assert.equal(isContainerType({} as Issue, ['Feature']), false);
});

test('watching a container says what else the click will tag', () => {
  const container = { issueType: 'Feature', children: [{}, {}, {}] } as unknown as Issue;
  assert.equal(cascadeNote(container, ['Feature']), ' and its 3 child items');
  assert.equal(
    cascadeNote({ issueType: 'Feature', children: [{}] } as unknown as Issue, ['Feature']),
    ' and its 1 child item',
  );
  assert.equal(cascadeNote({ issueType: 'Task', children: [{}] } as unknown as Issue, ['Feature']), '');
  assert.equal(cascadeNote({ issueType: 'Feature' } as unknown as Issue, ['Feature']), '');
});

test('a type tone is the family, whatever casing and spacing the tracker uses', () => {
  assert.equal(issueTypeTone('Bug'), 'red');
  assert.equal(issueTypeTone('  user story '), 'green');
  assert.equal(issueTypeTone('Product Backlog Item'), 'green');
  assert.equal(issueTypeTone('Tech Debt'), 'amber');
  assert.equal(issueTypeTone('Epic'), 'violet');
  assert.equal(issueTypeTone('Task'), 'blue');
});

test('a type the cockpit has no opinion about carries no tone', () => {
  assert.equal(issueTypeTone('Capability'), undefined);
  assert.equal(issueTypeTone(''), undefined);
  assert.equal(issueTypeTone(null), undefined);
  assert.equal(issueTypeTone(undefined), undefined);
});

test('the watch toggle believes the world, not the mirror it is drawn beside', () => {
  const stale = { watch: 'watched' } as TicketRow;
  assert.equal(watchReading({ labels: [] }, stale, 'lubbdubb-watch'), 'unwatched');
  assert.equal(
    watchReading({ labels: ['lubbdubb-watch'] }, { watch: 'unwatched' } as TicketRow, 'lubbdubb-watch'),
    'watched',
  );

  assert.equal(watchReading(null, stale, 'lubbdubb-watch'), 'watched');
  assert.equal(watchReading(null, null, 'lubbdubb-watch'), 'unwatched');

  assert.equal(watchReading({ labels: [] }, stale, ''), 'watched');
});
