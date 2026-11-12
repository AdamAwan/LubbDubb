import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awaitingAccept } from '../web/src/view/goalStages.js';
import type { GoalWatch, WatchPlanRecord } from '../src/types.js';

const proposed = { live: false } as GoalWatch;
const live = { live: true } as GoalWatch;

function record(over: Partial<WatchPlanRecord>): WatchPlanRecord {
  return {
    goalRef: 'issue:7',
    authoredAt: '2026-01-01T00:00:00.000Z',
    note: 'n',
    emptyReason: null,
    acceptedAt: null,
    sentBackWords: null,
    ...over,
  };
}

test('an authored set not yet accepted counts its proposed checks as the operator’s to accept', () => {
  assert.equal(awaitingAccept([proposed, proposed, live], record({})), 2);
});

test('a sent-back set keeps its rows but nothing in it awaits the operator', () => {
  assert.equal(awaitingAccept([proposed, proposed], record({ authoredAt: null, sentBackWords: 'no' })), 0);
});

test('an accepted set, or no record at all, awaits nothing', () => {
  assert.equal(awaitingAccept([proposed], record({ acceptedAt: '2026-01-02T00:00:00.000Z' })), 0);
  assert.equal(awaitingAccept([proposed], null), 0);
});
