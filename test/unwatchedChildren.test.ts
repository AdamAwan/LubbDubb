import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { sequenceableFeatures } from '../src/sequence/sequence.js';
import { linkEdges, sequenceHoldReason, sequenceReadiness } from '../src/sequence/readiness.js';
import { UnwatchedChildDesk } from '../src/features/unwatchedDesk.js';
import type { Issue, IssueRelative, WorldSnapshot } from '../src/types.js';

const NOW = '2026-09-18T09:00:00.000Z';

const WATCH = 'lubbdubb:watch';

const FEATURE_NUMBER = 500;

function feature(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i500',
    number: FEATURE_NUMBER,
    title: 'Post-deploy watch windows',
    body: 'Watch what a deploy does.',
    labels: [WATCH],
    state: 'open',
    linkedPrNumber: null,
    issueType: 'Feature',
    parent: null,
    ...over,
  };
}

const PARENT: IssueRelative = {
  number: FEATURE_NUMBER,
  title: 'Post-deploy watch windows',
  issueType: 'Feature',
  workItemState: 'Active',
  state: 'open',
};

function story(number: number, over: Partial<Issue> = {}): Issue {
  return {
    id: `i${number}`,
    number,
    title: `Story ${number}`,
    body: 'do the thing',
    labels: [WATCH],
    state: 'open',
    linkedPrNumber: null,
    issueType: 'User Story',
    parent: PARENT,
    ...over,
  };
}

const unwatched = (number: number, over: Partial<Issue> = {}): Issue => story(number, { labels: [], ...over });

const watched = (issue: Issue): boolean => issue.labels.includes(WATCH);

function sequenceable(issues: Issue[]) {
  return sequenceableFeatures(issues, ['Feature', 'Epic'], watched, 40);
}

function world(issues: Issue[]): WorldSnapshot {
  return { takenAt: NOW, pullRequests: [], issues };
}

function desk(store: Store): UnwatchedChildDesk {
  return new UnwatchedChildDesk({ store, containerTypes: ['Feature', 'Epic'], watched });
}

// The order covers all of it

test('a watched Feature is ordered over every story under it, tagged or not', () => {
  const found = sequenceable([feature(), story(11), unwatched(12)]);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0]!.members, [11, 12], 'the digest counts the story nothing is watching');
  assert.deepEqual(
    found[0]!.children.map((c) => c.number),
    [11, 12],
    'and the sequencer is asked to order it',
  );
  assert.deepEqual(found[0]!.unwatched, [12]);
});

test('an unwatched Feature whose stories are all unwatched is not ordered', () => {
  assert.deepEqual(sequenceable([feature({ labels: [] }), unwatched(11), unwatched(12)]), []);
});

test('a Feature tagged only on a child is still ordered — the operator who never tags the container', () => {
  const found = sequenceable([feature({ labels: [] }), story(11), unwatched(12)]);
  assert.equal(found.length, 1, 'one watched child brings its whole Feature in');
  assert.deepEqual(found[0]!.members, [11, 12]);
});

test('a Feature the world does not hold is read off its children, never as unwatched', () => {
  assert.equal(sequenceable([story(11), unwatched(12)]).length, 1);
  assert.equal(sequenceable([unwatched(11), unwatched(12)]).length, 0);
});

test('a Feature whose second story is unwatched still needs two to be worth asking about', () => {
  assert.deepEqual(sequenceable([feature(), story(11)]), [], 'one story is a question with one arm');
  assert.equal(sequenceable([feature(), story(11), unwatched(12)]).length, 1);
});

test('tagging a story does not re-propose the order — the key digests membership, not watch', () => {
  const before = sequenceable([feature(), story(11), unwatched(12)])[0]!.key;
  const after = sequenceable([feature(), story(11), story(12)])[0]!.key;
  assert.equal(before, after);
});

// The hold

test('a story waiting on an unwatched one is held, and the hold says waiting will not end it', () => {
  const issues = [feature(), story(12, { dependsOn: [{ ...PARENT, number: 11 }] }), unwatched(11)];
  const wait = sequenceReadiness(linkEdges(issues), { issues, watched }).get(12);
  assert.deepEqual(wait, { on: [11], unworkable: [11] });
  const reason = sequenceHoldReason(wait!);
  assert.match(reason, /#11 carries no watch tag/);
  assert.match(reason, /does not end on its own/);
});

test('a watched predecessor holds without the unworkable sentence', () => {
  const issues = [feature(), story(12, { dependsOn: [{ ...PARENT, number: 11 }] }), story(11)];
  const wait = sequenceReadiness(linkEdges(issues), { issues, watched }).get(12)!;
  assert.deepEqual(wait, { on: [11], unworkable: [] });
  assert.doesNotMatch(sequenceHoldReason(wait), /watch tag/);
});

test('a caller that states no watch reading holds exactly as it did before', () => {
  const issues = [feature(), story(12, { dependsOn: [{ ...PARENT, number: 11 }] }), unwatched(11)];
  assert.deepEqual(sequenceReadiness(linkEdges(issues), { issues }).get(12), {
    on: [11],
    unworkable: [],
  });
});

// The row

test('a watched Feature with a story nothing can see files one row, and it names the story', () => {
  const store = new Store(':memory:');
  desk(store).run(world([feature(), story(11), unwatched(12)]));
  const rows = store.humanTasks.listHumanTasksOfKind('unwatched');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.originRef, 'issue:500');
  assert.match(rows[0]!.title, /#500/);
  assert.match(rows[0]!.detail ?? '', /#12/);
  assert.doesNotMatch(rows[0]!.detail ?? '', /#11/, 'the tagged story is not the operator’s problem');
  store.close();
});

test('a Feature the fleet can see all of files nothing', () => {
  const store = new Store(':memory:');
  desk(store).run(world([feature(), story(11), story(12)]));
  assert.deepEqual(store.humanTasks.listHumanTasksOfKind('unwatched'), []);
  store.close();
});

test('the row is one row, and its detail is rewritten as more stories are tagged', () => {
  const store = new Store(':memory:');
  const pass = desk(store);
  pass.run(world([feature(), story(11), unwatched(12), unwatched(13)]));
  pass.run(world([feature(), story(11), story(12), unwatched(13)]));
  const rows = store.humanTasks.listHumanTasksOfKind('unwatched');
  assert.equal(rows.length, 1, 'a count in the title would have filed a second row');
  assert.match(rows[0]!.detail ?? '', /#13/);
  assert.doesNotMatch(rows[0]!.detail ?? '', /#12/);
  store.close();
});

test('tagging the last unseen story settles the row, and the harness says it did', () => {
  const store = new Store(':memory:');
  const pass = desk(store);
  pass.run(world([feature(), story(11), unwatched(12)]));
  pass.run(world([feature(), story(11), story(12)]));
  const row = store.humanTasks.listHumanTasksOfKind('unwatched')[0]!;
  assert.equal(row.status, 'done');
  assert.match(row.resolution ?? '', /^Settled by the harness/);
  store.close();
});

test('un-watching the Feature settles the row rather than leaving an obligation nobody owes', () => {
  const store = new Store(':memory:');
  const pass = desk(store);
  pass.run(world([feature(), story(11), unwatched(12)]));
  pass.run(world([feature({ labels: [] }), unwatched(11), unwatched(12)]));
  const row = store.humanTasks.listHumanTasksOfKind('unwatched')[0]!;
  assert.equal(row.status, 'done');
  assert.match(row.resolution ?? '', /no longer reads this Feature as watched work/);
  store.close();
});

test('a Feature that goes unseen again reopens the harness’s own row', () => {
  const store = new Store(':memory:');
  const pass = desk(store);
  pass.run(world([feature(), story(11), unwatched(12)]));
  pass.run(world([feature(), story(11), story(12)]));
  pass.run(world([feature(), story(11), story(12), unwatched(14)]));
  const rows = store.humanTasks.listHumanTasksOfKind('unwatched');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, 'open');
  assert.match(rows[0]!.detail ?? '', /#14/);
  store.close();
});

test('an operator’s own Done is never reopened by the desk', () => {
  const store = new Store(':memory:');
  const pass = desk(store);
  pass.run(world([feature(), story(11), unwatched(12)]));
  const filed = store.humanTasks.listHumanTasksOfKind('unwatched')[0]!;
  store.humanTasks.settleHumanTask(filed.id, 'done', 'Out of scope for now.');
  pass.run(world([feature(), story(11), unwatched(12)]));
  const rows = store.humanTasks.listHumanTasksOfKind('unwatched');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, 'done', 'the harness retracts and re-files its own row, never yours');
  store.close();
});

test('an empty world settles nothing — a provider down on first boot is not a tracker with no work', () => {
  const store = new Store(':memory:');
  const pass = desk(store);
  pass.run(world([feature(), story(11), unwatched(12)]));
  pass.run(world([]));
  assert.equal(store.humanTasks.listHumanTasksOfKind('unwatched')[0]!.status, 'open');
  store.close();
});

test('the row says which unseen stories are holding other work, and only when an order stands', () => {
  const store = new Store(':memory:');
  const issues = [feature(), story(12, { dependsOn: [{ ...PARENT, number: 11 }] }), unwatched(11)];

  desk(store).run(world(issues));
  assert.doesNotMatch(
    store.humanTasks.listHumanTasksOfKind('unwatched')[0]!.detail ?? '',
    /holding other work/,
    'a board link nobody accepted holds nothing, and the row must not say it does',
  );

  store.sequences.recordFeatureSequence({
    originRef: 'issue:500',
    status: 'proposed',
    reason: 'the table has to exist before anything reads it',
    unsure: null,
    standingKey: 'k',
    members: [11, 12],
    edges: [{ issue: 12, dependsOn: 11, source: 'inferred', reason: null }],
    agentId: null,
    taskId: null,
  });
  store.sequences.answerFeatureSequence('issue:500', 'accepted', 'adam');

  desk(store).run(world(issues));
  const detail = store.humanTasks.listHumanTasksOfKind('unwatched')[0]!.detail ?? '';
  assert.match(detail, /#11 is holding other work/);
  store.close();
});
