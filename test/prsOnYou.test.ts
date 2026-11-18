import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFixtureState } from './support/cockpitFixtures.js';
import { prsOnYou, PR_REASON_LABEL } from '../web/src/view/prsOnYou.js';
import type { OpenPullRequest } from '../web/src/types.js';

const base = buildFixtureState().world.pullRequests[0]!;

function pr(number: number, over: Partial<OpenPullRequest> = {}): OpenPullRequest {
  const quiet: OpenPullRequest = {
    ...base,
    number,
    unresolvedComments: [],
    attention: { status: 'harness', reasons: [] },
    body: 'Does a thing.',
  };
  delete quiet.assignAsk;
  return { ...quiet, ...over };
}

test('a pull request no reason holds for is not on the page', () => {
  assert.deepEqual(prsOnYou([pr(1)]), []);
});

test('each reason is read off the field the spec names', () => {
  const read = (p: OpenPullRequest) => prsOnYou([p])[0]?.reasons ?? [];
  assert.deepEqual(read(pr(1, { attention: { status: 'you', reasons: [], assignedToYou: 'assignee' } })), ['review']);
  assert.deepEqual(read(pr(2, { attention: { status: 'you', reasons: [] } })), ['call']);
  assert.deepEqual(
    read(pr(3, { unresolvedComments: [{ id: 'c', author: 'r', body: 'why?', handled: true }] })),
    ['comments'],
    'comments count even while the fleet answers them',
  );
  assert.deepEqual(read(pr(4, { assignAsk: [{ id: 'p', name: 'Pat' }] })), ['assign']);
  assert.deepEqual(read(pr(5, { assignAsk: [] })), [], 'an empty assign ask is no reason');
  assert.deepEqual(read(pr(6, { body: '  \n ' })), ['describe']);
  const unread = pr(7);
  delete unread.body;
  assert.deepEqual(read(unread), [], 'a body never read is not an empty one');
});

test('every reason that holds is a tag, in the table order', () => {
  const row = prsOnYou([
    pr(9, {
      body: '',
      unresolvedComments: [{ id: 'c', author: 'r', body: 'x', handled: false }],
      attention: { status: 'you', reasons: [], assignedToYou: 'reviewer-required' },
    }),
  ])[0]!;
  assert.deepEqual(row.reasons, ['review', 'comments', 'describe']);
  assert.deepEqual(
    row.reasons.map((r) => PR_REASON_LABEL[r]),
    ['Your review', 'Comments', 'No description'],
  );
});

test('sorted by the first reason, then newest first', () => {
  const order = prsOnYou([
    pr(10, { body: '' }),
    pr(11, { attention: { status: 'you', reasons: [] } }),
    pr(12, { body: '' }),
    pr(13, { attention: { status: 'you', reasons: [], assignedToYou: 'assignee' } }),
    pr(14, { attention: { status: 'you', reasons: [] } }),
  ]).map((row) => row.pr.number);
  assert.deepEqual(order, [13, 14, 11, 12, 10]);
});
