import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { FakeConnector } from '../src/connector/fakeConnector.js';

function connector(): FakeConnector {
  return new FakeConnector(new Store(':memory:'));
}

test('the sink can open a pull request and it appears in the world', async () => {
  const c = connector();
  const result = await c.createPullRequest({
    branch: 'issue/12/schema',
    base: 'main',
    title: '#12 [1/2] feat(store): schema',
    body: 'part of #12',
  });
  assert.equal(result.ok, true);
  assert.ok(result.ref, 'the created PR number comes back for the audit log');

  const world = await c.getState();
  const pr = world.pullRequests.find((p) => p.branch === 'issue/12/schema');
  assert.ok(pr, 'the opened PR is in the world');
  assert.equal(pr.baseBranch, 'main');
  assert.equal(pr.title, '#12 [1/2] feat(store): schema');
  assert.equal(String(pr.number), result.ref);
});

test('an opened pull request can be retitled and retargeted in place', async () => {
  const c = connector();
  const created = await c.createPullRequest({
    branch: 'issue/12/cursor',
    base: 'issue/12/schema',
    title: 'wip',
    body: '',
  });
  const number = Number(created.ref);

  await c.setPullTitle({ prNumber: number, title: '#12 [2/2] feat(store): cursor' });
  await c.setPullBase({ prNumber: number, base: 'main' });

  const world = await c.getState();
  const pr = world.pullRequests.find((p) => p.number === number);
  assert.ok(pr);
  assert.equal(pr.title, '#12 [2/2] feat(store): cursor');
  assert.equal(pr.baseBranch, 'main', 'retargeting is what a merged rung beneath this one causes');
});

test('opened pull requests take distinct numbers', async () => {
  const c = connector();
  const a = await c.createPullRequest({ branch: 'a', base: 'main', title: 'a', body: '' });
  const b = await c.createPullRequest({ branch: 'b', base: 'main', title: 'b', body: '' });
  assert.notEqual(a.ref, b.ref);
});
