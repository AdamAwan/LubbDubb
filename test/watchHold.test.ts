import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchHold } from '../src/validation/watchAuthoring.js';
import type { WatchPlanRecord } from '../src/types.js';

const record = (over: Partial<WatchPlanRecord>): WatchPlanRecord => ({
  goalRef: 'issue:7',
  authoredAt: '2026-11-01T00:00:00.000Z',
  note: 'n',
  emptyReason: null,
  acceptedAt: null,
  sentBackWords: null,
  ...over,
});

const hold = (r: WatchPlanRecord | null, hasLiveChecks = false) =>
  watchHold({ record: r, hasLiveChecks, planned: () => true, delivered: () => true });

test('an authored, unaccepted set holds even when the operator has made every check live', () => {
  assert.equal(hold(record({}), true), 'proposed');
});

test('an accepted set, or an authored empty set, holds nothing', () => {
  assert.equal(hold(record({ acceptedAt: '2026-11-02T00:00:00.000Z' })), null);
  assert.equal(hold(record({ emptyReason: 'nothing runs' })), null);
});

test('an owed record holds', () => {
  assert.equal(hold(record({ authoredAt: null, note: null })), 'owed');
});
