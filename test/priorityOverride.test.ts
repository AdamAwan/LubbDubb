import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankByPriorityOverride } from '../src/dispatcher/priorityOverride.js';
import type { DispatchRuleId } from '../src/dispatcher/rules.js';

interface Item {
  origin: string;
  rule: DispatchRuleId;
}

const item = (origin: string, rule: DispatchRuleId): Item => ({ origin, rule });
const origins = (items: Item[]): string[] => items.map((i) => i.origin);

test('no override leaves the natural order untouched', () => {
  const items = [
    item('pr:1:ci', 'pr-ci-failing'),
    item('pr:2:mergeable', 'pr-base-update'),
    item('issue:5', 'issue-pickup'),
  ];
  assert.deepEqual(origins(rankByPriorityOverride(items, new Map())), ['pr:1:ci', 'pr:2:mergeable', 'issue:5']);
});

test('an overridden origin jumps ahead of the natural ranking', () => {
  const items = [
    item('pr:1:ci', 'pr-ci-failing'),
    item('pr:2:mergeable', 'pr-base-update'),
    item('issue:5', 'issue-pickup'),
  ];
  // Operator says "do issue #5 next".
  const ranked = rankByPriorityOverride(items, new Map([['issue:5', 0]]));
  assert.deepEqual(origins(ranked), ['issue:5', 'pr:1:ci', 'pr:2:mergeable']);
});

test('multiple overrides order by rank, non-overridden keep natural order after', () => {
  const items = [
    item('pr:1:ci', 'pr-ci-failing'),
    item('pr:2:mergeable', 'pr-base-update'),
    item('issue:5', 'issue-pickup'),
    item('issue:9', 'issue-pickup'),
  ];
  const ranked = rankByPriorityOverride(
    items,
    new Map([
      ['issue:9', 0],
      ['pr:2:mergeable', 1],
    ]),
  );
  assert.deepEqual(origins(ranked), ['issue:9', 'pr:2:mergeable', 'pr:1:ci', 'issue:5']);
});

test('rule-0 jobs stay first whatever the override', () => {
  const items = [
    item('job:a', 'manual-job'),
    item('job:b', 'manual-job'),
    item('pr:1:ci', 'pr-ci-failing'),
    item('issue:5', 'issue-pickup'),
  ];
  // Even an override that names a world item rank 0 cannot outrank a queued job.
  const ranked = rankByPriorityOverride(items, new Map([['issue:5', 0]]));
  assert.deepEqual(origins(ranked), ['job:a', 'job:b', 'issue:5', 'pr:1:ci']);
});

test('an override on a job origin never demotes the job tier', () => {
  const items = [item('job:a', 'manual-job'), item('pr:1:ci', 'pr-ci-failing')];
  // A stray override on the job's own origin must not push a world item ahead of it.
  const ranked = rankByPriorityOverride(
    items,
    new Map([
      ['pr:1:ci', 0],
      ['job:a', 5],
    ]),
  );
  assert.deepEqual(origins(ranked), ['job:a', 'pr:1:ci']);
});

test('order is stable for equal ranks and preserves job order', () => {
  const items = [item('job:1', 'manual-job'), item('job:2', 'manual-job'), item('job:3', 'manual-job')];
  assert.deepEqual(origins(rankByPriorityOverride(items, new Map())), ['job:1', 'job:2', 'job:3']);
});

test('an override for an origin not present is simply ignored', () => {
  const items = [item('pr:1:ci', 'pr-ci-failing'), item('issue:5', 'issue-pickup')];
  const ranked = rankByPriorityOverride(items, new Map([['issue:999', 0]]));
  assert.deepEqual(origins(ranked), ['pr:1:ci', 'issue:5']);
});
