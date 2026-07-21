import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { CompositeConnector } from '../src/integrations/compositeConnector.js';
import { buildIntegrations } from '../src/integrations/registry.js';
import { loadConfig } from '../src/config.js';
import type { IntegrationSelection } from '../src/integrations/integration.js';

const FIXED = () => '2026-01-01T00:00:00.000Z';
const FAKES: IntegrationSelection = { sourceControl: 'fake', backlog: 'fake', calendar: 'fake' };

function build(selection: IntegrationSelection = FAKES) {
  const store = new Store(':memory:');
  const integrations = buildIntegrations(selection, { store, config: loadConfig(), now: FIXED });
  const connector = new CompositeConnector(integrations, store, FIXED);
  return { store, connector };
}

test('buildIntegrations resolves the default fake providers into one per capability', () => {
  const store = new Store(':memory:');
  const integrations = buildIntegrations(FAKES, { store, config: loadConfig(), now: FIXED });
  assert.deepEqual(integrations.map((i) => i.capability).sort(), ['backlog', 'calendar', 'sourceControl']);
  store.close();
});

test('buildIntegrations throws a clear error on an unknown provider', () => {
  const store = new Store(':memory:');
  assert.throws(
    () => buildIntegrations({ ...FAKES, sourceControl: 'nope' }, { store, config: loadConfig(), now: FIXED }),
    /Unknown sourceControl provider 'nope'.*Valid providers: fake/s,
  );
  store.close();
});

test('CompositeConnector merges slices from every integration into one world', async () => {
  const { store, connector } = build();
  connector.inject({ kind: 'new_pr', number: 42, title: 'Add widget', branch: 'feat/widget' });
  connector.inject({ kind: 'new_story', title: 'Login', priority: 5 });
  connector.inject({ kind: 'meeting', title: 'Standup', startsAt: '2026-01-02T09:00:00.000Z' });

  const world = await connector.getState();
  assert.equal(world.takenAt, '2026-01-01T00:00:00.000Z');
  assert.equal(world.pullRequests.length, 1);
  assert.equal(world.stories.length, 1);
  assert.equal(world.calendar.length, 1);
  store.close();
});

test('inject routes each event kind to the integration that owns it', async () => {
  const { store, connector } = build();
  connector.inject({ kind: 'new_pr', number: 7, title: 'X', branch: 'b' });
  connector.inject({ kind: 'ci_failed', prNumber: 7 });
  const world = await connector.getState();
  assert.equal(world.pullRequests[0]!.ciStatus, 'failing');
  store.close();
});

test('inject with no owning integration is recorded as unhandled, not thrown', () => {
  // Only the calendar fake is enabled, so a PR event has no owner.
  const store = new Store(':memory:');
  const integrations = buildIntegrations(FAKES, { store, config: loadConfig(), now: FIXED }).filter(
    (i) => i.capability === 'calendar',
  );
  const connector = new CompositeConnector(integrations, store, FIXED);
  assert.doesNotThrow(() => connector.inject({ kind: 'new_pr', number: 1, title: 'X', branch: 'b' }));
  store.close();
});

test('postPrReply routes to the sourceControl provider and settles the comment', async () => {
  const { store, connector } = build();
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

test('postPrReply throws when no PrReplyCapable integration is enabled', async () => {
  const store = new Store(':memory:');
  const integrations = buildIntegrations(FAKES, { store, config: loadConfig(), now: FIXED }).filter(
    (i) => i.capability !== 'sourceControl',
  );
  const connector = new CompositeConnector(integrations, store, FIXED);
  await assert.rejects(
    () => connector.postPrReply({ prNumber: 1, commentId: null, body: 'x' }),
    /no integration can post PR replies/,
  );
  store.close();
});

test('loadConfig deep-merges a single swapped capability over the fake defaults', () => {
  const config = loadConfig({ integrations: { sourceControl: 'github' } as IntegrationSelection });
  assert.equal(config.integrations.sourceControl, 'github');
  assert.equal(config.integrations.backlog, 'fake');
  assert.equal(config.integrations.calendar, 'fake');
});
