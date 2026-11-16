import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, AskGoalPart } from '../web/src/types.js';
import type { NeedRow } from '../web/src/view/needsYou.js';
import { KIND_LABEL } from '../web/src/view/askKinds.js';
import {
  LOOK_ID,
  LOOK_TITLE,
  cursorIndex,
  focusRest,
  focusRows,
  focusStops,
  mergedParts,
  partsHeld,
  readingsCount,
  runningAgents,
  stopAriaLabel,
  stopId,
  stopTitle,
} from '../web/src/view/focusQueue.js';

function row(id: string, focusRank: number, holding = 0): NeedRow {
  return { id, kind: 'escalation', title: `ask ${id}`, focusRank, holding } as NeedRow;
}

test('focusRows sorts by focusRank and leaves the input alone', () => {
  const input = [row('b', 2), row('a', 0), row('c', 1)];
  assert.deepEqual(
    focusRows(input).map((r) => r.id),
    ['a', 'c', 'b'],
  );
  assert.deepEqual(
    input.map((r) => r.id),
    ['b', 'a', 'c'],
  );
});

test('partsHeld totals holding across the queue', () => {
  assert.equal(partsHeld([]), 0);
  assert.equal(partsHeld([row('a', 0, 2), row('b', 1, 0), row('c', 2, 3)]), 5);
});

test('the stops end with the look stop, whose id is LOOK_ID', () => {
  const stops = focusStops([row('a', 0), row('b', 1)]);
  assert.equal(stops.length, 3);
  assert.equal(stops[2], null);
  assert.deepEqual(stops.map(stopId), ['a', 'b', LOOK_ID]);
  assert.deepEqual(focusStops([]), [null]);
});

test('cursorIndex holds the cursor by id when the queue shifts under it', () => {
  const stops = focusStops([row('a', 0), row('b', 1), row('c', 2)]);
  assert.equal(cursorIndex(stops, null), 0);
  assert.equal(cursorIndex(stops, { id: 'c', at: 0 }), 2);
  assert.equal(cursorIndex(stops, { id: LOOK_ID, at: 0 }), 3);
});

test('cursorIndex falls back to the held position, clamped to the queue, when the id is gone', () => {
  const stops = focusStops([row('a', 0), row('c', 2)]);
  assert.equal(cursorIndex(stops, { id: 'b', at: 1 }), 1);
  assert.equal(cursorIndex(stops, { id: 'gone', at: 9 }), 2);
});

test('a stop is labelled by its place, its kind and its title, or as the look stop', () => {
  const ask = row('a', 0);
  assert.equal(stopAriaLabel(ask, 0, 3), `1 of 3 — ${KIND_LABEL.escalation}: ask a`);
  assert.equal(stopAriaLabel(null, 2, 3), `3 of 3 — ${LOOK_TITLE}`);
  assert.equal(stopTitle(ask), `${KIND_LABEL.escalation} — ask a`);
  assert.equal(stopTitle(null), LOOK_TITLE);
});

test('focusRest says what is after the ask, or that the leads are next', () => {
  assert.equal(focusRest(0, 4), 'last ask — what is worth a look is next');
  assert.equal(focusRest(2, 1), '2 after this · 1 part held in total');
  assert.equal(focusRest(3, 0), '3 after this · 0 parts held in total');
});

test('mergedParts counts the parts in the merged group', () => {
  const parts = [{ group: 'merged' }, { group: 'working' }, { group: 'merged' }] as AskGoalPart[];
  assert.equal(mergedParts(parts), 2);
  assert.equal(mergedParts([]), 0);
});

test('runningAgents counts only running agents', () => {
  const agents = [{ status: 'running' }, { status: 'exited' }, { status: 'running' }] as Agent[];
  assert.equal(runningAgents(agents), 2);
});

test('readingsCount pluralises', () => {
  assert.equal(readingsCount(1), '1 reading');
  assert.equal(readingsCount(4), '4 readings');
});
