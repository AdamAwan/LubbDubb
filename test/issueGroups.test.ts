import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByFeature, groupProgress } from '../web/src/issueGroups.js';
import type { Issue, IssueRelative } from '../web/src/types.js';

/**
 * The World panel's grouping, tested at the same seam the panel calls it — pure
 * over already-filtered rows, so a tab's narrowing is the caller's business and
 * every case here is about arrangement alone.
 */

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: `i${over.number ?? 1}`,
    number: 1,
    title: 'X',
    body: '',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    pickup: { eligible: true, status: 'eligible', reasons: [] },
    conclusion: { verdict: 'undeclared', by: null, note: '', at: null },
    shortfall: null,
    delivery: null,
    assay: null,
    retrospective: null,
    scratchpad: null,
    ...over,
  } as Issue;
}

function feature(over: Partial<IssueRelative> = {}): IssueRelative {
  return { number: 812, title: 'Checkout', issueType: 'Feature', workItemState: 'Active', state: 'open', ...over };
}

const isContainer = (i: Issue): boolean => i.pickup?.status === 'container';

/** The whole GitHub path: no tree reported, so no structure is invented over it. */
test('a tracker with no hierarchy is not grouped at all', () => {
  assert.equal(groupByFeature([issue({ number: 1 }), issue({ number: 2 })], isContainer), null);
});

test('stories are grouped under the feature their parent names', () => {
  const groups = groupByFeature(
    [issue({ number: 845, parent: feature() }), issue({ number: 844, parent: feature() })],
    isContainer,
  );
  assert.equal(groups?.length, 1);
  assert.equal(groups?.[0]?.kind, 'feature');
  assert.equal(groups?.[0]?.feature?.number, 812);
  // Sorted, not in arrival order.
  assert.deepEqual(
    groups?.[0]?.issues.map((i) => i.number),
    [844, 845],
  );
});

/**
 * The ordinary Azure case: a tag or assignee filter leaves the Feature out of the
 * item list, so the heading has to come from a child's own `parent` summary.
 */
test('a feature absent from the world still heads its group', () => {
  const groups = groupByFeature([issue({ number: 845, parent: feature() })], isContainer);
  assert.equal(groups?.[0]?.feature?.title, 'Checkout');
  assert.equal(groups?.[0]?.featureIssue, null);
});

test('a container in the world heads its own group and is never a row in it', () => {
  const container = issue({
    number: 812,
    title: 'Checkout',
    issueType: 'Feature',
    workItemState: 'Active',
    children: [feature({ number: 843 }), feature({ number: 844 }), feature({ number: 845 })],
    pickup: { eligible: false, status: 'container', reasons: ['Feature is a container'] },
  });
  const groups = groupByFeature([container, issue({ number: 845, parent: feature() })], isContainer);
  assert.equal(groups?.length, 1);
  assert.equal(groups?.[0]?.featureIssue?.number, 812);
  assert.deepEqual(
    groups?.[0]?.issues.map((i) => i.number),
    [845],
  );
});

/**
 * `null` is the tracker saying "no parent"; `undefined` is it having no opinion.
 * Conflating them files every GitHub issue under a heading accusing it of a gap.
 */
test('untracked items are separated from genuine orphans', () => {
  const groups = groupByFeature(
    [
      issue({ number: 903, issueType: 'Bug', parent: null }),
      issue({ number: 208 }),
      issue({ number: 845, parent: feature() }),
    ],
    isContainer,
  );
  assert.deepEqual(
    groups?.map((g) => g.kind),
    ['untracked', 'feature', 'orphans'],
  );
  assert.deepEqual(
    groups?.[0]?.issues.map((i) => i.number),
    [208],
  );
  assert.deepEqual(
    groups?.[2]?.issues.map((i) => i.number),
    [903],
  );
});

test('features are ordered by number, with the parentless group last', () => {
  const groups = groupByFeature(
    [
      issue({ number: 901, parent: feature({ number: 820, title: 'Fraud' }) }),
      issue({ number: 903, issueType: 'Bug', parent: null }),
      issue({ number: 845, parent: feature() }),
    ],
    isContainer,
  );
  assert.deepEqual(
    groups?.map((g) => g.feature?.number ?? g.kind),
    [812, 820, 'orphans'],
  );
});

/**
 * A heading reporting one number is wrong in a way an operator cannot see: the
 * rows under it are narrowed by the watch tab, the feature's own children are not.
 */
test('groupProgress reports what is shown and what the feature really holds', () => {
  const container = issue({
    number: 812,
    issueType: 'Feature',
    children: [feature({ number: 843 }), feature({ number: 844 }), feature({ number: 845 })],
    pickup: { eligible: false, status: 'container', reasons: ['Feature is a container'] },
  });
  const groups = groupByFeature([container, issue({ number: 845, parent: feature() })], isContainer);
  assert.deepEqual(groupProgress(groups![0]!), { shown: 1, children: 3 });
});

/** Nothing is known about a feature the world doesn't hold, so nothing is claimed. */
test('groupProgress reports no child count for a feature read off a relation', () => {
  const groups = groupByFeature([issue({ number: 845, parent: feature() })], isContainer);
  assert.deepEqual(groupProgress(groups![0]!), { shown: 1, children: null });
});
