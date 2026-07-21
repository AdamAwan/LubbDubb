import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { FakeConnector } from '../src/connector/fakeConnector.js';

function newConnector() {
  const store = new Store(':memory:');
  const connector = new FakeConnector(store, () => '2026-01-01T00:00:00.000Z');
  return { store, connector };
}

test('a fresh connector reports an empty, timestamped world', async () => {
  const { store, connector } = newConnector();
  const world = await connector.getState();
  assert.equal(world.takenAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(world.pullRequests, []);
  assert.deepEqual(world.issues, []);
  assert.deepEqual(world.stories, []);
  assert.deepEqual(world.calendar, []);
  store.close();
});

test('injecting new_pr then ci_failed moves the PR into a failing state', async () => {
  const { store, connector } = newConnector();
  connector.inject({ kind: 'new_pr', number: 42, title: 'Add widget', branch: 'feat/widget' });
  connector.inject({ kind: 'ci_failed', prNumber: 42 });
  const world = await connector.getState();
  assert.equal(world.pullRequests.length, 1);
  assert.equal(world.pullRequests[0]!.ciStatus, 'failing');
  store.close();
});

test('injecting the same new_pr twice does not duplicate it', async () => {
  const { store, connector } = newConnector();
  connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'b' });
  connector.inject({ kind: 'new_pr', number: 42, title: 'X again', branch: 'b' });
  const world = await connector.getState();
  assert.equal(world.pullRequests.length, 1);
  store.close();
});

test('world state persists across a fresh connector over the same store', async () => {
  const store = new Store(':memory:');
  const first = new FakeConnector(store, () => 'now');
  first.inject({ kind: 'new_story', title: 'Login', priority: 5 });

  const second = new FakeConnector(store, () => 'now');
  const world = await second.getState();
  assert.equal(world.stories.length, 1);
  assert.equal(world.stories[0]!.title, 'Login');
  assert.equal(world.stories[0]!.priority, 5);
  store.close();
});

test('postPrReply on a threaded comment marks it handled and returns a ref', async () => {
  const { store, connector } = newConnector();
  connector.inject({ kind: 'new_pr', number: 7, title: 'X', branch: 'b' });
  connector.inject({ kind: 'pr_comment', prNumber: 7, author: 'bob', body: 'why?' });

  const before = (await connector.getState()).pullRequests[0]!.unresolvedComments[0]!;
  assert.equal(before.handled, false);

  const result = await connector.postPrReply({ prNumber: 7, commentId: before.id, body: 'because X' });
  assert.equal(result.ok, true);
  assert.match(result.ref!, /^fake-reply_/);

  const after = (await connector.getState()).pullRequests[0]!.unresolvedComments[0]!;
  assert.equal(after.handled, true);
  store.close();
});

test('markIssueLinked links an issue to its resolving PR', async () => {
  const { store, connector } = newConnector();
  connector.inject({ kind: 'new_issue', number: 12, title: 'Crash on save' });
  const issue = (await connector.getState()).issues[0]!;
  assert.equal(issue.linkedPrNumber, null);

  connector.markIssueLinked(12, 77);
  const after = (await connector.getState()).issues[0]!;
  assert.equal(after.linkedPrNumber, 77);
  store.close();
});

test('mergePr on the fake connector marks the PR merged', async () => {
  const { store, connector } = newConnector();
  connector.inject({ kind: 'new_pr', number: 8, title: 'X', branch: 'b' });
  const result = await connector.mergePr({ prNumber: 8, method: 'squash' });
  assert.equal(result.ok, true);
  assert.match(result.ref!, /^fake-merge_/);
  assert.equal((await connector.getState()).pullRequests[0]!.merged, true);
  store.close();
});

test('markStoryState transitions a story', async () => {
  const { store, connector } = newConnector();
  connector.inject({ kind: 'new_story', title: 'Ship it' });
  const story = (await connector.getState()).stories[0]!;
  assert.equal(story.state, 'ready');

  connector.markStoryState(story.id, 'in_progress');
  const after = (await connector.getState()).stories[0]!;
  assert.equal(after.state, 'in_progress');
  store.close();
});
