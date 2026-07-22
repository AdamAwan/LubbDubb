import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issuePriority, isIssuePickupEligible } from '../src/dispatcher/issuePickup.js';
import type { IssuePickupPolicy } from '../src/dispatcher/issuePickup.js';
import type { Issue } from '../src/types.js';

const SCHEME: IssuePickupPolicy = {
  priorityLabels: { 'priority:high': 3, 'priority:medium': 2, 'priority:low': 1 },
  defaultPriority: 2,
};

function issue(over: Partial<Issue> = {}): Issue {
  return { id: 'i', number: 1, title: 'X', body: '', labels: [], state: 'open', linkedPrNumber: null, ...over };
}

test('issuePriority returns the mapped weight for a matching label', () => {
  assert.equal(issuePriority(['priority:high'], SCHEME), 3);
  assert.equal(issuePriority(['priority:low'], SCHEME), 1);
});

test('issuePriority falls back to the default weight when no label matches', () => {
  assert.equal(issuePriority([], SCHEME), 2);
  assert.equal(issuePriority(['bug', 'wontfix'], SCHEME), 2);
});

test('issuePriority takes the highest weight when several priority labels are present', () => {
  assert.equal(issuePriority(['priority:low', 'priority:high'], SCHEME), 3);
});

test('isIssuePickupEligible: without a pickup label every issue is eligible', () => {
  const policy: IssuePickupPolicy = { priorityLabels: {}, defaultPriority: 0 };
  assert.equal(isIssuePickupEligible(issue({ labels: [] }), policy), true);
  assert.equal(isIssuePickupEligible(issue({ labels: ['bug'] }), policy), true);
});

test('isIssuePickupEligible: with a pickup label only labelled issues are eligible', () => {
  const policy: IssuePickupPolicy = { pickupLabel: 'agent-ready', priorityLabels: {}, defaultPriority: 0 };
  assert.equal(isIssuePickupEligible(issue({ labels: ['agent-ready'] }), policy), true);
  assert.equal(isIssuePickupEligible(issue({ labels: ['bug'] }), policy), false);
  assert.equal(isIssuePickupEligible(issue({ labels: [] }), policy), false);
});

test('isIssuePickupEligible: requireOwnLabel counts only the viewer-added tag', () => {
  const policy: IssuePickupPolicy = {
    pickupLabel: 'agent-ready',
    requireOwnLabel: true,
    priorityLabels: {},
    defaultPriority: 0,
  };
  // The viewer added the tag → eligible.
  assert.equal(
    isIssuePickupEligible(issue({ labels: ['agent-ready'], labelsAddedByViewer: ['agent-ready'] }), policy),
    true,
  );
  // The tag is present but someone else added it → not eligible (the abuse case).
  assert.equal(isIssuePickupEligible(issue({ labels: ['agent-ready'], labelsAddedByViewer: [] }), policy), false);
  // Authorship unknown (provider didn't populate it) → not eligible, fail closed.
  assert.equal(isIssuePickupEligible(issue({ labels: ['agent-ready'] }), policy), false);
});

test('isIssuePickupEligible: requireOwnLabel is ignored when no pickup label is set', () => {
  const policy: IssuePickupPolicy = { requireOwnLabel: true, priorityLabels: {}, defaultPriority: 0 };
  assert.equal(isIssuePickupEligible(issue({ labels: ['bug'] }), policy), true);
});
